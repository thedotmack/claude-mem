import { afterEach, describe, expect, it } from 'bun:test';
import { BUILT_IN_AGENT_DESCRIPTORS } from '../../src/services/wire-gateway/agents/builtin-agents.js';
import type { AgentDescriptor } from '../../src/services/wire-gateway/agents/types.js';
import { addWireGatewayRoute, readWireGatewayRoutesFile, type WireGatewayCaptureSource } from '../../src/services/wire-gateway/routes.js';
import { prepareAgentLaunch, type LaunchDependencies } from '../../src/services/wire-gateway/wiring/launcher.js';
import { TEST_GATEWAY_ORIGIN, WiringSandbox } from './helpers/wiring-sandbox.js';

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

/** `sh` stands in for the agent's command, so no real agent binary is needed. */
function launchDependencies(box: WiringSandbox, env: Record<string, string> = {}): LaunchDependencies {
  return {
    environment: { ...box.environment, env: { PATH: '/usr/bin:/bin', ...env } },
    cwd: box.home,
    gatewayOrigin: TEST_GATEWAY_ORIGIN,
    routesFilePath: box.routesFilePath,
    ensureGatewayRunning: async () => {},
    createLaunch: async () => 'abcdefghijklmnopqrstuvwxyz',
    spawnAgent: async () => 0,
  };
}

async function launch(box: WiringSandbox, agentId: string, env: Record<string, string>, captureSource: WireGatewayCaptureSource = 'wire') {
  return prepareAgentLaunch(descriptor(agentId), ['sh'], launchDependencies(box, env), captureSource);
}

describe('wire run: one route per distinct upstream', () => {
  it('a launch to a second provider never replaces the route an earlier launch still uses', async () => {
    const box = sandbox('launch-routes');
    const first = await launch(box, 'antigravity-cli', { GOOGLE_GEMINI_BASE_URL: 'https://one.example' });
    const second = await launch(box, 'antigravity-cli', { GOOGLE_GEMINI_BASE_URL: 'https://two.example' });
    const third = await launch(box, 'antigravity-cli', { GOOGLE_GEMINI_BASE_URL: 'https://three.example' });
    expect(new Set([first.routeId, second.routeId, third.routeId]).size).toBe(3);
    const routes = readWireGatewayRoutesFile(box.routesFilePath).routes;
    expect(routes[first.routeId].upstreamBaseUrl).toBe('https://one.example');
    expect(routes[second.routeId].upstreamBaseUrl).toBe('https://two.example');
    expect(routes[third.routeId].upstreamBaseUrl).toBe('https://three.example');
    // The same upstream again reuses its own route.
    const secondAgain = await launch(box, 'antigravity-cli', { GOOGLE_GEMINI_BASE_URL: 'https://two.example/v1beta' });
    expect(secondAgain.routeId).toBe(second.routeId);
    expect(secondAgain.launchBaseUrl).toBe(`${TEST_GATEWAY_ORIGIN}/r/${second.routeId}/l/abcdefghijklmnopqrstuvwxyz/v1beta`);
  });

  it('refuses a route id that already carries another upstream instead of replacing it', async () => {
    const box = sandbox('launch-route-taken');
    const first = await launch(box, 'antigravity-cli', { GOOGLE_GEMINI_BASE_URL: 'https://one.example' });
    const second = await launch(box, 'antigravity-cli', { GOOGLE_GEMINI_BASE_URL: 'https://two.example' });
    // Someone repointed the second launch's route by hand: a new launch must not silently take it back.
    addWireGatewayRoute({ routeId: second.routeId, agentId: 'antigravity-cli', upstreamBaseUrl: 'https://elsewhere.example' }, box.routesFilePath);
    await expect(launch(box, 'antigravity-cli', { GOOGLE_GEMINI_BASE_URL: 'https://two.example' })).rejects.toThrow(/already relays to https:\/\/elsewhere\.example/);
    expect(readWireGatewayRoutesFile(box.routesFilePath).routes[first.routeId].upstreamBaseUrl).toBe('https://one.example');
  });
});

