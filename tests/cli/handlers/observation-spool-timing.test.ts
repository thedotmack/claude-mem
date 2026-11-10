import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { createServer, type Server, type Socket } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { LIVE_OBSERVER_HANDOFF_TIMEOUT_MS } from '../../../src/cli/live-observer-event.js';

// Hook wall-time contract: PostToolUse hands off once and exits. With the
// worker down (refused) or wedged (accepts, never answers), the handler must
// still return well inside a tool-call's latency budget.
//
// Each measurement runs in its own `bun` process, like a real hook. In a full
// `bun test tests` run, other files' module mocks, `?fresh` worker-utils
// imports and the process-wide settings memos (hook-settings, worker-utils port
// cache) leaked into this file: the handler skipped capture, or every handoff
// went to the default port 37777 (a live worker on a dev machine) instead of
// the black hole below. A child process has none of that state.
const HOOK_WALL_TIME_BUDGET_MS = 200;
// Handler plus the bounded live handoff, with scheduler headroom on shared CI.
const HOOK_EXIT_WORST_CASE_BUDGET_MS = LIVE_OBSERVER_HANDOFF_TIMEOUT_MS + 500;

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const moduleUrl = (relativePath: string) => pathToFileURL(join(REPO_ROOT, relativePath)).href;

const tempDataDirs: string[] = [];
let blackHole: { server: Server; sockets: Socket[] } | null = null;

async function listen(server: Server): Promise<number> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port bound');
  return address.port;
}

async function closedPort(): Promise<number> {
  const server = createServer();
  const port = await listen(server);
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

async function blackHolePort(): Promise<number> {
  const sockets: Socket[] = [];
  const server = createServer(socket => { sockets.push(socket); });
  blackHole = { server, sockets };
  return listen(server);
}

interface HookTiming {
  /** observationHandler.execute alone. */
  handlerMs: number;
  /** Handler plus settleHookSpoolNudges(), i.e. what hookCommand waits for before exit. */
  throughNudgeSettleMs: number;
  spooledToolUseIds: string[];
}

/** Run the observation hook once in a fresh process pointed at `workerPort`. */
async function timeObservationHookInChild(workerPort: number): Promise<HookTiming> {
  const dataDir = mkdtempSync(join(tmpdir(), 'claude-mem-hook-spool-timing-'));
  tempDataDirs.push(dataDir);
  const source = `
    const { observationHandler } = await import(${JSON.stringify(moduleUrl('src/cli/handlers/observation.ts'))});
    const { settleHookSpoolNudges } = await import(${JSON.stringify(moduleUrl('src/cli/spool-hook-event.ts'))});
    const { HookSpool } = await import(${JSON.stringify(moduleUrl('src/shared/hook-spool.ts'))});
    const startedAt = performance.now();
    const result = await observationHandler.execute({
      sessionId: 'timing-session',
      cwd: ${JSON.stringify(dataDir)},
      platform: 'claude-code',
      toolName: 'Bash',
      toolInput: { command: 'ls' },
      toolResponse: { stdout: '' },
      toolUseId: 'toolu_timing_1',
    });
    const handlerMs = performance.now() - startedAt;
    await settleHookSpoolNudges();
    const throughNudgeSettleMs = performance.now() - startedAt;
    if (result.continue !== true) throw new Error('handler did not continue: ' + JSON.stringify(result));
    const spooledToolUseIds = new HookSpool().entries()
      .filter(entry => entry.kind === 'observation')
      .map(entry => entry.payload.toolUseId);
    console.log(JSON.stringify({ handlerMs, throughNudgeSettleMs, spooledToolUseIds }));
  `;
  const child = Bun.spawn([process.execPath, '-e', source], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      CLAUDE_MEM_DATA_DIR: dataDir,
      CLAUDE_MEM_WORKER_PORT: String(workerPort),
      CLAUDE_MEM_WORKER_HOST: '127.0.0.1',
      CLAUDE_MEM_TELEMETRY: '0',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`timing child exited ${exitCode}: ${stderr}`);
  const resultLine = stdout.trim().split('\n').pop() ?? '';
  return JSON.parse(resultLine) as HookTiming;
}

afterEach(async () => {
  if (blackHole) {
    blackHole.sockets.forEach(socket => socket.destroy());
    await new Promise<void>(resolve => blackHole!.server.close(() => resolve()));
    blackHole = null;
  }
  for (const dataDir of tempDataDirs.splice(0)) rmSync(dataDir, { recursive: true, force: true });
});

describe('observation hook wall time with the worker unavailable', () => {
  it(`returns in < ${HOOK_WALL_TIME_BUDGET_MS}ms when the worker port refuses connections, and the event is skipped`, async () => {
    const timing = await timeObservationHookInChild(await closedPort());

    expect(timing.handlerMs).toBeLessThan(HOOK_WALL_TIME_BUDGET_MS);
    expect(timing.spooledToolUseIds).toEqual([]);
    expect(timing.throughNudgeSettleMs).toBeLessThan(HOOK_WALL_TIME_BUDGET_MS);
  });

  it(`returns in < ${HOOK_WALL_TIME_BUDGET_MS}ms when the worker accepts but never answers (wedged)`, async () => {
    const timing = await timeObservationHookInChild(await blackHolePort());

    expect(timing.handlerMs).toBeLessThan(HOOK_WALL_TIME_BUDGET_MS);
    expect(timing.spooledToolUseIds).toEqual([]);
    // Proves the handoff reached the wedged worker and waited out its timeout.
    expect(timing.throughNudgeSettleMs).toBeGreaterThanOrEqual(LIVE_OBSERVER_HANDOFF_TIMEOUT_MS - 50);
    expect(timing.throughNudgeSettleMs).toBeLessThan(HOOK_EXIT_WORST_CASE_BUDGET_MS);
  });
});
