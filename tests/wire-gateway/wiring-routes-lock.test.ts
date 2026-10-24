import { afterEach, describe, expect, it } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, renameSync, symlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { BUILT_IN_AGENT_DESCRIPTORS } from '../../src/services/wire-gateway/agents/builtin-agents.js';
import type { AgentDescriptor } from '../../src/services/wire-gateway/agents/types.js';
import {
  addWireGatewayRoute,
  addWireGatewayRouteWhileRoutesFileIsLocked,
  readWireGatewayRoutesFile,
  removeWireGatewayRoute,
  withWireGatewayRoutesFileLock,
} from '../../src/services/wire-gateway/routes.js';
import { appliedRecordsPath } from '../../src/services/wire-gateway/wiring/wiring-records.js';
import { applyConnectionPlan, connectAgent, disconnectAgent, planAgentConnection } from '../../src/services/wire-gateway/wiring/wiring-engine.js';
import { WiringSandbox } from './helpers/wiring-sandbox.js';

const routesModulePath = join(import.meta.dir, '../../src/services/wire-gateway/routes.ts');
const CONCURRENT_ROUTE_COUNT = 80;
const CONCURRENT_TEST_TIMEOUT_MS = 30_000;

const sandboxes: WiringSandbox[] = [];
afterEach(() => {
  while (sandboxes.length) sandboxes.pop()!.remove();
});

function sandbox(label: string): WiringSandbox {
  const created = new WiringSandbox(label);
  sandboxes.push(created);
  return created;
}

