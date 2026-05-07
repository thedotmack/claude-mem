
import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync, utimesSync, rmSync } from 'fs';
import { tmpdir, homedir } from 'os';
import { join } from 'path';

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

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'file-context-test-'));
  testFile = join(tmpDir, 'test.md');
  writeFileSync(testFile, PADDING);

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
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

describe('fileContextHandler — #2094 (no Read mutation)', () => {
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
});
