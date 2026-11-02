// R5-3: a transcript turn whose session has no known working directory is
// skipped, never keyed to the worker's own directory (process.cwd(), which is
// ~/.claude-mem). Hosts that report the directory once, on the session's first
// line (DeepSeek Harness), keep it across a watcher restart through the watch
// state, and the summarize request carries it for the worker's exclusion check.
import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { zstdCompressSync } from 'node:zlib';
import type { NormalizedHookInput } from '../../src/cli/types.js';
import type { TranscriptSchema, WatchTarget } from '../../src/services/transcripts/types.js';
import * as realSessionInit from '../../src/cli/handlers/session-init.js';
import * as realFileEdit from '../../src/cli/handlers/file-edit.js';
import * as realIngest from '../../src/services/worker/http/shared.js';
import * as realWorkerUtils from '../../src/shared/worker-utils.js';

const realSessionInitSnapshot = { ...realSessionInit };
const realFileEditSnapshot = { ...realFileEdit };
const realIngestSnapshot = { ...realIngest };
const realWorkerUtilsSnapshot = { ...realWorkerUtils };

const inits: Array<{ prompt?: string; cwd?: string }> = [];
const observations: Array<{ toolName: string; cwd?: string }> = [];
const fileEdits: Array<{ cwd?: string }> = [];
const summarizeBodies: Array<Record<string, unknown>> = [];
const capturedSessionIds: Array<string | undefined> = [];
const ingested: Array<Record<string, unknown>> = [];
const captureOrder: string[] = [];

const fakeSessionInit = async (input: NormalizedHookInput) => {
  inits.push({ prompt: input.prompt, cwd: input.cwd });
  capturedSessionIds.push(input.sessionId);
  captureOrder.push('prompt');
  return { continue: true, suppressOutput: true };
};
mock.module('../../src/cli/handlers/session-init.js', () => ({
  ...realSessionInitSnapshot,
  sessionInitHandler: { execute: fakeSessionInit },
  recordSessionPrompt: fakeSessionInit,
}));
mock.module('../../src/cli/handlers/file-edit.js', () => ({
  ...realFileEditSnapshot,
  fileEditHandler: {
    execute: async (input: NormalizedHookInput) => {
      fileEdits.push({ cwd: input.cwd });
      return { continue: true, suppressOutput: true };
    },
  },
}));
mock.module('../../src/services/worker/http/shared.js', () => ({
  ...realIngestSnapshot,
  ingestObservation: async (payload: { toolName: string; cwd?: string }) => {
    observations.push({ toolName: payload.toolName, cwd: payload.cwd });
    ingested.push({ ...payload });
    captureOrder.push('observation');
    return { ok: true };
  },
}));
mock.module('../../src/shared/worker-utils.js', () => ({
  ...realWorkerUtilsSnapshot,
  ensureWorkerRunning: async () => true,
  workerHttpRequest: async (apiPath: string, init?: { body?: string }) => {
    if (apiPath === '/api/sessions/summarize' && init?.body) summarizeBodies.push(JSON.parse(init.body));
    return new Response('{}');
  },
}));

afterAll(() => {
  mock.module('../../src/cli/handlers/session-init.js', () => realSessionInitSnapshot);
  mock.module('../../src/cli/handlers/file-edit.js', () => realFileEditSnapshot);
  mock.module('../../src/services/worker/http/shared.js', () => realIngestSnapshot);
  mock.module('../../src/shared/worker-utils.js', () => realWorkerUtilsSnapshot);
});

import { logger } from '../../src/utils/logger.js';
import { TranscriptEventProcessor } from '../../src/services/transcripts/processor.js';
import { TranscriptWatcher } from '../../src/services/transcripts/watcher.js';

// DeepSeek Harness shape: the working directory is on the session's first line only.
const schema: TranscriptSchema = {
  name: 'dsh-cwd-test',
  sessionIdPath: 'session',
  events: [
    { name: 'session-meta', match: { path: 'type', equals: 'session' }, action: 'session_context', fields: { cwd: 'cwd' } },
    { name: 'user-message', match: { path: 'type', equals: 'user' }, action: 'session_init', fields: { prompt: 'text' } },
    { name: 'tool', match: { path: 'type', equals: 'tool' }, action: 'tool_use', fields: { toolName: 'name', toolResponse: 'output' } },
    { name: 'edit', match: { path: 'type', equals: 'edit' }, action: 'file_edit', fields: { filePath: 'file' } },
    { name: 'end', match: { path: 'type', equals: 'end' }, action: 'session_end' },
  ],
};

