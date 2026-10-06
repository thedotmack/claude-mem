
import { describe, it, expect, beforeEach, afterEach, afterAll, spyOn, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, writeFileSync, utimesSync, rmSync, statSync } from 'fs';
import { tmpdir, homedir } from 'os';
import { join } from 'path';
import { resolveDbPath } from '../../src/shared/paths.js';
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
import * as realTreeSitterBinPath from '../../src/services/smart-file-read/tree-sitter-bin-path.js';

// Snapshot the real exports into plain objects NOW, before mock.module mutates
// the live ESM namespace bindings. These snapshots are re-registered in afterAll.
const realSettingsSnapshot = { ...realSettingsDefaultsManager };
const realHookSettingsSnapshot = { ...realHookSettings };
const realWorkerUtilsSnapshot = { ...realWorkerUtils };
const realProjectNameSnapshot = { ...realProjectName };
const realProjectFilterSnapshot = { ...realProjectFilter };
const realTreeSitterBinPathSnapshot = { ...realTreeSitterBinPath };

mock.module('../../src/shared/SettingsDefaultsManager.js', () => ({
  SettingsDefaultsManager: {
    get: (key: string) => {
      if (key === 'CLAUDE_MEM_DATA_DIR') return join(homedir(), '.claude-mem');
      return '';
    },
    getInt: () => 0,
    loadFromFile: () => ({ CLAUDE_MEM_EXCLUDED_PROJECTS: [] }),
  },
}));

// The File Read Gate reads CLAUDE_MEM_FILE_READ_GATE_ENABLED through
// loadFromFileOnce. Spread the real module so none of its exports vanish for
// later test files; keep CLAUDE_MEM_EXCLUDED_PROJECTS for shouldTrackProject.
let fileReadGateSetting: string | undefined = 'true';
mock.module('../../src/shared/hook-settings.js', () => ({
  ...realHookSettingsSnapshot,
  loadFromFileOnce: () => ({
    CLAUDE_MEM_EXCLUDED_PROJECTS: '',
    CLAUDE_MEM_FILE_READ_GATE_ENABLED: fileReadGateSetting,
  }),
}));

// Every worker call the handler makes is recorded, then run by the REAL
// executeWithWorkerFallback, which the fetch spy in each test answers.
const workerFallbackCalls: Array<{ url: string; method: string; body: unknown; options: unknown }> = [];

mock.module('../../src/shared/worker-utils.js', () => ({
  executeWithWorkerFallback: (
    url: string,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    body?: unknown,
    options?: { timeoutMs?: number },
  ) => {
    workerFallbackCalls.push({ url, method, body, options });
    return realWorkerUtilsSnapshot.executeWithWorkerFallback(url, method, body, options);
  },
  ensureWorkerRunning: () => Promise.resolve(true),
  getWorkerPort: () => 37777,
  workerHttpRequest: (apiPath: string, options?: any) => {
    const url = `http://127.0.0.1:37777${apiPath}`;
    return globalThis.fetch(url, {
      method: options?.method ?? 'GET',
      headers: options?.headers,
      body: options?.body,
    });
  },
}));

mock.module('../../src/utils/project-name.js', () => ({
  getProjectName: () => 'test-project',
  getProjectContext: () => ({ allProjects: ['test-project'] }),
}));

mock.module('../../src/utils/project-filter.js', () => ({
  isProjectExcluded: () => false,
}));

// The gate denies only where smart_outline can parse (the tree-sitter CLI is
// installed). Stubbed so these tests never depend on the machine's install.
let treeSitterCliAvailable = true;
mock.module('../../src/services/smart-file-read/tree-sitter-bin-path.js', () => ({
  ...realTreeSitterBinPathSnapshot,
  isTreeSitterCliAvailable: () => treeSitterCliAvailable,
}));

import {
  fileContextHandler,
  shouldDenyFullFileRead,
  FILE_CONTEXT_WORKER_BUDGET_MS,
} from '../../src/cli/handlers/file-context.js';
import { claimFileContextInjection } from '../../src/cli/handlers/file-context-dedupe.js';
import { logger } from '../../src/utils/logger.js';

const PADDING = 'x'.repeat(2_000); 

// A code file smart_outline can outline, over 1,500 bytes, with a known line
// count (trailing newline included) for the whole-file vs targeted Read cases.
const GATED_FILE_LINE_COUNT = 120;
const GATED_FILE_CONTENT = Array.from(
  { length: GATED_FILE_LINE_COUNT },
  (_, index) => `export const fixtureValue${index} = ${index}; // read-gate fixture line`,
).join('\n') + '\n';

let tmpDir: string;
let testFile: string;
let gatedFile: string;
let loggerSpies: ReturnType<typeof spyOn>[] = [];
let fetchSpy: ReturnType<typeof spyOn> | null = null;

