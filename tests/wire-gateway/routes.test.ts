import { afterAll, describe, expect, it } from 'bun:test';
import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import { WIRE_GATEWAY_DIR } from '../../src/shared/paths.js';
import {
  WireGatewayRoutesStore,
  addWireGatewayRoute,
  readWireGatewayRoutesFile,
  removeWireGatewayRoute,
} from '../../src/services/wire-gateway/routes.js';

const routesModulePath = join(import.meta.dir, '../../src/services/wire-gateway/routes.ts');

describe('routes.json edits across processes', () => {
  const routesFile = join(WIRE_GATEWAY_DIR, 'routes-concurrency-test.json');
  afterAll(() => rmSync(routesFile, { force: true }));

  it('concurrent `routes add` from separate processes keeps every route', async () => {
    rmSync(routesFile, { force: true });
    const processCount = 6;
    const routesPerProcess = 8;
    const children = Array.from({ length: processCount }, (_, processIndex) => Bun.spawn([process.execPath, '-e', `
      const { addWireGatewayRoute } = await import(${JSON.stringify(routesModulePath)});
      for (let routeIndex = 0; routeIndex < ${routesPerProcess}; routeIndex++) {
        addWireGatewayRoute({ routeId: 'p${processIndex}-' + routeIndex, agentId: 'a', upstreamBaseUrl: 'https://x.example' }, ${JSON.stringify(routesFile)});
      }
    `], { stdout: 'ignore', stderr: 'pipe' }));
    const exitCodes = await Promise.all(children.map(child => child.exited));
    for (const child of children) {
      expect(await new Response(child.stderr).text()).toBe('');
    }
    expect(exitCodes).toEqual(Array(processCount).fill(0));
    expect(Object.keys(readWireGatewayRoutesFile(routesFile).routes)).toHaveLength(processCount * routesPerProcess);
    expect(existsSync(`${routesFile}.lock`)).toBe(false);
  });
});

describe('route ids that are Object.prototype names', () => {
  const routesFile = join(WIRE_GATEWAY_DIR, 'routes-prototype-test.json');
  afterAll(() => rmSync(routesFile, { force: true }));

  it('lookup and remove see own routes only', () => {
    rmSync(routesFile, { force: true });
    addWireGatewayRoute({ routeId: 'real', agentId: 'a', upstreamBaseUrl: 'https://x.example' }, routesFile);
    const store = new WireGatewayRoutesStore({ routesFilePath: routesFile, reloadCheckIntervalMs: 0 });
    for (const inheritedName of ['constructor', 'tostring', 'valueOf', '__proto__', 'hasOwnProperty']) {
      expect(store.lookup(inheritedName)).toEqual({ kind: 'not_found' });
    }
    expect(removeWireGatewayRoute('constructor', routesFile)).toBe(false);

    addWireGatewayRoute({ routeId: 'constructor', agentId: 'ctor-agent', upstreamBaseUrl: 'https://ctor.example' }, routesFile);
    expect(store.lookup('constructor')).toMatchObject({ kind: 'found', route: { agentId: 'ctor-agent' } });
    expect(removeWireGatewayRoute('constructor', routesFile)).toBe(true);
    expect(Object.keys(readWireGatewayRoutesFile(routesFile).routes)).toEqual(['real']);
  });
});
