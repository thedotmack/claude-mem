// A PreToolUse memory lookup must carry the calling harness's platform source,
// the way every sibling context path does. Without it the worker's platform
// filter is skipped and another harness's observations come back.
import { describe, it, expect, beforeEach, afterEach, afterAll, spyOn, mock } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir, homedir } from 'os';
import { join } from 'path';
import type { NormalizedHookInput } from '../../src/cli/types.js';

// Capture the REAL modules BEFORE mocking so afterAll can restore them.
// bun's `mock.module` is process-global and sticky; `mock.restore()` does NOT
// undo it, so we must explicitly re-register the real implementations to keep
// the suite order-independent (otherwise these mocks leak into later files).
import * as realSettingsDefaultsManager from '../../src/shared/SettingsDefaultsManager.js';
import * as realHookSettings from '../../src/shared/hook-settings.js';
import * as realWorkerUtils from '../../src/shared/worker-utils.js';
import * as realProjectName from '../../src/utils/project-name.js';
import * as realProjectFilter from '../../src/utils/project-filter.js';

// Snapshot the real exports into plain objects NOW, before mock.module mutates
// the live ESM namespace bindings. These snapshots are re-registered in afterAll.
const realSettingsSnapshot = { ...realSettingsDefaultsManager };
const realHookSettingsSnapshot = { ...realHookSettings };
const realWorkerUtilsSnapshot = { ...realWorkerUtils };
const realProjectNameSnapshot = { ...realProjectName };
const realProjectFilterSnapshot = { ...realProjectFilter };

mock.module('../../src/shared/SettingsDefaultsManager.js', () => ({
  SettingsDefaultsManager: {
    get: (key: string) => {
      if (key === 'CLAUDE_MEM_DATA_DIR') return join(homedir(), '.claude-mem');
      return '';
    },
    getInt: () => 0,
    // Host/port so the real buildWorkerUrl() produces a parseable authority;
    // the fetch spy answers it, so no worker is ever contacted.
    loadFromFile: () => ({
      CLAUDE_MEM_EXCLUDED_PROJECTS: [],
      CLAUDE_MEM_WORKER_HOST: '127.0.0.1',
      CLAUDE_MEM_WORKER_PORT: '37777',
    }),
  },
}));

// Every setting these handlers read comes from here, including the
// cross-harness hand-off opt-out each test flips.
let hookSettings: Record<string, string> = {};
mock.module('../../src/shared/hook-settings.js', () => ({
  ...realHookSettingsSnapshot,
  loadFromFileOnce: () => ({
    CLAUDE_MEM_EXCLUDED_PROJECTS: '',
    ...hookSettings,
  }),
}));

// Every worker call the handlers make is recorded, then run by the REAL
// executeWithWorkerFallback, whose fetch the spy in each test answers. The
// recorded `url` is the apiPath the handler itself built.
const workerCalls: Array<{ url: string }> = [];

mock.module('../../src/shared/worker-utils.js', () => ({
  ...realWorkerUtilsSnapshot,
  executeWithWorkerFallback: (
    url: string,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    body?: unknown,
    options?: { timeoutMs?: number; workerStartupTimeoutMs?: number },
  ) => {
    workerCalls.push({ url });
    return realWorkerUtilsSnapshot.executeWithWorkerFallback(url, method, body, options);
  },
  getWorkerPort: () => 37777,
  workerHttpRequest: (apiPath: string, options?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    return globalThis.fetch(`http://127.0.0.1:37777${apiPath}`, {
      method: options?.method ?? 'GET',
      headers: options?.headers,
      body: options?.body,
    });
  },
}));

mock.module('../../src/utils/project-name.js', () => ({
  getProjectName: () => 'test-project',
  getProjectContext: () => ({ primary: 'test-project', allProjects: ['test-project'] }),
}));

mock.module('../../src/utils/project-filter.js', () => ({
  isProjectExcluded: () => false,
}));

import { memorySearchHandler } from '../../src/cli/handlers/memory-search.js';
import { fileContextHandler } from '../../src/cli/handlers/file-context.js';
import { logger } from '../../src/utils/logger.js';

const PADDING = 'x'.repeat(2_000);

let tmpDir: string;
let testFile: string;
let fetchSpy: ReturnType<typeof spyOn> | null = null;
let loggerSpies: ReturnType<typeof spyOn>[] = [];
let prevDataDir: string | undefined;