function makeObservationsResponse(observations: Array<{ id: number; created_at_epoch: number; type?: string; title?: string }>) {
  return new Response(
    JSON.stringify({
      observations: observations.map(o => ({
        id: o.id,
        memory_session_id: `session-${o.id}`,
        title: o.title ?? `Observation ${o.id}`,
        type: o.type ?? 'discovery',
        created_at_epoch: o.created_at_epoch,
        files_read: JSON.stringify([]),
        files_modified: JSON.stringify(['test.md']),
      })),
      count: observations.length,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}

let prevDataDir: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'file-context-test-'));
  testFile = join(tmpDir, 'test.md');
  writeFileSync(testFile, PADDING);
  gatedFile = join(tmpDir, 'gated.ts');
  writeFileSync(gatedFile, GATED_FILE_CONTENT);
  fileReadGateSetting = 'true';
  treeSitterCliAvailable = true;
  workerFallbackCalls.length = 0;

  // #3480 — the per-(session,file) injection gate persists in the SQLite DB
  // under DATA_DIR. Point it at a fresh per-test dir so each test starts with an
  // empty gate table and the real ~/.claude-mem is never touched.
  prevDataDir = process.env.CLAUDE_MEM_DATA_DIR;
  process.env.CLAUDE_MEM_DATA_DIR = join(tmpDir, 'data');

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
  mock.module('../../src/services/smart-file-read/tree-sitter-bin-path.js', () => realTreeSitterBinPathSnapshot);
});

