import { beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The same real context worker handles every render. Settings saves are real
// HTTP writes, so restarting a hook or resetting its module cache cannot hide
// a stale settings snapshot in the long-lived renderer.
const fixture = String.raw`
import express from 'express';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ModeManager } from './src/services/domain/ModeManager.ts';
import { SessionStore } from './src/services/sqlite/SessionStore.ts';
import { ContextReadWorkerClient } from './src/services/context/ContextReadWorkerClient.ts';
import { SearchRoutes } from './src/services/worker/http/routes/SearchRoutes.ts';
import { SettingsRoutes } from './src/services/worker/http/routes/SettingsRoutes.ts';
import { WORK_STATE_RULE } from './src/shared/memory-instructions.ts';
const settingsPath = join(process.env.CLAUDE_MEM_DATA_DIR, 'settings.json');
writeFileSync(settingsPath, JSON.stringify({
  CLAUDE_MEM_RUNTIME: 'worker', CLAUDE_MEM_MEMORY_INSTRUCTIONS_ENABLED: 'true',
  CLAUDE_MEM_WORK_STATE_ENABLED: 'true', CLAUDE_MEM_WELCOME_HINT_ENABLED: 'false',
  CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE: 'false',
}));
ModeManager.getInstance().loadMode('code');
const store = new SessionStore(join(process.env.CLAUDE_MEM_DATA_DIR, 'claude-mem.db'));
const sid = store.createSDKSession('rules-host', 'app', 'request');
store.ensureMemorySessionIdRegistered(sid, 'rules-memory');
store.storeObservation('rules-memory', 'app', { type: 'discovery', title: 'RETAINED_MEMORY', subtitle: null,
  facts: [], narrative: 'RETAINED_MEMORY', concepts: ['how-it-works'], files_read: [], files_modified: [] }, 1);
const reader = new ContextReadWorkerClient();
const app = express(); app.use(express.json());
new SearchRoutes({ getSessionStore: () => store }, null, null, reader).setupRoutes(app);
new SettingsRoutes({}).setupRoutes(app);
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const url = 'http://127.0.0.1:' + server.address().port;
const reads = [];
async function render() {
  const response = await fetch(url + '/api/context/inject?project=app');
  if (!response.ok) throw new Error('Context HTTP ' + response.status + ': ' + await response.text());
  const timeline = await response.text();
  const text = readFileSync(join(process.env.CLAUDE_MEM_DATA_DIR, 'RULES-AND-TOOLS.md'), 'utf8');
  const snapshot = { timeline, text, memory: text.includes('# claude-mem memory use'), work: text.includes(WORK_STATE_RULE), threadId: reader.worker.threadId };
  reads.push(snapshot); return snapshot;
}
async function save(enabled) {
  const response = await fetch(url + '/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ CLAUDE_MEM_MEMORY_INSTRUCTIONS_ENABLED: String(enabled) }) });
  if (!response.ok || !(await response.json()).success) throw new Error('Settings save failed');
  return JSON.parse(readFileSync(settingsPath, 'utf8')).CLAUDE_MEM_MEMORY_INSTRUCTIONS_ENABLED;
}
try {
  const initial = await render();
  const savedOff = await save(false);
  const memoryOff = await render();
  // Work-state enablement is file-only. Edit the owned settings document by
  // that supported path and re-render without replacing the context thread.
  const file = JSON.parse(readFileSync(settingsPath, 'utf8'));
  file.CLAUDE_MEM_WORK_STATE_ENABLED = 'false';
  writeFileSync(settingsPath, JSON.stringify(file));
  const bothOff = await render();
  const savedOn = await save(true);
  const memoryOn = await render();
  const restored = JSON.parse(readFileSync(settingsPath, 'utf8'));
  restored.CLAUDE_MEM_WORK_STATE_ENABLED = 'true';
  writeFileSync(settingsPath, JSON.stringify(restored));
  const bothOn = await render();
  console.log(JSON.stringify({ initial, savedOff, memoryOff, bothOff, savedOn, memoryOn, bothOn, threadIds: reads.map(read => read.threadId) }));
} finally {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await reader.close(); store.close();
}
`;

describe('Rules + Tools settings in the persistent context reader', () => {
  let result: any;
  beforeAll(() => {
    const root = mkdtempSync(join(tmpdir(), 'cm-rules-tools-settings-'));
    try {
      const env = { ...process.env, CLAUDE_MEM_DATA_DIR: root, CLAUDE_CONFIG_DIR: join(root, 'config'),
        CLAUDE_MEM_RUNTIME: 'worker', CLAUDE_MEM_TELEMETRY_ENABLED: 'false' };
      delete env.CLAUDE_MEM_MEMORY_INSTRUCTIONS_ENABLED;
      delete env.CLAUDE_MEM_WORK_STATE_ENABLED;
      const run = Bun.spawnSync([process.execPath, '-e', fixture], {
        cwd: join(import.meta.dir, '../..'), env, stdout: 'pipe', stderr: 'pipe', timeout: 30_000,
      });
      if (run.exitCode !== 0) throw new Error(new TextDecoder().decode(run.stderr));
      result = JSON.parse(new TextDecoder().decode(run.stdout).trim().split('\n').at(-1)!);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 40_000);

  it('starts with both enabled rules on a real timeline', () => {
    expect(result.initial.memory).toBe(true); expect(result.initial.work).toBe(true);
    expect(result.initial.timeline).toContain('RETAINED_MEMORY');
  });

  it('honors a successful HTTP memory-guidance toggle on the next render', () => {
    expect(result.savedOff).toBe('false');
    expect(result.memoryOff.memory).toBe(false); expect(result.memoryOff.work).toBe(true);
    expect(result.savedOn).toBe('true'); expect(result.memoryOn.memory).toBe(true);
  });

  it('honors file-only work-state settings in the same running reader', () => {
    expect(result.bothOff.work).toBe(false); expect(result.bothOff.memory).toBe(false);
    expect(result.memoryOn.work).toBe(false);
    expect(result.bothOn.work).toBe(true); expect(result.bothOn.memory).toBe(true);
  });

  it('keeps the timeline and format guidance through changes without restarting', () => {
    expect(new Set(result.threadIds).size).toBe(1);
    for (const snapshot of [result.initial, result.memoryOff, result.bothOff, result.memoryOn, result.bothOn]) {
      expect(snapshot.timeline).toContain('RETAINED_MEMORY');
      expect(snapshot.text).toContain('Format: ID TIME TYPE TITLE');
      expect(snapshot.text).toContain('Fetch details: get_observations([IDs])');
    }
  });
});
