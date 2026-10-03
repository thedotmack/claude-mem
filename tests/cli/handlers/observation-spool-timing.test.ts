import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { createServer, type Server, type Socket } from 'net';
import { clearPortCache } from '../../../src/shared/worker-utils.js';
import { observationHandler } from '../../../src/cli/handlers/observation.js';
import { settleHookSpoolNudges, SPOOL_NUDGE_TIMEOUT_MS } from '../../../src/cli/spool-hook-event.js';
import { logger } from '../../../src/utils/logger.js';
import { spooledEntries, useTempHookSpoolDataDir } from '../../helpers/temp-hook-spool.js';

// Phase 5 hook wall-time contract: PostToolUse spools and exits. With the
// worker down (refused) or wedged (accepts, never answers), the handler must
// still return well inside a tool-call's latency budget.
const HOOK_WALL_TIME_BUDGET_MS = 200;
// Whole hook up to process.exit: handler + hookCommand settling the nudge
// (capped at SPOOL_NUDGE_TIMEOUT_MS). Must stay well under 500 ms.
const HOOK_EXIT_WORST_CASE_BUDGET_MS = 400;

let tempSpool: ReturnType<typeof useTempHookSpoolDataDir>;
let savedEnv: Record<string, string | undefined>;
let loggerSpies: Array<ReturnType<typeof spyOn>> = [];
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

function pointWorkerAt(port: number): void {
  process.env.CLAUDE_MEM_WORKER_PORT = String(port);
  process.env.CLAUDE_MEM_WORKER_HOST = '127.0.0.1';
  clearPortCache();
}

async function timeObservationHookThroughNudgeSettle(): Promise<number> {
  const startedAt = performance.now();
  await timeObservationHook();
  await settleHookSpoolNudges();
  return performance.now() - startedAt;
}

async function timeObservationHook(): Promise<number> {
  const startedAt = performance.now();
  const result = await observationHandler.execute({
    sessionId: 'timing-session',
    cwd: '/tmp/timing-project',
    platform: 'claude-code',
    toolName: 'Bash',
    toolInput: { command: 'ls' },
    toolResponse: { stdout: '' },
    toolUseId: 'toolu_timing_1',
  });
  const elapsedMs = performance.now() - startedAt;
  expect(result.continue).toBe(true);
  return elapsedMs;
}

beforeEach(() => {
  savedEnv = {
    CLAUDE_MEM_WORKER_PORT: process.env.CLAUDE_MEM_WORKER_PORT,
    CLAUDE_MEM_WORKER_HOST: process.env.CLAUDE_MEM_WORKER_HOST,
  };
  tempSpool = useTempHookSpoolDataDir();
  loggerSpies = (['debug', 'info', 'warn', 'error', 'dataIn'] as const)
    .map(level => spyOn(logger, level).mockImplementation(() => {}));
});

afterEach(async () => {
  loggerSpies.forEach(spy => spy.mockRestore());
  if (blackHole) {
    blackHole.sockets.forEach(socket => socket.destroy());
    await new Promise<void>(resolve => blackHole!.server.close(() => resolve()));
    blackHole = null;
  }
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  clearPortCache();
  tempSpool.restore();
});

describe('observation hook wall time with the worker unavailable', () => {
  it(`returns in < ${HOOK_WALL_TIME_BUDGET_MS}ms when the worker port refuses connections, and the event is spooled`, async () => {
    pointWorkerAt(await closedPort());

    const elapsedMs = await timeObservationHook();

    expect(elapsedMs).toBeLessThan(HOOK_WALL_TIME_BUDGET_MS);
    expect(spooledEntries('observation').map(entry => (entry.payload as { toolUseId?: string }).toolUseId))
      .toEqual(['toolu_timing_1']);
  });

  it(`returns in < ${HOOK_WALL_TIME_BUDGET_MS}ms when the worker accepts but never answers (wedged)`, async () => {
    const sockets: Socket[] = [];
    const server = createServer(socket => { sockets.push(socket); });
    blackHole = { server, sockets };
    pointWorkerAt(await listen(server));

    const elapsedMs = await timeObservationHook();

    expect(elapsedMs).toBeLessThan(HOOK_WALL_TIME_BUDGET_MS);
    expect(spooledEntries('observation')).toHaveLength(1);
  });

  it(`settles the nudge before exit in < ${HOOK_WALL_TIME_BUDGET_MS}ms when refused and < ${HOOK_EXIT_WORST_CASE_BUDGET_MS}ms when wedged`, async () => {
    pointWorkerAt(await closedPort());
    expect(await timeObservationHookThroughNudgeSettle()).toBeLessThan(HOOK_WALL_TIME_BUDGET_MS);

    const sockets: Socket[] = [];
    const server = createServer(socket => { sockets.push(socket); });
    blackHole = { server, sockets };
    pointWorkerAt(await listen(server));
    const wedgedElapsedMs = await timeObservationHookThroughNudgeSettle();
    expect(wedgedElapsedMs).toBeGreaterThanOrEqual(SPOOL_NUDGE_TIMEOUT_MS - 50);
    expect(wedgedElapsedMs).toBeLessThan(HOOK_EXIT_WORST_CASE_BUDGET_MS);
  });
});