describe('fileContextHandler — #2094 (no Read mutation)', () => {
  it('skips file-context injection for subagent reads when agentId is present', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      makeObservationsResponse([{ id: 1, created_at_epoch: Date.now() + 60_000 }])
    );

    const result = await fileContextHandler.execute({
      sessionId: 'sess',
      agentId: 'subagent-1',
      cwd: tmpDir,
      toolName: 'Read',
      toolInput: { file_path: testFile },
    });

    expect(result).toEqual({ continue: true, suppressOutput: true });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('still injects file context for the main session', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      makeObservationsResponse([{ id: 1, created_at_epoch: Date.now() + 60_000 }])
    );

    const result = await fileContextHandler.execute({
      sessionId: 'sess',
      cwd: tmpDir,
      toolName: 'Read',
      toolInput: { file_path: testFile },
    });

    expect(result.hookSpecificOutput?.additionalContext).toContain('prior observations');
  });

  it('does not skip when only agentType is present', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      makeObservationsResponse([{ id: 1, created_at_epoch: Date.now() + 60_000 }])
    );

    const result = await fileContextHandler.execute({
      sessionId: 'sess',
      agentType: 'worker',
      cwd: tmpDir,
      toolName: 'Read',
      toolInput: { file_path: testFile },
    });

    expect(result.hookSpecificOutput?.additionalContext).toContain('prior observations');
    expect(fetchSpy).toHaveBeenCalled();
  });

  it('injects timeline context but never sets updatedInput on an unconstrained Read', async () => {
    const future = Date.now() + 60_000;
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      makeObservationsResponse([{ id: 1, created_at_epoch: future }])
    );

    const result = await fileContextHandler.execute({
      sessionId: 'sess',
      cwd: tmpDir,
      toolName: 'Read',
      toolInput: { file_path: testFile },
    });

    expect(result.hookSpecificOutput).toBeDefined();
    expect(result.hookSpecificOutput!.additionalContext).toContain('prior observations');
    expect((result.hookSpecificOutput as any).updatedInput).toBeUndefined();
    // Context only: on a synchronous hook 'allow' would skip the permission prompt.
    expect(result.hookSpecificOutput!.permissionDecision).toBeUndefined();
  });

  it('does not set updatedInput on a targeted Read either', async () => {
    const future = Date.now() + 60_000;
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      makeObservationsResponse([{ id: 1, created_at_epoch: future }])
    );

    const result = await fileContextHandler.execute({
      sessionId: 'sess',
      cwd: tmpDir,
      toolName: 'Read',
      toolInput: { file_path: testFile, offset: 289, limit: 140 },
    });

    expect(result.hookSpecificOutput).toBeDefined();
    expect((result.hookSpecificOutput as any).updatedInput).toBeUndefined();
  });

  it('skips entirely when file mtime is newer than newest observation (#1719 still honored)', async () => {
    const stale = Date.now() - 3_600_000;
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      makeObservationsResponse([
        { id: 1, created_at_epoch: stale },
        { id: 2, created_at_epoch: stale - 1000 },
      ])
    );

    const result = await fileContextHandler.execute({
      sessionId: 'sess',
      cwd: tmpDir,
      toolName: 'Read',
      toolInput: { file_path: testFile },
    });

    expect(result.continue).toBe(true);
    expect(result.hookSpecificOutput).toBeUndefined();
  });

  it('still injects context when file mtime is older than newest observation', async () => {
    const past = (Date.now() - 3_600_000) / 1000;
    utimesSync(testFile, past, past);

    const now = Date.now();
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      makeObservationsResponse([{ id: 1, created_at_epoch: now }])
    );

    const result = await fileContextHandler.execute({
      sessionId: 'sess',
      cwd: tmpDir,
      toolName: 'Read',
      toolInput: { file_path: testFile },
    });

    expect(result.hookSpecificOutput).toBeDefined();
    expect(result.hookSpecificOutput!.additionalContext).toContain('prior observations');
    expect((result.hookSpecificOutput as any).updatedInput).toBeUndefined();
  });

  it('header text no longer claims the file was truncated', async () => {
    const future = Date.now() + 60_000;
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      makeObservationsResponse([{ id: 1, created_at_epoch: future }])
    );

    const result = await fileContextHandler.execute({
      sessionId: 'sess',
      cwd: tmpDir,
      toolName: 'Read',
      toolInput: { file_path: testFile },
    });

    const ctx = result.hookSpecificOutput!.additionalContext as string;
    expect(ctx).not.toContain('Only line 1 was read');
    expect(ctx).toContain('full requested section');
  });

  it('accepts a Codex filePaths array and joins per-file context blocks', async () => {
    const otherFile = join(tmpDir, 'other.md');
    writeFileSync(otherFile, PADDING);

    const future = Date.now() + 60_000;
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((url: string | URL | Request) => {
      const text = String(url);
      if (text.includes('other.md')) {
        return Promise.resolve(makeObservationsResponse([{ id: 2, created_at_epoch: future, title: 'Other file context' }]));
      }
      return Promise.resolve(makeObservationsResponse([{ id: 1, created_at_epoch: future, title: 'Main file context' }]));
    });

    const result = await fileContextHandler.execute({
      sessionId: 'sess',
      cwd: tmpDir,
      toolName: 'Bash',
      toolInput: { filePaths: [testFile, otherFile] },
    });

    const ctx = result.hookSpecificOutput!.additionalContext as string;
    expect(ctx).toContain('Main file context');
    expect(ctx).toContain('Other file context');
    expect(ctx).toContain('\n\n---\n\n');
  });

  it('keeps successful timelines when one file lookup fails', async () => {
    const otherFile = join(tmpDir, 'other.md');
    writeFileSync(otherFile, PADDING);

    const future = Date.now() + 60_000;
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((url: string | URL | Request) => {
      const text = String(url);
      if (text.includes('other.md')) {
        return Promise.reject(new Error('worker unavailable'));
      }
      return Promise.resolve(makeObservationsResponse([{ id: 1, created_at_epoch: future, title: 'Main file context' }]));
    });

    const result = await fileContextHandler.execute({
      sessionId: 'sess',
      cwd: tmpDir,
      toolName: 'Bash',
      toolInput: { filePaths: [testFile, otherFile] },
    });

    const ctx = result.hookSpecificOutput!.additionalContext as string;
    expect(ctx).toContain('Main file context');
    expect(ctx).not.toContain('worker unavailable');
  });

  it('queries with BOTH absolute and cwd-relative path candidates (#2691)', async () => {
    const future = Date.now() + 60_000;
    let capturedUrl = '';
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((url: string | URL | Request) => {
      capturedUrl = String(url);
      return Promise.resolve(makeObservationsResponse([{ id: 1, created_at_epoch: future }]));
    });

    await fileContextHandler.execute({
      sessionId: 'sess',
      cwd: tmpDir,
      toolName: 'Read',
      toolInput: { file_path: testFile },
    });

    const parsed = new URL(capturedUrl);
    const pathParams = parsed.searchParams.getAll('path');
    // Both candidate forms are sent so the worker can match however the path was
    // stored at PostToolUse time (absolute vs cwd-relative).
    const absoluteForm = testFile.split(/[\\/]/).join('/');
    expect(pathParams).toContain(absoluteForm);
    expect(pathParams).toContain('test.md'); // cwd-relative form
    expect(pathParams.length).toBeGreaterThanOrEqual(2);
  });

  it('injects once per (session, file) — a second unchanged Read is deduped (#3480)', async () => {
    const future = Date.now() + 60_000;
    // mockImplementation (not mockResolvedValue): each call needs a FRESH
    // Response — a Response body can only be consumed once.
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(makeObservationsResponse([{ id: 1, created_at_epoch: future }]))
    );

    const first = await fileContextHandler.execute({
      sessionId: 'sess-dedupe',
      cwd: tmpDir,
      toolName: 'Read',
      toolInput: { file_path: testFile },
    });
    expect(first.hookSpecificOutput?.additionalContext).toContain('prior observations');

    const second = await fileContextHandler.execute({
      sessionId: 'sess-dedupe',
      cwd: tmpDir,
      toolName: 'Read',
      toolInput: { file_path: testFile },
    });
    expect(second.continue).toBe(true);
    expect(second.hookSpecificOutput).toBeUndefined();
  });

  it('persists the injection gate as a SQLite row, not a JSON side-store (#3608 step 4)', async () => {
    const future = Date.now() + 60_000;
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(makeObservationsResponse([{ id: 1, created_at_epoch: future }]))
    );

    const injected = await fileContextHandler.execute({
      sessionId: 'sess-sqlite-gate',
      cwd: tmpDir,
      toolName: 'Read',
      toolInput: { file_path: testFile },
    });
    expect(injected.hookSpecificOutput?.additionalContext).toContain('prior observations');

    // The gate is a row in the main database keyed by (session, file) and
    // carrying the observation epoch it was served at — see plan-20 #3608.
    const db = new Database(resolveDbPath(), { readonly: true });
    try {
      const row = db.query(`
        SELECT file_path, observation_epoch
        FROM file_context_injections
        WHERE session_id = ?
      `).get('sess-sqlite-gate') as { file_path: string; observation_epoch: number } | null;

      expect(row).not.toBeNull();
      expect(row!.file_path).toBe(testFile);
      expect(row!.observation_epoch).toBe(future);
    } finally {
      db.close();
    }
  });

  it('grants the injection claim to exactly one caller for the same (session, file, epoch) (#3608 step 4)', () => {
    // Claiming IS recording: a check-then-write gate would hand both callers a
    // green light and inject the same block twice.
    const epoch = Date.now() + 60_000;
    const claims = [
      claimFileContextInjection('sess-claim', testFile, epoch),
      claimFileContextInjection('sess-claim', testFile, epoch),
    ];
    expect(claims.filter(Boolean)).toHaveLength(1);
  });

  it('never rolls the stored epoch back to an older observation (#3608 step 4)', async () => {
    const newer = Date.now() + 120_000;
    const older = Date.now() + 60_000;
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(makeObservationsResponse([{ id: 2, created_at_epoch: newer }]))
    );
    await fileContextHandler.execute({
      sessionId: 'sess-monotonic',
      cwd: tmpDir,
      toolName: 'Read',
      toolInput: { file_path: testFile },
    });

    // A hook that finishes late carrying an OLDER epoch must neither inject nor
    // downgrade the row — otherwise the next Read re-injects a stale timeline.
    fetchSpy.mockRestore();
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(makeObservationsResponse([{ id: 1, created_at_epoch: older }]))
    );
    const late = await fileContextHandler.execute({
      sessionId: 'sess-monotonic',
      cwd: tmpDir,
      toolName: 'Read',
      toolInput: { file_path: testFile },
    });
    expect(late.hookSpecificOutput).toBeUndefined();

    const db = new Database(resolveDbPath(), { readonly: true });
    try {
      const row = db.query(`
        SELECT observation_epoch FROM file_context_injections WHERE session_id = ?
      `).get('sess-monotonic') as { observation_epoch: number } | null;
      expect(row!.observation_epoch).toBe(newer);
    } finally {
      db.close();
    }
  });

  it('fails open when the gate database cannot be opened (#3608 step 4)', async () => {
    const future = Date.now() + 60_000;
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(makeObservationsResponse([{ id: 1, created_at_epoch: future }]))
    );

    // Data dir nested under a regular FILE: every mkdir/open against it fails
    // with ENOTDIR, so the gate is unusable. A broken gate must never break a
    // Read — it degrades to "always inject", never to an error or a swallowed
    // injection.
    const blocker = join(tmpDir, 'not-a-directory');
    writeFileSync(blocker, '');
    process.env.CLAUDE_MEM_DATA_DIR = join(blocker, 'data');

    const first = await fileContextHandler.execute({
      sessionId: 'sess-broken-gate',
      cwd: tmpDir,
      toolName: 'Read',
      toolInput: { file_path: testFile },
    });
    const second = await fileContextHandler.execute({
      sessionId: 'sess-broken-gate',
      cwd: tmpDir,
      toolName: 'Read',
      toolInput: { file_path: testFile },
    });

    expect(first.hookSpecificOutput?.additionalContext).toContain('prior observations');
    expect(second.hookSpecificOutput?.additionalContext).toContain('prior observations');
  });

  it('re-injects when a NEW observation is recorded since the last injection (#3480)', async () => {
    const first_epoch = Date.now() + 60_000;
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(makeObservationsResponse([{ id: 1, created_at_epoch: first_epoch }]))
    );
    const first = await fileContextHandler.execute({
      sessionId: 'sess-new-obs',
      cwd: tmpDir,
      toolName: 'Read',
      toolInput: { file_path: testFile },
    });
    expect(first.hookSpecificOutput?.additionalContext).toContain('prior observations');

    // A newer observation lands → re-injection is expected, not deduped.
    fetchSpy.mockRestore();
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(makeObservationsResponse([
        { id: 1, created_at_epoch: first_epoch },
        { id: 2, created_at_epoch: first_epoch + 30_000, title: 'Fresh observation' },
      ]))
    );
    const second = await fileContextHandler.execute({
      sessionId: 'sess-new-obs',
      cwd: tmpDir,
      toolName: 'Read',
      toolInput: { file_path: testFile },
    });
    expect(second.hookSpecificOutput?.additionalContext).toContain('prior observations');
  });

  it('dedupe is scoped per session — a different session still gets its injection (#3480)', async () => {
    const future = Date.now() + 60_000;
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(makeObservationsResponse([{ id: 1, created_at_epoch: future }]))
    );

    await fileContextHandler.execute({
      sessionId: 'sess-A',
      cwd: tmpDir,
      toolName: 'Read',
      toolInput: { file_path: testFile },
    });

    const other = await fileContextHandler.execute({
      sessionId: 'sess-B',
      cwd: tmpDir,
      toolName: 'Read',
      toolInput: { file_path: testFile },
    });
    expect(other.hookSpecificOutput?.additionalContext).toContain('prior observations');
  });

  it('skips directories before querying file history', async () => {
    const directoryPath = join(tmpDir, 'large-dir');
    mkdirSync(directoryPath);
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      makeObservationsResponse([{ id: 1, created_at_epoch: Date.now() + 60_000 }])
    );

    const result = await fileContextHandler.execute({
      sessionId: 'sess',
      cwd: tmpDir,
      toolName: 'Bash',
      toolInput: { filePaths: [directoryPath] },
    });

    expect(result.continue).toBe(true);
    expect(result.hookSpecificOutput).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('isolates sessions whose ids differ only in path-sanitized chars (#3486)', async () => {
    const future = Date.now() + 60_000;
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(makeObservationsResponse([{ id: 1, created_at_epoch: future }]))
    );

    // "a.b" and "a:b" are DISTINCT sessions that both collapse to "a_b" under a
    // naive char-replace scheme. The second session must still get its injection.
    await fileContextHandler.execute({
      sessionId: 'a.b',
      cwd: tmpDir,
      toolName: 'Read',
      toolInput: { file_path: testFile },
    });

    const other = await fileContextHandler.execute({
      sessionId: 'a:b',
      cwd: tmpDir,
      toolName: 'Read',
      toolInput: { file_path: testFile },
    });
    expect(other.hookSpecificOutput?.additionalContext).toContain('prior observations');
  });

  it('dedupes dot-segment path aliases of the same file in a session (#3486)', async () => {
    const future = Date.now() + 60_000;
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(makeObservationsResponse([{ id: 1, created_at_epoch: future }]))
    );

    const subDir = join(tmpDir, 'sub');
    mkdirSync(subDir);
    // Raw string keeps the `..` segment (path.join would collapse it) so the
    // alias and the canonical path name the SAME file via different spellings.
    const aliasPath = `${subDir}/../test.md`;

    const first = await fileContextHandler.execute({
      sessionId: 'sess-alias',
      cwd: tmpDir,
      toolName: 'Read',
      toolInput: { file_path: testFile },
    });
    expect(first.hookSpecificOutput?.additionalContext).toContain('prior observations');

    const second = await fileContextHandler.execute({
      sessionId: 'sess-alias',
      cwd: tmpDir,
      toolName: 'Read',
      toolInput: { file_path: aliasPath },
    });
    expect(second.continue).toBe(true);
    expect(second.hookSpecificOutput).toBeUndefined();
  });
});