const PROJECT_DIR = '/tmp/dsh-cwd-project';
const sessionLine = (session: string) => ({ type: 'session', session, cwd: PROJECT_DIR });
const userLine = (session: string, text: string) => ({ type: 'user', session, text });
const toolLine = (session: string) => ({ type: 'tool', session, name: 'Bash', output: 'ok' });
const editLine = (session: string) => ({ type: 'edit', session, file: 'src/a.ts' });
const endLine = (session: string) => ({ type: 'end', session });

describe('transcript turns need a known working directory (R5-3)', () => {
  let loggerSpies: ReturnType<typeof spyOn>[] = [];
  let tmpRoot: string;
  const watchers: TranscriptWatcher[] = [];

  beforeEach(() => {
    inits.length = 0;
    observations.length = 0;
    fileEdits.length = 0;
    summarizeBodies.length = 0;
    capturedSessionIds.length = 0;
    ingested.length = 0;
    captureOrder.length = 0;
    tmpRoot = join(tmpdir(), `claude-mem-session-cwd-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(tmpRoot, { recursive: true });
    loggerSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
    ];
  });

  afterEach(() => {
    for (const watcher of watchers.splice(0)) watcher.stop();
    loggerSpies.forEach(spy => spy.mockRestore());
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('skips turns until the session reports a directory, then sends them with it', async () => {
    const processor = new TranscriptEventProcessor();
    const watch: WatchTarget = { name: 'dsh', path: join(tmpRoot, '*.jsonl'), schema };

    await processor.processEntry(userLine('s1', 'before the directory is known'), watch, schema);
    await processor.processEntry(toolLine('s1'), watch, schema);
    await processor.processEntry(editLine('s1'), watch, schema);
    expect(inits).toEqual([]);
    expect(observations).toEqual([]);
    expect(fileEdits).toEqual([]);

    await processor.processEntry(sessionLine('s1'), watch, schema);
    await processor.processEntry(userLine('s1', 'after'), watch, schema);
    await processor.processEntry(toolLine('s1'), watch, schema);
    await processor.processEntry(editLine('s1'), watch, schema);
    expect(inits).toEqual([{ prompt: 'after', cwd: PROJECT_DIR }]);
    expect(observations).toEqual([{ toolName: 'Bash', cwd: PROJECT_DIR }]);
    expect(fileEdits).toEqual([{ cwd: PROJECT_DIR }]);
  });

  it('uses the fresh path fallback for headerless captures after replacing a native-session transcript', async () => {
    const processor = new TranscriptEventProcessor();
    const file = {};
    const watch: WatchTarget = { name: 'dsh', path: join(tmpRoot, 'replacement.jsonl'), schema, workspace: PROJECT_DIR };

    await processor.processEntry(sessionLine('retired-native-session'), watch, schema, 'old-path-fallback', file);
    await processor.processEntry({ type: 'user', text: 'old native turn' }, watch, schema, 'old-path-fallback', file);
    await processor.processEntry({ type: 'tool', name: 'Bash', output: 'old result' }, watch, schema, 'old-path-fallback', file);
    expect(capturedSessionIds).toEqual(['retired-native-session']);
    expect(ingested.map(payload => payload.contentSessionId)).toEqual(['retired-native-session']);

    processor.resetFileContext(file);
    await processor.processEntry({ type: 'user', text: 'replacement turn' }, watch, schema, 'fresh-path-fallback', file);
    await processor.processEntry({ type: 'tool', name: 'Bash', output: 'replacement result' }, watch, schema, 'fresh-path-fallback', file);

    expect(capturedSessionIds).toEqual(['retired-native-session', 'fresh-path-fallback']);
    expect(ingested.map(payload => [payload.contentSessionId, payload.toolResponse])).toEqual([
      ['retired-native-session', 'old result'],
      ['fresh-path-fallback', 'replacement result'],
    ]);
    expect(captureOrder).toEqual(['prompt', 'observation', 'prompt', 'observation']);
  });

  it('skips headerless captures without a path fallback after replacing a native-session transcript', async () => {
    const processor = new TranscriptEventProcessor();
    const file = {};
    const watch: WatchTarget = { name: 'dsh', path: join(tmpRoot, 'replacement.jsonl'), schema, workspace: PROJECT_DIR };

    await processor.processEntry(sessionLine('retired-native-session'), watch, schema, 'old-path-fallback', file);
    await processor.processEntry({ type: 'user', text: 'old native turn' }, watch, schema, 'old-path-fallback', file);
    await processor.processEntry({ type: 'tool', name: 'Bash', output: 'old result' }, watch, schema, 'old-path-fallback', file);
    expect(capturedSessionIds).toEqual(['retired-native-session']);
    expect(ingested.map(payload => payload.contentSessionId)).toEqual(['retired-native-session']);

    processor.resetFileContext(file);
    await processor.processEntry({ type: 'user', text: 'replacement without identity' }, watch, schema, undefined, file);
    await processor.processEntry({ type: 'tool', name: 'Bash', output: 'replacement without identity' }, watch, schema, undefined, file);

    expect(capturedSessionIds).toEqual(['retired-native-session']);
    expect(ingested.map(payload => [payload.contentSessionId, payload.toolResponse])).toEqual([
      ['retired-native-session', 'old result'],
    ]);
    expect(captureOrder).toEqual(['prompt', 'observation']);
  });

  it('sends the session directory with the summarize request only when it is known', async () => {
    const processor = new TranscriptEventProcessor();
    const watch: WatchTarget = { name: 'dsh', path: join(tmpRoot, '*.jsonl'), schema };

    await processor.processEntry(endLine('no-cwd'), watch, schema);
    await processor.processEntry(sessionLine('with-cwd'), watch, schema);
    await processor.processEntry(endLine('with-cwd'), watch, schema);

    expect(summarizeBodies.map(body => body.cwd)).toEqual([undefined, PROJECT_DIR]);
    expect('cwd' in summarizeBodies[0]).toBe(false);
  });

  for (const format of ['jsonl', 'jsonl.zstd'] as const) {
    it(`learns an active session's directory from its first line when it starts at EOF (${format})`, async () => {
      const filePath = join(tmpRoot, `session.${format}`);
      const statePath = join(tmpRoot, 'state.json');
      const encode = (entries: unknown[]): Buffer => {
        const text = entries.map(entry => `${JSON.stringify(entry)}\n`).join('');
        return format === 'jsonl' ? Buffer.from(text) : zstdCompressSync(Buffer.from(text));
      };
      writeFileSync(filePath, Buffer.concat([encode([sessionLine('s3')]), encode([userLine('s3', 'before startup')])]));

      const watch: WatchTarget = { name: 'dsh', path: join(tmpRoot, `*.${format}`), schema, startAtEnd: true };
      const watcher = new TranscriptWatcher({ version: 1, watches: [watch] }, statePath);
      watchers.push(watcher);
      await watcher.start();
      appendFileSync(filePath, encode([userLine('s3', 'live turn')]));
      (watcher as any).tailers.get(filePath)?.poke();
      await new Promise(resolve => setTimeout(resolve, 120));

      expect(inits).toEqual([{ prompt: 'live turn', cwd: PROJECT_DIR }]);
    });
  }

  it('keeps a file\'s session directory across a watcher restart', async () => {
    const filePath = join(tmpRoot, 'session.jsonl');
    const statePath = join(tmpRoot, 'state.json');
    const watch: WatchTarget = { name: 'dsh', path: filePath, schema };
    writeFileSync(filePath, `${JSON.stringify(sessionLine('s2'))}\n${JSON.stringify(userLine('s2', 'first'))}\n`);

    const first = new TranscriptWatcher({ version: 1, watches: [] }, statePath);
    watchers.push(first);
    await (first as any).addTailer(filePath, watch, schema);
    await new Promise(resolve => setTimeout(resolve, 80));
    first.stop();
    expect(JSON.parse(readFileSync(statePath, 'utf8')).cwds[filePath]).toBe(PROJECT_DIR);

    // The restarted watcher resumes after the line that carried the directory.
    appendFileSync(filePath, `${JSON.stringify(userLine('s2', 'after the restart'))}\n`);
    const restarted = new TranscriptWatcher({ version: 1, watches: [] }, statePath);
    watchers.push(restarted);
    await (restarted as any).addTailer(filePath, watch, schema);
    await new Promise(resolve => setTimeout(resolve, 80));

    expect(inits).toEqual([
      { prompt: 'first', cwd: PROJECT_DIR },
      { prompt: 'after the restart', cwd: PROJECT_DIR },
    ]);
  });

  for (const format of ['jsonl', 'jsonl.zstd'] as const) {
    it(`captures current and legacy DSH results under the header identity across restart (${format})`, async () => {
      const nativeSchema = JSON.parse(readFileSync(join(__dirname, '../../dsh/transcript-schema.json'), 'utf8')) as TranscriptSchema;
      // Current DSH names the file v4, and headless sessions need not be UUIDs.
      const sessionId = 'session-42';
      const filePath = join(tmpRoot, `v4.${format}`);
      const statePath = join(tmpRoot, 'native-state.json');
      const watch: WatchTarget = { name: 'dsh', path: filePath, schema: nativeSchema };
      const encode = (entries: unknown[]): Buffer => {
        const text = entries.map(entry => JSON.stringify(entry) + '\n').join('');
        return format === 'jsonl' ? Buffer.from(text) : zstdCompressSync(Buffer.from(text));
      };
      const turn = (callId: string, legacy: boolean) => [
        { type: 'user/message', data: { source: { kind: 'plugin:claude-mem' }, content: [{ type: 'text', text: 'Injected memory' }] } },
        { type: 'user/message', data: { source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'Host policy' }] } },
        { type: 'user/message', data: { source: { kind: 'skill-catalog' }, content: [{ type: 'text', text: 'Available skills' }] } },
        { type: 'user/message', data: { content: [{ type: 'text', text: 'Read the file' }, { type: 'text', text: 'and report it' }] } },
        { type: 'tool/call', data: { callId, name: 'read_file', arguments: { path: 'probe.txt' } } },
        { type: 'tool/result', data: { message: legacy
          ? { content: [{ type: 'tool_result', toolCallId: callId, content: [{ type: 'text', text: 'legacy result' }] }] }
          : { toolCallId: callId, content: [{ type: 'text', text: 'current result' }] } } },
        { type: 'tool/call', data: { callId: 'memory-' + callId, name: 'mem_search', arguments: { query: 'recall' } } },
        { type: 'tool/result', data: { message: { toolCallId: 'memory-' + callId, content: [{ type: 'text', text: 'Recalled memory' }] } } },
        { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Done' }] } } },
        { type: 'turn/end', data: { turn: legacy ? 2 : 1, reason: 'completed' } },
      ];
      writeFileSync(filePath, encode([{ type: 'session', id: sessionId, cwd: PROJECT_DIR }, ...turn('call-current', false)]));
      const first = new TranscriptWatcher({ version: 1, watches: [] }, statePath);
      watchers.push(first);
      await (first as any).addTailer(filePath, watch, nativeSchema);
      await new Promise(resolve => setTimeout(resolve, 100));
      first.stop();
      expect(JSON.parse(readFileSync(statePath, 'utf8')).cwds[filePath]).toBe(PROJECT_DIR);

      appendFileSync(filePath, encode(turn('call-legacy', true)));
      const restarted = new TranscriptWatcher({ version: 1, watches: [] }, statePath);
      watchers.push(restarted);
      await (restarted as any).addTailer(filePath, watch, nativeSchema);
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(capturedSessionIds).toEqual([sessionId, sessionId]);
      expect(inits.map(input => input.prompt)).toEqual(['Read the file\nand report it', 'Read the file\nand report it']);
      expect(captureOrder).toEqual(['prompt', 'observation', 'prompt', 'observation']);
      expect(ingested.map(payload => [payload.contentSessionId, payload.toolUseId, payload.toolResponse])).toEqual([
        [sessionId, 'call-current', [{ type: 'text', text: 'current result' }]],
        [sessionId, 'call-legacy', [{ type: 'text', text: 'legacy result' }]],
      ]);
      expect(summarizeBodies.map(body => [body.contentSessionId, body.cwd, body.last_assistant_message])).toEqual([
        [sessionId, PROJECT_DIR, 'Done'], [sessionId, PROJECT_DIR, 'Done'],
      ]);
    });
  }
});
