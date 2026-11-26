import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  CLOUD_SYNC_EXTERNAL_RESTART_WARNING,
  CLOUD_SYNC_NOT_PICKED_UP_WARNING,
  restartWorkerForSyncChange,
  restartWorkerToPickUpCloudSync,
} from '../../src/npx-cli/install/worker-sync-restart.js';
import { waitForBackgroundWorkToFinish } from '../../src/npx-cli/install/browser-setup.js';
import { clearPortCache } from '../../src/shared/worker-utils.js';
import { startTeamBrainMock, type TeamBrainMock } from '../helpers/teambrain-mock-server.js';

type Line = { level: 'info' | 'success' | 'warn'; message: string };

function recordingLog() {
  const lines: Line[] = [];
  return {
    lines,
    log: {
      info: (message: string) => { lines.push({ level: 'info', message }); },
      success: (message: string) => { lines.push({ level: 'success', message }); },
      warn: (message: string) => { lines.push({ level: 'warn', message }); },
    },
  };
}

const ENV_KEYS = ['CLAUDE_MEM_DATA_DIR', 'CLAUDE_MEM_WORKER_PORT', 'CLAUDE_MEM_WORKER_HOST', 'CLAUDE_MEM_WORKER_URL'] as const;

describe('restarting the worker after Cloud Sync is approved during install', () => {
  let server: TeamBrainMock;
  let dataDir: string;
  const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};

  beforeAll(async () => {
    server = await startTeamBrainMock();
  });
  afterAll(async () => {
    await server.stop();
  });

  beforeEach(() => {
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    dataDir = mkdtempSync(join(tmpdir(), 'claude-mem-sync-restart-'));
    process.env.CLAUDE_MEM_DATA_DIR = dataDir;
    process.env.CLAUDE_MEM_WORKER_PORT = String(server.port);
    process.env.CLAUDE_MEM_WORKER_HOST = '127.0.0.1';
    delete process.env.CLAUDE_MEM_WORKER_URL;
    clearPortCache();
    server.requests.length = 0;
    Object.assign(server.state, {
      health: null, restart: null, setupState: null, localApiToken: null, workerPid: 100, syncConfigured: false, syncConfiguredAfterRestart: true,
    });
  });
  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    clearPortCache();
    rmSync(dataDir, { recursive: true, force: true });
  });

  // The real restart polls once a second; the tests poll every 10ms.
  const quickRestart: typeof restartWorkerForSyncChange = (syncOn, log) => restartWorkerForSyncChange(syncOn, log, { pollMs: 10, waitMs: 2_000 });
  const noBackgroundWork = { status: 200, body: { status: 'complete', backgroundWorkRunning: [] } };

  it('waits for background work, restarts the worker and confirms sync without the old warning', async () => {
    const { lines, log } = recordingLog();
    const order: string[] = [];
    const confirmed = await restartWorkerToPickUpCloudSync({
      log,
      waitForBackgroundWork: async () => { order.push('waited'); },
      restart: async (syncOn, restartLog) => {
        order.push(`restart:${syncOn}`);
        return quickRestart(syncOn, restartLog);
      },
    });
    expect(confirmed).toBe(true);
    expect(order).toEqual(['waited', 'restart:true']);
    expect(server.requestsTo('/api/admin/restart')).toHaveLength(1);
    expect(lines).toContainEqual({ level: 'success', message: 'Cloud sync is on: this install syncs to your account.' });
    expect(lines.map(line => line.message)).not.toContain(CLOUD_SYNC_NOT_PICKED_UP_WARNING);
  });

  it('sends the local API token with the background work read and the restart (#5141)', async () => {
    const token = 'local-api-token-fixture';
    writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ CLAUDE_MEM_LOCAL_API_TOKEN: token }));
    server.state.localApiToken = token;
    server.state.setupState = noBackgroundWork;
    const { lines, log } = recordingLog();
    const confirmed = await restartWorkerToPickUpCloudSync({ log, restart: quickRestart });
    expect(confirmed).toBe(true);
    expect(server.requestsTo('/api/setup/state').map(request => request.localApiToken)).toEqual([token]);
    expect(server.requestsTo('/api/admin/restart').map(request => request.localApiToken)).toEqual([token]);
    expect(lines.filter(line => line.level === 'warn')).toEqual([]);
  });

  it('prints only the restart\'s own warning when the restart is not confirmed', async () => {
    const { lines, log } = recordingLog();
    // The worker restarts but keeps reporting configured: false.
    server.state.syncConfiguredAfterRestart = false;
    const confirmed = await restartWorkerToPickUpCloudSync({
      log,
      waitForBackgroundWork: async () => {},
      restart: (syncOn, restartLog) => restartWorkerForSyncChange(syncOn, restartLog, { pollMs: 10, waitMs: 100 }),
    });
    expect(confirmed).toBe(false);
    expect(lines).toEqual([{ level: 'warn', message: 'The worker restart could not be confirmed within 0.1s. Check it with: npx claude-mem doctor' }]);
  });

  it('keeps the warning and does not restart when the worker cannot say its background work finished', async () => {
    const { lines, log } = recordingLog();
    let restarted = false;
    const confirmed = await restartWorkerToPickUpCloudSync({
      log,
      waitForBackgroundWork: async () => { throw new Error('Could not read the worker\'s background work state: connection lost'); },
      restart: async () => { restarted = true; return true; },
    });
    expect(confirmed).toBe(false);
    expect(restarted).toBe(false);
    expect(server.requestsTo('/api/admin/restart')).toHaveLength(0);
    expect(lines).toEqual([{ level: 'warn', message: `${CLOUD_SYNC_NOT_PICKED_UP_WARNING} (Could not read the worker's background work state: connection lost)` }]);
  });

  it('stops waiting for background work at its deadline and keeps the warning', async () => {
    // A scan held at its upload question counts as running, so the worker could keep this up for good.
    server.state.setupState = { status: 200, body: { status: 'complete', backgroundWorkRunning: ['extraction'] } };
    const { lines, log } = recordingLog();
    let restarted = false;
    const confirmed = await restartWorkerToPickUpCloudSync({
      log,
      maxWaitMs: 50,
      waitForBackgroundWork: (deps) => waitForBackgroundWorkToFinish({ ...deps, pollIntervalMs: 10 }),
      restart: async () => { restarted = true; return true; },
    });
    expect(confirmed).toBe(false);
    expect(restarted).toBe(false);
    expect(server.requestsTo('/api/setup/state').length).toBeGreaterThan(1);
    expect(lines.filter(line => line.level === 'warn')).toEqual([
      { level: 'warn', message: `${CLOUD_SYNC_NOT_PICKED_UP_WARNING} (The worker was still reading your goals, work and rules after 1s.)` },
    ]);
  });

  it('prints one warning when the worker refuses the restart', async () => {
    const { lines, log } = recordingLog();
    server.state.restart = { status: 500, body: { error: 'restart refused' } };
    const confirmed = await restartWorkerToPickUpCloudSync({ log, waitForBackgroundWork: async () => {}, restart: quickRestart });
    expect(confirmed).toBe(false);
    expect(server.requestsTo('/api/admin/restart')).toHaveLength(1);
    expect(server.state.workerPid).toBe(100);
    expect(lines).toEqual([{ level: 'warn', message: 'Could not restart the claude-mem worker (HTTP 500). Restart it so the change applies: npx claude-mem restart' }]);
  });

  it('leaves a worker run by the person\'s own manager alone and tells them to restart it there', async () => {
    const { lines, log } = recordingLog();
    let waited = false;
    let restarted = false;
    const confirmed = await restartWorkerToPickUpCloudSync({
      log,
      managedExternally: true,
      waitForBackgroundWork: async () => { waited = true; },
      restart: async () => { restarted = true; return true; },
    });
    expect(confirmed).toBe(false);
    expect(waited).toBe(false);
    expect(restarted).toBe(false);
    expect(server.requestsTo('/api/admin/restart')).toHaveLength(0);
    expect(lines).toEqual([{ level: 'warn', message: CLOUD_SYNC_EXTERNAL_RESTART_WARNING }]);
  });

  it('falls back to the installer warning when the restart said nothing went wrong', async () => {
    const { lines, log } = recordingLog();
    const confirmed = await restartWorkerToPickUpCloudSync({
      log,
      waitForBackgroundWork: async () => {},
      restart: async (_syncOn, restartLog) => { restartLog.info('The claude-mem worker is not running; cloud sync starts with it (npx claude-mem start).'); return false; },
    });
    expect(confirmed).toBe(false);
    expect(lines.map(line => line.level)).toEqual(['info', 'warn']);
    expect(lines[1].message).toBe(CLOUD_SYNC_NOT_PICKED_UP_WARNING);
  });
});