describe('fileContextHandler — File Read Gate', () => {
  const GATED_OBSERVATION_ID = 4242;

  function answerWithFileHistory(createdAtEpoch = Date.now() + 60_000): void {
    // mockImplementation: every call needs a FRESH Response (a body reads once).
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(makeObservationsResponse([
        { id: GATED_OBSERVATION_ID, created_at_epoch: createdAtEpoch, title: 'Rate table refactor' },
      ]))
    );
  }

  function claudeCodeRead(
    toolInput: Record<string, unknown>,
    overrides: Partial<NormalizedHookInput> = {},
  ): NormalizedHookInput {
    return {
      sessionId: 'sess-read-gate',
      cwd: tmpDir,
      platform: 'claude-code',
      toolName: 'Read',
      toolInput,
      ...overrides,
    };
  }

  function expectContextNotDeny(result: Awaited<ReturnType<typeof fileContextHandler.execute>>): void {
    expect(result.hookSpecificOutput?.permissionDecision).toBeUndefined();
    expect(result.hookSpecificOutput?.permissionDecisionReason).toBeUndefined();
    expect(result.hookSpecificOutput?.additionalContext).toContain('prior observations');
  }

  it('denies a whole-file Read on Claude Code and routes to the smart tools', async () => {
    answerWithFileHistory();

    const result = await fileContextHandler.execute(claudeCodeRead({ file_path: gatedFile }));

    const output = result.hookSpecificOutput!;
    expect(output.hookEventName).toBe('PreToolUse');
    expect(output.permissionDecision).toBe('deny');
    expect(output.additionalContext).toBe('');
    expect((output as any).updatedInput).toBeUndefined();
    const reason = output.permissionDecisionReason!;
    expect(reason).toContain(`Full-file Read blocked by claude-mem: ${gatedFile} has prior observations (listed below).`);
    expect(reason).toContain(`smart_outline(file_path="${gatedFile}")`);
    expect(reason).toContain(`smart_unfold(file_path="${gatedFile}", symbol_name="<name>")`);
    expect(reason).toContain(`get_observations(ids=[${GATED_OBSERVATION_ID}])`);
    expect(reason).toContain('history from earlier sessions');
    expect(reason).toMatch(new RegExp(`^${GATED_OBSERVATION_ID} \\S+ \\S+ Rate table refactor$`, 'm'));
  });

  it('does not deny when CLAUDE_MEM_FILE_READ_GATE_ENABLED is false — the timeline is context', async () => {
    fileReadGateSetting = 'false';
    answerWithFileHistory();

    const result = await fileContextHandler.execute(claudeCodeRead({ file_path: gatedFile }));

    expectContextNotDeny(result);
    expect(result.hookSpecificOutput!.additionalContext).toContain('Rate table refactor');
  });

  it('only denies on Claude Code — codex, kimi and an unknown platform get context', async () => {
    answerWithFileHistory();

    for (const platform of ['codex', 'kimi', undefined]) {
      const result = await fileContextHandler.execute(
        claudeCodeRead({ file_path: gatedFile }, { platform, sessionId: `sess-platform-${platform}` })
      );
      expectContextNotDeny(result);
    }
  });

  it('does not deny Qwen Code, which runs the same claude-code hook command — the timeline is context', async () => {
    answerWithFileHistory();

    const result = await fileContextHandler.execute(
      claudeCodeRead({ file_path: gatedFile }, { transcriptPath: '/home/dot/.qwen/tmp/abc123/chats/session.json' })
    );

    expectContextNotDeny(result);
    expect(result.hookSpecificOutput!.additionalContext).toContain('Rate table refactor');
  });

  it('does not deny when the tree-sitter CLI is missing (smart_outline cannot parse) — the timeline is context', async () => {
    treeSitterCliAvailable = false;
    answerWithFileHistory();

    const result = await fileContextHandler.execute(claudeCodeRead({ file_path: gatedFile }));

    expectContextNotDeny(result);
    expect(result.hookSpecificOutput!.additionalContext).toContain('Rate table refactor');
  });

  it('does not deny a Read whose file stat fails with anything but ENOENT — the timeline is still context', async () => {
    // A path through a regular file: stat fails with ENOTDIR, so the lookup
    // goes on without its size and mtime checks. A claude-mem failure must
    // never block a Read.
    const unstatablePath = join(gatedFile, 'nested.ts');
    let statErrorCode: string | undefined;
    try {
      statSync(unstatablePath);
    } catch (error) {
      statErrorCode = (error as NodeJS.ErrnoException).code;
    }
    expect(statErrorCode).toBe('ENOTDIR');
    answerWithFileHistory();

    const result = await fileContextHandler.execute(claudeCodeRead({ file_path: unstatablePath }));

    expectContextNotDeny(result);
    expect(result.hookSpecificOutput!.additionalContext).toContain('Rate table refactor');
    expect(fetchSpy).toHaveBeenCalled();
  });

  it('lets a targeted Read through (offset 40, limit 20) with context', async () => {
    answerWithFileHistory();

    const result = await fileContextHandler.execute(claudeCodeRead({ file_path: gatedFile, offset: 40, limit: 20 }));

    expectContextNotDeny(result);
  });

  it('denies a Read whose limit covers every line, and passes one line short of that', async () => {
    answerWithFileHistory();

    const exactLimit = await fileContextHandler.execute(
      claudeCodeRead({ file_path: gatedFile, limit: GATED_FILE_LINE_COUNT }, { sessionId: 'sess-limit-exact' })
    );
    const pastTheEnd = await fileContextHandler.execute(
      claudeCodeRead({ file_path: gatedFile, limit: GATED_FILE_LINE_COUNT + 500 }, { sessionId: 'sess-limit-past' })
    );
    const firstLineWindow = await fileContextHandler.execute(
      claudeCodeRead({ file_path: gatedFile, offset: 1, limit: GATED_FILE_LINE_COUNT }, { sessionId: 'sess-offset-one' })
    );
    const oneLineShort = await fileContextHandler.execute(
      claudeCodeRead({ file_path: gatedFile, limit: GATED_FILE_LINE_COUNT - 1 }, { sessionId: 'sess-limit-short' })
    );

    expect(exactLimit.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(pastTheEnd.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(firstLineWindow.hookSpecificOutput?.permissionDecision).toBe('deny');
    expectContextNotDeny(oneLineShort);
  });

  it('counts a last line that has no trailing newline', async () => {
    const unterminatedFile = join(tmpDir, 'unterminated.ts');
    writeFileSync(unterminatedFile, GATED_FILE_CONTENT.slice(0, -1));
    answerWithFileHistory();

    const exactLimit = await fileContextHandler.execute(
      claudeCodeRead({ file_path: unterminatedFile, limit: GATED_FILE_LINE_COUNT }, { sessionId: 'sess-unterminated-exact' })
    );
    const oneLineShort = await fileContextHandler.execute(
      claudeCodeRead({ file_path: unterminatedFile, limit: GATED_FILE_LINE_COUNT - 1 }, { sessionId: 'sess-unterminated-short' })
    );

    expect(exactLimit.hookSpecificOutput?.permissionDecision).toBe('deny');
    expectContextNotDeny(oneLineShort);
  });

  it('never denies markdown, JSON or YAML files', async () => {
    const jsonFile = join(tmpDir, 'config.json');
    const yamlFile = join(tmpDir, 'config.yaml');
    writeFileSync(jsonFile, PADDING);
    writeFileSync(yamlFile, PADDING);
    answerWithFileHistory();

    for (const filePath of [testFile, jsonFile, yamlFile]) {
      const result = await fileContextHandler.execute(
        claudeCodeRead({ file_path: filePath }, { sessionId: `sess-${filePath}` })
      );
      expectContextNotDeny(result);
    }
  });

  it('never denies a file outside the session cwd', async () => {
    const projectDir = join(tmpDir, 'project');
    mkdirSync(projectDir);
    answerWithFileHistory();

    const result = await fileContextHandler.execute(claudeCodeRead({ file_path: gatedFile }, { cwd: projectDir }));

    expectContextNotDeny(result);
  });

  it('does nothing for a code file under 1,500 bytes', async () => {
    const smallFile = join(tmpDir, 'small.ts');
    writeFileSync(smallFile, 'export const small = 1;\n');
    answerWithFileHistory();

    const result = await fileContextHandler.execute(claudeCodeRead({ file_path: smallFile }));

    expect(result).toEqual({ continue: true, suppressOutput: true });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does nothing when the file changed after its newest observation (#1719)', async () => {
    answerWithFileHistory(Date.now() - 3_600_000);

    const result = await fileContextHandler.execute(claudeCodeRead({ file_path: gatedFile }));

    expect(result).toEqual({ continue: true, suppressOutput: true });
  });

  it('does nothing when the worker call falls back', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((url: string | URL | Request) =>
      Promise.resolve(String(url).includes('/api/observations/by-file')
        ? new Response('unavailable', { status: 503 })
        : makeObservationsResponse([{ id: GATED_OBSERVATION_ID, created_at_epoch: Date.now() + 60_000 }]))
    );

    const result = await fileContextHandler.execute(claudeCodeRead({ file_path: gatedFile }));

    expect(result).toEqual({ continue: true, suppressOutput: true });
  });

  it('does nothing for a subagent Read', async () => {
    answerWithFileHistory();

    const result = await fileContextHandler.execute(claudeCodeRead({ file_path: gatedFile }, { agentId: 'subagent-1' }));

    expect(result).toEqual({ continue: true, suppressOutput: true });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('denies every whole-file Read of a gated file — the dedupe claim opens no free retry', async () => {
    answerWithFileHistory();

    const first = await fileContextHandler.execute(claudeCodeRead({ file_path: gatedFile }));
    const second = await fileContextHandler.execute(claudeCodeRead({ file_path: gatedFile }));

    expect(first.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(second.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(second.hookSpecificOutput?.permissionDecisionReason).toContain('Full-file Read blocked by claude-mem');
  });

  it('does not re-inject the timeline on a targeted Read after a deny (claim recorded by the deny)', async () => {
    answerWithFileHistory();

    const denied = await fileContextHandler.execute(claudeCodeRead({ file_path: gatedFile }));
    const targeted = await fileContextHandler.execute(claudeCodeRead({ file_path: gatedFile, offset: 40, limit: 20 }));
    const targetedInFreshSession = await fileContextHandler.execute(
      claudeCodeRead({ file_path: gatedFile, offset: 40, limit: 20 }, { sessionId: 'sess-read-gate-fresh' })
    );

    expect(denied.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(targeted).toEqual({ continue: true, suppressOutput: true });
    expectContextNotDeny(targetedInFreshSession);
  });

  it('bounds the worker lookup with FILE_CONTEXT_WORKER_BUDGET_MS', async () => {
    answerWithFileHistory();

    await fileContextHandler.execute(claudeCodeRead({ file_path: gatedFile }));

    expect(workerFallbackCalls).toHaveLength(1);
    expect(workerFallbackCalls[0].url).toStartWith('/api/observations/by-file?');
    expect(workerFallbackCalls[0].method).toBe('GET');
    expect(workerFallbackCalls[0].body).toBeUndefined();
    expect(workerFallbackCalls[0].options).toEqual({ timeoutMs: FILE_CONTEXT_WORKER_BUDGET_MS });
  });
});

describe('shouldDenyFullFileRead', () => {
  function wholeFileRead(overrides: Partial<NormalizedHookInput> = {}): NormalizedHookInput {
    return {
      sessionId: 'sess-predicate',
      cwd: tmpDir,
      platform: 'claude-code',
      toolName: 'Read',
      toolInput: { file_path: gatedFile },
      ...overrides,
    };
  }

  // The tree-sitter CLI is installed: an explicit stub, never the machine's install.
  const smartReadAvailable = () => true;

  // History whose lookup stat'ed the file: its size and mtime checks ran.
  const statVerifiedHistory = (absolutePath: string) => ({ absolutePath, fileStatVerified: true });

  it('denies a whole-file Read without counting lines when no limit is set', () => {
    const countTotalLines = mock(() => GATED_FILE_LINE_COUNT);

    expect(shouldDenyFullFileRead(wholeFileRead(), statVerifiedHistory(gatedFile), 'true', countTotalLines, smartReadAvailable)).toBe(true);
    expect(countTotalLines).not.toHaveBeenCalled();
  });

  it('treats an unset setting as on — only an explicit false turns the gate off', () => {
    const countTotalLines = () => GATED_FILE_LINE_COUNT;

    expect(shouldDenyFullFileRead(wholeFileRead(), statVerifiedHistory(gatedFile), undefined, countTotalLines, smartReadAvailable)).toBe(true);
    expect(shouldDenyFullFileRead(wholeFileRead(), statVerifiedHistory(gatedFile), 'false', countTotalLines, smartReadAvailable)).toBe(false);
  });

  it('counts lines only after every cheaper condition holds, and checks smart-read availability after that', () => {
    const countTotalLines = mock(() => GATED_FILE_LINE_COUNT);
    const isSmartReadAvailable = mock(() => true);
    const limited = { file_path: gatedFile, limit: GATED_FILE_LINE_COUNT };
    const notGated: Array<[string, NormalizedHookInput, { absolutePath: string; fileStatVerified: boolean } | null, string | undefined]> = [
      ['codex platform', wholeFileRead({ platform: 'codex', toolInput: limited }), statVerifiedHistory(gatedFile), 'true'],
      ['Qwen Code transcript', wholeFileRead({ transcriptPath: '/home/dot/.qwen/tmp/abc123/chats/session.json', toolInput: limited }), statVerifiedHistory(gatedFile), 'true'],
      ['gate off', wholeFileRead({ toolInput: limited }), statVerifiedHistory(gatedFile), 'false'],
      ['subagent', wholeFileRead({ agentId: 'subagent-1', toolInput: limited }), statVerifiedHistory(gatedFile), 'true'],
      ['Codex filePaths', wholeFileRead({ toolInput: { ...limited, filePaths: [gatedFile] } }), statVerifiedHistory(gatedFile), 'true'],
      ['no history', wholeFileRead({ toolInput: limited }), null, 'true'],
      ['stat failed', wholeFileRead({ toolInput: limited }), { absolutePath: gatedFile, fileStatVerified: false }, 'true'],
      ['markdown', wholeFileRead({ toolInput: limited }), statVerifiedHistory(testFile), 'true'],
      ['outside cwd', wholeFileRead({ cwd: join(tmpDir, 'project'), toolInput: limited }), statVerifiedHistory(gatedFile), 'true'],
      ['offset 40', wholeFileRead({ toolInput: { ...limited, offset: 40 } }), statVerifiedHistory(gatedFile), 'true'],
    ];

    for (const [label, input, fileHistory, setting] of notGated) {
      expect([label, shouldDenyFullFileRead(input, fileHistory, setting, countTotalLines, isSmartReadAvailable)]).toEqual([label, false]);
    }
    expect(countTotalLines).not.toHaveBeenCalled();
    expect(isSmartReadAvailable).not.toHaveBeenCalled();

    expect(shouldDenyFullFileRead(wholeFileRead({ toolInput: { ...limited, limit: GATED_FILE_LINE_COUNT - 1 } }), statVerifiedHistory(gatedFile), 'true', countTotalLines, isSmartReadAvailable)).toBe(false);
    expect(countTotalLines).toHaveBeenCalledTimes(1);
    expect(isSmartReadAvailable).not.toHaveBeenCalled();

    expect(shouldDenyFullFileRead(wholeFileRead({ toolInput: limited }), statVerifiedHistory(gatedFile), 'true', countTotalLines, isSmartReadAvailable)).toBe(true);
    expect(countTotalLines).toHaveBeenCalledTimes(2);
    expect(isSmartReadAvailable).toHaveBeenCalledTimes(1);
  });

  it('never denies when smart_outline cannot parse here (no tree-sitter CLI)', () => {
    const countTotalLines = () => GATED_FILE_LINE_COUNT;
    const smartReadUnavailable = () => false;

    expect(shouldDenyFullFileRead(wholeFileRead(), statVerifiedHistory(gatedFile), 'true', countTotalLines, smartReadUnavailable)).toBe(false);
    expect(shouldDenyFullFileRead(
      wholeFileRead({ toolInput: { file_path: gatedFile, limit: GATED_FILE_LINE_COUNT } }),
      statVerifiedHistory(gatedFile),
      'true',
      countTotalLines,
      smartReadUnavailable,
    )).toBe(false);
  });

  it('treats non-finite or negative offset/limit as absent', () => {
    const countTotalLines = () => GATED_FILE_LINE_COUNT;
    const deny = (toolInput: Record<string, unknown>) =>
      shouldDenyFullFileRead(wholeFileRead({ toolInput: { file_path: gatedFile, ...toolInput } }), statVerifiedHistory(gatedFile), 'true', countTotalLines, smartReadAvailable);

    for (const unusable of [Number.NaN, Number.POSITIVE_INFINITY, -5, 'not-a-number', null]) {
      expect([unusable, deny({ offset: unusable })]).toEqual([unusable, true]);
      expect([unusable, deny({ limit: unusable })]).toEqual([unusable, true]);
    }
  });

  it('reads numeric-string offset/limit as numbers so a targeted Read still passes', () => {
    const countTotalLines = () => GATED_FILE_LINE_COUNT;
    const deny = (toolInput: Record<string, unknown>) =>
      shouldDenyFullFileRead(wholeFileRead({ toolInput: { file_path: gatedFile, ...toolInput } }), statVerifiedHistory(gatedFile), 'true', countTotalLines, smartReadAvailable);

    expect(deny({ offset: '40', limit: '20' })).toBe(false);
    expect(deny({ limit: String(GATED_FILE_LINE_COUNT) })).toBe(true);
  });

  it('fails open when the file cannot be read to count its lines', () => {
    const input = wholeFileRead({ toolInput: { file_path: gatedFile, limit: GATED_FILE_LINE_COUNT } });

    expect(shouldDenyFullFileRead(input, statVerifiedHistory(gatedFile), 'true', () => null, smartReadAvailable)).toBe(false);
  });
});