describe('wire run: reusing a route updates its capture source', () => {
  it('a launch after native hooks were installed (or removed) moves the route to that capture source, keeping its features', async () => {
    const box = sandbox('launch-capture');
    const wired = await launch(box, 'antigravity-cli', { GOOGLE_GEMINI_BASE_URL: 'https://one.example' }, 'wire');
    addWireGatewayRoute({ routeId: wired.routeId, agentId: 'antigravity-cli', upstreamBaseUrl: 'https://one.example', captureSource: 'wire', features: { memoryInjection: true } }, box.routesFilePath);

    const native = await launch(box, 'antigravity-cli', { GOOGLE_GEMINI_BASE_URL: 'https://one.example' }, 'native');
    expect(native.routeId).toBe(wired.routeId);
    let route = readWireGatewayRoutesFile(box.routesFilePath).routes[wired.routeId];
    expect(route.captureSource).toBe('native');
    expect(route.features).toEqual({ memoryInjection: true });

    await launch(box, 'antigravity-cli', { GOOGLE_GEMINI_BASE_URL: 'https://one.example' }, 'wire');
    route = readWireGatewayRoutesFile(box.routesFilePath).routes[wired.routeId];
    expect(route.captureSource).toBe('wire');
    expect(route.features).toEqual({ memoryInjection: true });
  });
});

describe('wire run: the upstream includes the agent\'s saved config', () => {
  it('uses GOOGLE_GEMINI_BASE_URL from ~/.gemini/.env before the vendor default', async () => {
    const box = sandbox('launch-saved-config');
    box.write('.gemini/.env', 'GOOGLE_GEMINI_BASE_URL=https://saved.example/v1beta\n');
    const prepared = await launch(box, 'gemini-cli', {});
    expect(readWireGatewayRoutesFile(box.routesFilePath).routes[prepared.routeId].upstreamBaseUrl).toBe('https://saved.example');
    expect(prepared.launchBaseUrl.endsWith('/v1beta')).toBe(true);
  });

  it('the process environment still wins over the saved config', async () => {
    const box = sandbox('launch-env-wins');
    box.write('.gemini/.env', 'GOOGLE_GEMINI_BASE_URL=https://saved.example\n');
    const prepared = await launch(box, 'gemini-cli', { GOOGLE_GEMINI_BASE_URL: 'https://from-env.example' });
    expect(readWireGatewayRoutesFile(box.routesFilePath).routes[prepared.routeId].upstreamBaseUrl).toBe('https://from-env.example');
  });

  it('a saved config already wired to this gateway launches through that route\'s upstream', async () => {
    const box = sandbox('launch-saved-gateway');
    addWireGatewayRoute({ routeId: 'gemini-cli', agentId: 'gemini-cli', upstreamBaseUrl: 'https://saved.example' }, box.routesFilePath);
    box.write('.gemini/.env', `GOOGLE_GEMINI_BASE_URL=${TEST_GATEWAY_ORIGIN}/r/gemini-cli/v1beta\n`);
    const prepared = await launch(box, 'gemini-cli', {});
    expect(prepared.routeId).toBe('gemini-cli');
    expect(prepared.launchBaseUrl).toBe(`${TEST_GATEWAY_ORIGIN}/r/gemini-cli/l/abcdefghijklmnopqrstuvwxyz/v1beta`);
    expect(Object.keys(readWireGatewayRoutesFile(box.routesFilePath).routes)).toEqual(['gemini-cli']);
  });

  it('a launch from inside a launched agent (env already a launch URL) relays to the same upstream and path', async () => {
    const box = sandbox('launch-nested');
    const outer = await launch(box, 'antigravity-cli', { GOOGLE_GEMINI_BASE_URL: 'https://one.example/v1beta' });
    const inner = await launch(box, 'antigravity-cli', { GOOGLE_GEMINI_BASE_URL: outer.launchBaseUrl });
    expect(inner.routeId).toBe(outer.routeId);
    expect(inner.launchBaseUrl).toBe(outer.launchBaseUrl);
  });
});
