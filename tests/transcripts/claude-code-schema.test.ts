import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { NormalizedHookInput } from '../../src/cli/types.js';
import type { TranscriptSchema, WatchTarget } from '../../src/services/transcripts/types.js';

// Snapshot real modules before mock.module rewrites them process-wide (bun's
// mock.module is global and mock.restore() does not undo it).
import * as realSessionInit from '../../src/cli/handlers/session-init.js';
import * as realWorkerUtils from '../../src/shared/worker-utils.js';
import * as realShared from '../../src/services/worker/http/shared.js';

const realSessionInitSnapshot = { ...realSessionInit };
const realWorkerUtilsSnapshot = { ...realWorkerUtils };
const realSharedSnapshot = { ...realShared };

const sessionInitCalls: NormalizedHookInput[] = [];
const ingestCalls: Array<Record<string, unknown>> = [];
const summarizeCalls: string[] = [];
const observationPosts: Array<Record<string, unknown>> = [];
let inWorkerProcess = true;

mock.module('../../src/cli/handlers/session-init.js', () => ({
  sessionInitHandler: {
    execute: async (input: NormalizedHookInput) => {
      sessionInitCalls.push(input);
      return { continue: true, suppressOutput: true };
    },
  },
}));

mock.module('../../src/shared/worker-utils.js', () => ({
  ensureWorkerRunning: async () => true,
  workerHttpRequest: async (apiPath: string, init?: RequestInit) => {
    if (apiPath === '/api/sessions/summarize') summarizeCalls.push(String(init?.body));
    if (apiPath === '/api/sessions/observations') observationPosts.push(JSON.parse(String(init?.body)));
    return new Response('ok');
  },
}));

mock.module('../../src/services/worker/http/shared.js', () => ({
  hasIngestContext: () => inWorkerProcess,
  ingestObservation: async (payload: Record<string, unknown>) => {
    ingestCalls.push(payload);
    return { ok: true, sessionDbId: 1 };
  },
}));

afterAll(() => {
  mock.module('../../src/cli/handlers/session-init.js', () => realSessionInitSnapshot);
  mock.module('../../src/shared/worker-utils.js', () => realWorkerUtilsSnapshot);
  mock.module('../../src/services/worker/http/shared.js', () => realSharedSnapshot);
});

import { TranscriptEventProcessor } from '../../src/services/transcripts/processor.js';

// Load the real claude-code schema straight from the example config, so the
// test breaks if the shipped schema drifts from what the processor expects.
const exampleConfigPath = join(__dirname, '..', '..', 'transcript-watch.claude-code.example.json');
const exampleConfig = JSON.parse(readFileSync(exampleConfigPath, 'utf-8'));
const schema: TranscriptSchema = exampleConfig.schemas['claude-code'];

const makeWatch = (): WatchTarget => ({
  name: 'claude-code-backfill',
  path: join(tmpdir(), 'claude-projects', '*.jsonl'),
  schema: 'claude-code',
});

const sessionId = 'a1b2c3d4-0000-4000-8000-000000000001';
const cwd = '/home/vova/dev/project';

const userPromptLine = {
  type: 'user',
  sessionId,
  cwd,
  message: { role: 'user', content: 'fix the failing test' },
};

const metaCommandLine = {
  type: 'user',
  sessionId,
  cwd,
  isMeta: true,
  message: { role: 'user', content: '<command-name>compact</command-name>' },
};

const commandWrapperLine = {
  type: 'user',
  sessionId,
  cwd,
  message: { role: 'user', content: '<local-command-stdout>done</local-command-stdout>' },
};

const attachmentLine = {
  type: 'attachment',
  sessionId,
  cwd,
  attachment: { kind: 'file' },
};

const toolUseLine = {
  type: 'assistant',
  sessionId,
  cwd,
  message: {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'toolu_01', name: 'Bash', input: { command: 'echo hi' } }],
  },
};

const toolResultLine = {
  type: 'user',
  sessionId,
  cwd,
  toolUseResult: { stdout: 'hi\n', stderr: '', interrupted: false },
  message: {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: 'hi' }],
  },
};

const turnDurationLine = {
  type: 'system',
  subtype: 'turn_duration',
  sessionId,
  cwd,
  durationMs: 1234,
};

describe('claude-code transcript schema (backfill)', () => {
  let processor: TranscriptEventProcessor;

  beforeEach(() => {
    processor = new TranscriptEventProcessor();
    sessionInitCalls.length = 0;
    ingestCalls.length = 0;
    summarizeCalls.length = 0;
    observationPosts.length = 0;
    inWorkerProcess = true;
  });

  afterEach(() => {
    mock.restore();
  });

  it('maps a real user prompt to session_init', async () => {
    await processor.processEntry(userPromptLine, makeWatch(), schema);
    expect(sessionInitCalls).toHaveLength(1);
    expect(sessionInitCalls[0].prompt).toBe('fix the failing test');
    expect(sessionInitCalls[0].sessionId).toBe(sessionId);
    expect(sessionInitCalls[0].cwd).toBe(cwd);
  });

  it('ignores isMeta command lines and <wrapper> stdout lines', async () => {
    await processor.processEntry(metaCommandLine, makeWatch(), schema);
    await processor.processEntry(commandWrapperLine, makeWatch(), schema);
    expect(sessionInitCalls).toHaveLength(0);
  });

  it('ignores unrelated line types like attachment', async () => {
    await processor.processEntry(attachmentLine, makeWatch(), schema);
    expect(sessionInitCalls).toHaveLength(0);
    expect(ingestCalls).toHaveLength(0);
  });

  it('pairs a tool_use block with its later tool_result block into one observation', async () => {
    const watch = makeWatch();
    await processor.processEntry(toolUseLine, watch, schema);
    expect(ingestCalls).toHaveLength(0); // tool_use alone is pending, no observation yet

    await processor.processEntry(toolResultLine, watch, schema);
    expect(ingestCalls).toHaveLength(1);
    expect(ingestCalls[0].toolName).toBe('Bash');
    expect(ingestCalls[0].toolUseId).toBe('toolu_01');
    expect(ingestCalls[0].toolInput).toEqual({ command: 'echo hi' });
    expect(ingestCalls[0].toolResponse).toEqual({ stdout: 'hi\n', stderr: '', interrupted: false });
  });

  it('posts observations over HTTP when run as the standalone watcher CLI (no in-process ingest context)', async () => {
    inWorkerProcess = false;
    const watch = makeWatch();
    await processor.processEntry(toolUseLine, watch, schema);
    await processor.processEntry(toolResultLine, watch, schema);
    expect(ingestCalls).toHaveLength(0);
    expect(observationPosts).toHaveLength(1);
    expect(observationPosts[0]).toMatchObject({
      contentSessionId: sessionId,
      cwd,
      tool_name: 'Bash',
      tool_use_id: 'toolu_01',
      tool_input: { command: 'echo hi' },
    });
  });

  it('maps turn_duration to session_end and queues a summary', async () => {
    await processor.processEntry(turnDurationLine, makeWatch(), schema);
    expect(summarizeCalls).toHaveLength(1);
    expect(JSON.parse(summarizeCalls[0]).contentSessionId).toBe(sessionId);
  });
});
