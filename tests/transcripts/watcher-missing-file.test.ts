import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdirSync, rmSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import type { TranscriptSchema, WatchTarget } from '../../src/services/transcripts/types.js';
import { logger } from '../../src/utils/logger.js';
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
