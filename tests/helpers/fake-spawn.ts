// child_process.spawn, replaceable per test. The module mock stays registered for the whole
// bun process (one process runs every test file), so it hands every call to the real spawn
// unless a test installed a fake; reset it in afterEach.
import { mock } from 'bun:test';
import * as realChildProcess from 'child_process';

const real = { ...realChildProcess };
let fake: typeof real.spawn | null = null;

const registerMock = () => mock.module('child_process', () => ({ ...real, spawn: ((...args: Parameters<typeof real.spawn>) => (fake ?? real.spawn)(...args)) as typeof real.spawn }));
registerMock();

// This module is evaluated once per process, but a later test file can mock child_process itself
// (the chroma-mcp-manager tests do), replacing this mock. Re-register whenever a fake is installed.
export function setFakeSpawn(next: typeof real.spawn | null): void {
  fake = next;
  if (next) registerMock();
}
