
import { describe, it, expect, beforeEach, afterEach, afterAll, spyOn, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, writeFileSync, utimesSync, rmSync } from 'fs';
import { tmpdir, homedir } from 'os';
import { join } from 'path';
import { resolveDbPath } from '../../src/shared/paths.js';

// Capture the REAL modules BEFORE mocking so afterAll can restore them.
// bun's `mock.module` is process-global and sticky; `mock.restore()` does NOT
// undo it, so we must explicitly re-register the real implementations to keep
// the suite order-independent (otherwise these mocks leak into later files).
import * as realSettingsDefaultsManager from '../../src/shared/SettingsDefaultsManager.js';
import * as realWorkerUtils from '../../src/shared/worker-utils.js';
import * as realProjectName from '../../src/utils/project-name.js';
import * as realProjectFilter from '../../src/utils/project-filter.js';

// Snapshot the real exports into plain objects NOW, before mock.module mutates
// the live ESM namespace bindings. These snapshots are re-registered in afterAll.
const realSettingsSnapshot = { ...realSettingsDefaultsManager };
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
    loadFromFile: () => ({ CLAUDE_MEM_EXCLUDED_PROJECTS: [] }),
  },
}));

mock.module('../../src/shared/worker-utils.js', () => ({
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

import { fileContextHandler } from '../../src/cli/handlers/file-context.js';
import { claimFileContextInjection } from '../../src/cli/handlers/file-context-dedupe.js';
import { logger } from '../../src/utils/logger.js';

const PADDING = 'x'.repeat(2_000); 

let tmpDir: string;
let testFile: string;
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
  mock.module('../../src/shared/worker-utils.js', () => realWorkerUtilsSnapshot);
  mock.module('../../src/utils/project-name.js', () => realProjectNameSnapshot);
  mock.module('../../src/utils/project-filter.js', () => realProjectFilterSnapshot);
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