// A fresh Response per fetch call: the readiness probe and the request itself
// each read a body, and a Response body is single-use.
function observationsResponse(): Response {
  return new Response(
    JSON.stringify({
      observations: [{
        id: 1,
        memory_session_id: 'session-1',
        title: 'Observation 1',
        type: 'discovery',
        created_at_epoch: Date.now() + 60_000,
        files_read: JSON.stringify([]),
        files_modified: JSON.stringify(['test.md']),
      }],
      count: 1,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function memorySearchInput(platform: string): NormalizedHookInput {
  return {
    sessionId: 'sess',
    cwd: tmpDir,
    platform,
    toolName: 'memory_search',
    toolInput: { query: 'notes' },
  };
}

function fileReadInput(platform: string): NormalizedHookInput {
  return {
    sessionId: 'sess',
    cwd: tmpDir,
    platform,
    toolName: 'Read',
    toolInput: { file_path: testFile },
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'pretooluse-platform-scope-'));
  testFile = join(tmpDir, 'test.md');
  writeFileSync(testFile, PADDING);
  hookSettings = {};
  workerCalls.length = 0;

  // The per-(session,file) injection gate persists in the SQLite DB under
  // DATA_DIR. Point it at a fresh per-test dir so the real ~/.claude-mem is
  // never touched.
  prevDataDir = process.env.CLAUDE_MEM_DATA_DIR;
  process.env.CLAUDE_MEM_DATA_DIR = join(tmpDir, 'data');
  mkdirSync(join(tmpDir, 'data'), { recursive: true });

  fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(observationsResponse()));

  loggerSpies = [
    spyOn(logger, 'info').mockImplementation(() => {}),
    spyOn(logger, 'debug').mockImplementation(() => {}),
    spyOn(logger, 'warn').mockImplementation(() => {}),
    spyOn(logger, 'error').mockImplementation(() => {}),
  ];
});

afterEach(() => {
  loggerSpies.forEach(s => s.mockRestore());
  if (fetchSpy) {
    fetchSpy.mockRestore();
    fetchSpy = null;
  }
  if (prevDataDir === undefined) delete process.env.CLAUDE_MEM_DATA_DIR;
  else process.env.CLAUDE_MEM_DATA_DIR = prevDataDir;
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

afterAll(() => {
  mock.module('../../src/shared/SettingsDefaultsManager.js', () => realSettingsSnapshot);
  mock.module('../../src/shared/hook-settings.js', () => realHookSettingsSnapshot);
  mock.module('../../src/shared/worker-utils.js', () => realWorkerUtilsSnapshot);
  mock.module('../../src/utils/project-name.js', () => realProjectNameSnapshot);
  mock.module('../../src/utils/project-filter.js', () => realProjectFilterSnapshot);
});

describe('PreToolUse memory lookups carry the calling platform source', () => {
  it('scopes the memory-search worker request to the calling harness', async () => {
    await memorySearchHandler.execute(memorySearchInput('codex'));

    expect(workerCalls).toHaveLength(1);
    expect(workerCalls[0].url).toStartWith('/api/search?');
    expect(workerCalls[0].url).toContain('platformSource=codex');
  });

  it('scopes the by-file worker request to the calling harness', async () => {
    await fileContextHandler.execute(fileReadInput('codex'));

    expect(workerCalls).toHaveLength(1);
    expect(workerCalls[0].url).toStartWith('/api/observations/by-file?');
    expect(workerCalls[0].url).toContain('platformSource=codex');
  });

  it('omits the platform source from both requests when the cross-harness hand-off is enabled', async () => {
    hookSettings = { CLAUDE_MEM_SESSION_START_INCLUDE_ALL_SOURCES: 'true' };

    await memorySearchHandler.execute(memorySearchInput('codex'));
    expect(workerCalls.length).toBeGreaterThan(0);
    expect(workerCalls.every(call => !call.url.includes('platformSource'))).toBe(true);

    workerCalls.length = 0;
    await fileContextHandler.execute(fileReadInput('codex'));
    expect(workerCalls.length).toBeGreaterThan(0);
    expect(workerCalls.every(call => !call.url.includes('platformSource'))).toBe(true);
  });
});
