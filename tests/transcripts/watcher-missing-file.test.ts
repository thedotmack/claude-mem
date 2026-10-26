import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import * as fs from 'fs';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join, relative, resolve } from 'path';
import type { TranscriptSchema, WatchTarget } from '../../src/services/transcripts/types.js';
import { logger } from '../../src/utils/logger.js';
import { fileEditHandler } from '../../src/cli/handlers/file-edit.js';
import { TranscriptWatcher } from '../../src/services/transcripts/watcher.js';

const schema: TranscriptSchema = {
  name: 'codex-test',
  events: [
    {
      name: 'user-message',
      match: { path: 'payload.type', equals: 'user_message' },
      action: 'session_init',
      fields: {
        sessionId: 'payload.session_id',
        prompt: 'payload.message',
      },
    },
  ],
};

describe('TranscriptWatcher missing files', () => {
  let tmpRoot: string;
  let loggerSpies: ReturnType<typeof spyOn>[] = [];

  beforeEach(() => {
    tmpRoot = join(tmpdir(), `claude-mem-transcript-missing-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(tmpRoot, { recursive: true });
    loggerSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
    ];
  });

  afterEach(() => {
    loggerSpies.forEach(spy => spy.mockRestore());
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('does not reject when a file vanishes before the watch is attached', async () => {
    const missingPath = join(tmpRoot, 'gone.jsonl');
    const watch: WatchTarget = { name: 'codex', path: join(tmpRoot, '*.jsonl'), schema };
    const watcher = new TranscriptWatcher({ version: 1, watches: [watch] }, join(tmpRoot, 'state.json'));

    // fs.watch throws ENOENT synchronously for a path that is already gone.
    // The tailer must swallow that error instead of rejecting.
    await expect((watcher as any).addTailer(missingPath, watch, schema)).resolves.toBeUndefined();
    watcher.stop();
  });

  for (const glob of [false, true]) for (const relativePath of [false, true]) {
    it(`discovers a ${relativePath ? 'relative' : 'absolute'} ${glob ? 'glob' : 'literal'} transcript created under initially missing directories`, async () => {
      const target = join(tmpRoot, 'future', 'sessions', 'wanted.jsonl');
      const captured: unknown[] = [];
      const capture = spyOn(fileEditHandler, 'execute').mockImplementation(async input => {
        captured.push(input);
        return { continue: true, suppressOutput: true };
      });
      const captureSchema: TranscriptSchema = { name: 'capture', sessionIdPath: 'session', events: [
        { name: 'edit', match: { path: 'type', equals: 'edit' }, action: 'file_edit', fields: { filePath: 'path' } },
      ] };
      const pattern = glob ? join(tmpRoot, 'future', 'sessions', '*.jsonl') : target;
      const watch: WatchTarget = { name: 'codex', path: relativePath ? relative(process.cwd(), pattern) : pattern, workspace: tmpRoot, schema: captureSchema };
      const watcher = new TranscriptWatcher({ version: 1, watches: [watch] }, join(tmpRoot, 'state.json'));
      try {
        await watcher.start();
        mkdirSync(join(tmpRoot, 'future', 'sessions'), { recursive: true });
        writeFileSync(join(tmpRoot, 'unrelated.jsonl'), '{}\n');
        writeFileSync(target, JSON.stringify({ session: 'wanted', type: 'edit', path: 'wanted.ts' }) + '\n');
        const deadline = Date.now() + 5000;
        while (captured.length === 0 && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        expect(captured).toEqual([expect.objectContaining({ sessionId: 'wanted', filePath: 'wanted.ts', cwd: tmpRoot })]);
        expect(Array.from((watcher as any).tailers.keys() as Iterable<string>).some(path => resolve(path) === target)).toBe(true);
        expect((watcher as any).tailers.has(join(tmpRoot, 'unrelated.jsonl'))).toBe(false);
      } finally { watcher.stop(); capture.mockRestore(); }
    });

  }


  it('filters unrelated ancestor events before scanning a missing literal prefix', async () => {
    const target = join(tmpRoot, 'future', 'sessions', '*.jsonl');
    const watch: WatchTarget = { name: 'codex', path: target, schema };
    const watcher = new TranscriptWatcher({ version: 1, watches: [watch] }, join(tmpRoot, 'state.json'));
    const scan = spyOn(watcher as any, 'resolveWatchFiles');
    try {
      (watcher as any).handleRootWatchEvent(tmpRoot, target, watch, schema, 'sibling/noise.jsonl');
      expect(scan).not.toHaveBeenCalled();
      (watcher as any).handleRootWatchEvent(tmpRoot, target, watch, schema, 'future');
      expect(scan).toHaveBeenCalledTimes(1);
      (watcher as any).handleRootWatchEvent(tmpRoot, target, watch, schema, 'future/sessions/wanted.jsonl');
      expect(scan).toHaveBeenCalledTimes(2);
    } finally { watcher.stop(); scan.mockRestore(); }
  });

  it('watches a missing prefix from its closest existing directory, non-recursively, until the prefix exists', async () => {
    const watchSpy = spyOn(fs, 'watch');
    // Root watches pass `recursive`; a file tailer's own watch does not.
    const rootWatches = () => watchSpy.mock.calls
      .filter(([, options]) => typeof options === 'object' && options !== null && 'recursive' in options)
      .map(([path, options]) => [resolve(String(path)), (options as { recursive: boolean }).recursive]);
    const waitForRootWatches = async (count: number) => {
      const deadline = Date.now() + 5000;
      while (rootWatches().length < count && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
    };
    const prefix = join(tmpRoot, 'missing', 'sessions');
    const watch: WatchTarget = { name: 'codex', path: join(prefix, '**', '*.jsonl'), schema };
    const watcher = new TranscriptWatcher({ version: 1, watches: [watch] }, join(tmpRoot, 'state.json'));
    try {
      await watcher.start();
      // A recursive watch here would cover every sibling tree (the home
      // directory, for a tool that is not installed yet).
      expect(rootWatches()).toEqual([[tmpRoot, false]]);

      mkdirSync(join(tmpRoot, 'missing'));
      await waitForRootWatches(2);
      expect(rootWatches()[1]).toEqual([join(tmpRoot, 'missing'), false]);

      mkdirSync(prefix);
      await waitForRootWatches(3);
      expect(rootWatches()[2]).toEqual([prefix, true]);
      // Each move closes the watch it replaces.
      expect((watcher as any).rootWatchers).toHaveLength(1);
    } finally { watcher.stop(); watchSpy.mockRestore(); }
  });

  it('ignores events on a missing prefix\'s ancestor that are off the path to it', () => {
    const target = join(tmpRoot, 'future', 'sessions', '*.jsonl');
    const watch: WatchTarget = { name: 'codex', path: target, schema };
    const watcher = new TranscriptWatcher({ version: 1, watches: [watch] }, join(tmpRoot, 'state.json'));
    const select = spyOn(watcher as any, 'selectWatchRoot');
    const ancestorWatcher = { close: () => {} };
    (watcher as any).rootWatchers.push(ancestorWatcher);
    try {
      (watcher as any).handleAncestorWatchEvent(ancestorWatcher, tmpRoot, target, watch, schema, 'sibling.jsonl');
      expect(select).not.toHaveBeenCalled();
      (watcher as any).handleAncestorWatchEvent(ancestorWatcher, tmpRoot, target, watch, schema, 'future');
      expect(select).toHaveBeenCalledTimes(1);
    } finally { watcher.stop(); select.mockRestore(); }
  });

  it('does not broaden a missing absolute prefix to a filesystem-root watch', async () => {
    const watch: WatchTarget = {
      name: 'codex',
      path: `/cm-missing-${Date.now()}-${Math.random().toString(16).slice(2)}/sessions/*.jsonl`,
      schema,
    };
    const watcher = new TranscriptWatcher({ version: 1, watches: [watch] }, join(tmpRoot, 'state.json'));
    try {
      await watcher.start();
      expect((watcher as any).rootWatchers).toHaveLength(0);
    } finally { watcher.stop(); }
  });

  it('expands a leading tilde before creating the tailer', async () => {
    const tildePath = '~/.claude/sessions/38824.json';
    const expandedPath = join(homedir(), '.claude/sessions/38824.json');
    const watch: WatchTarget = { name: 'codex', path: '~/.claude/sessions/*.json', schema };
    const watcher = new TranscriptWatcher({ version: 1, watches: [watch] }, join(tmpRoot, 'state.json'));

    await (watcher as any).addTailer(tildePath, watch, schema);

    expect((watcher as any).tailers.has(expandedPath)).toBe(true);
    expect((watcher as any).tailers.has(tildePath)).toBe(false);
    watcher.stop();
  });
});