function descriptor(id: string): AgentDescriptor {
  return BUILT_IN_AGENT_DESCRIPTORS.find((candidate) => candidate.id === id)!;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Another claude-mem process running `wire routes add` over and over; it
 * writes `doneMarker` when it has added every route.
 */
function spawnConcurrentRoutesAdder(routesFilePath: string, startedMarker: string, doneMarker: string) {
  return Bun.spawn([process.execPath, '-e', `
    const { writeFileSync } = await import('fs');
    const { addWireGatewayRoute } = await import(${JSON.stringify(routesModulePath)});
    writeFileSync(${JSON.stringify(startedMarker)}, '');
    for (let index = 0; index < ${CONCURRENT_ROUTE_COUNT}; index++) {
      addWireGatewayRoute({ routeId: 'other-' + index, agentId: 'other', upstreamBaseUrl: 'https://other.example' }, ${JSON.stringify(routesFilePath)});
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
    }
    writeFileSync(${JSON.stringify(doneMarker)}, '');
  `], { stdout: 'ignore', stderr: 'pipe' });
}

/** A large config keeps each connect or disconnect busy long enough to overlap the other process. */
function paddedAiderConfig(): string {
  return `openai-api-base: https://api.openai.com/v1\n${Array.from({ length: 40_000 }, (_, index) => `# padding ${index}`).join('\n')}\n`;
}

function waitForFile(path: string): void {
  const deadline = Date.now() + 20_000;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`);
    sleepSync(5);
  }
}

describe('connect and disconnect hold the routes.json lock across snapshot, edits and rollback', () => {
  it('a failed connect rolling back never erases a route another process added meanwhile', async () => {
    const box = sandbox('routes-lock-connect');
    box.write('.aider.conf.yml', paddedAiderConfig());
    const plan = planAgentConnection(descriptor('aider'), box.options());
    // An unreadable applied.json makes every apply fail after its routes were written, so it rolls back.
    mkdirSync(box.wiringDirectory, { recursive: true });
    writeFileSync(appliedRecordsPath(box.wiringDirectory), 'not json');

    const startedMarker = join(box.root, 'adder-started');
    const doneMarker = join(box.root, 'adder-done');
    const adder = spawnConcurrentRoutesAdder(box.routesFilePath, startedMarker, doneMarker);
    waitForFile(startedMarker);
    let failedApplies = 0;
    while (!existsSync(doneMarker)) {
      expect(() => applyConnectionPlan(plan, box.options())).toThrow('cannot be read');
      failedApplies++;
      sleepSync(3); // Let the other process in: the lock is not fair.
    }
    expect(await adder.exited).toBe(0);
    expect(await new Response(adder.stderr).text()).toBe('');
    expect(failedApplies).toBeGreaterThan(0);
    const routes = readWireGatewayRoutesFile(box.routesFilePath).routes;
    expect(Object.keys(routes).filter((routeId) => routeId.startsWith('other-'))).toHaveLength(CONCURRENT_ROUTE_COUNT);
    expect(Object.hasOwn(routes, 'aider')).toBe(false);
    expect(existsSync(`${box.routesFilePath}.lock`)).toBe(false);
  }, CONCURRENT_TEST_TIMEOUT_MS);

  // Root ignores the read-only folder below.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('a failed disconnect rolling back never erases a route another process added meanwhile', async () => {
    const box = sandbox('routes-lock-disconnect');
    box.write('.aider.conf.yml', paddedAiderConfig());
    await connectAgent(descriptor('aider'), box.options());
    // applied.json links into a read-only folder: it still reads, but writing it fails, so every
    // disconnect fails after its routes were removed and rolls back.
    const readOnlyDirectory = join(box.root, 'read-only');
    mkdirSync(readOnlyDirectory);
    renameSync(appliedRecordsPath(box.wiringDirectory), join(readOnlyDirectory, 'applied.json'));
    symlinkSync(join(readOnlyDirectory, 'applied.json'), appliedRecordsPath(box.wiringDirectory));
    chmodSync(readOnlyDirectory, 0o555);
    const startedMarker = join(box.root, 'adder-started');
    const doneMarker = join(box.root, 'adder-done');
    const adder = spawnConcurrentRoutesAdder(box.routesFilePath, startedMarker, doneMarker);
    let failedDisconnects = 0;
    try {
      waitForFile(startedMarker);
      while (!existsSync(doneMarker)) {
        await expect(disconnectAgent('aider', box.options())).rejects.toThrow('applied.json');
        failedDisconnects++;
        await Bun.sleep(3); // Let the other process in: the lock is not fair.
      }
    } finally {
      chmodSync(readOnlyDirectory, 0o755);
    }
    expect(await adder.exited).toBe(0);
    expect(failedDisconnects).toBeGreaterThan(0);
    const routes = readWireGatewayRoutesFile(box.routesFilePath).routes;
    expect(Object.keys(routes).filter((routeId) => routeId.startsWith('other-'))).toHaveLength(CONCURRENT_ROUTE_COUNT);
    expect(Object.hasOwn(routes, 'aider')).toBe(true);
  }, CONCURRENT_TEST_TIMEOUT_MS);

  it('a route id taken by another agent after planning is refused at apply, not overwritten', () => {
    const box = sandbox('routes-lock-taken');
    box.write('.aider.conf.yml', 'openai-api-base: https://api.openai.com/v1\n');
    const plan = planAgentConnection(descriptor('aider'), box.options());
    addWireGatewayRoute({ routeId: 'aider', agentId: 'someone-else', upstreamBaseUrl: 'https://else.example' }, box.routesFilePath);
    expect(() => applyConnectionPlan(plan, box.options())).toThrow(/already belongs to agent someone-else/);
    expect(readWireGatewayRoutesFile(box.routesFilePath).routes.aider.agentId).toBe('someone-else');
    expect(box.read('.aider.conf.yml')).toBe('openai-api-base: https://api.openai.com/v1\n');
  });
});

describe('the routes lock is not re-entered', () => {
  it('the locking helpers refuse inside the lock instead of waiting on themselves; the unlocked ones refuse outside it', () => {
    const box = sandbox('routes-lock-reentry');
    withWireGatewayRoutesFileLock(box.routesFilePath, () => {
      expect(() => addWireGatewayRoute({ routeId: 'x', agentId: 'a', upstreamBaseUrl: 'https://x.example' }, box.routesFilePath)).toThrow('already locked by this process');
      expect(() => removeWireGatewayRoute('x', box.routesFilePath)).toThrow('already locked by this process');
      addWireGatewayRouteWhileRoutesFileIsLocked({ routeId: 'x', agentId: 'a', upstreamBaseUrl: 'https://x.example' }, box.routesFilePath);
    });
    expect(() => addWireGatewayRouteWhileRoutesFileIsLocked({ routeId: 'y', agentId: 'a', upstreamBaseUrl: 'https://y.example' }, box.routesFilePath)).toThrow('must be locked');
    expect(Object.keys(readWireGatewayRoutesFile(box.routesFilePath).routes)).toEqual(['x']);
    expect(existsSync(`${box.routesFilePath}.lock`)).toBe(false);
  });
});
