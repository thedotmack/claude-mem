// SPDX-License-Identifier: Apache-2.0
//
// OpenDuet's chats copied whole into claude-mem: the local chat store on one side, claude-mem's own
// chat transcript routes (src/services/transcript-mirror) on the other, both real.
// Run: bun test examples/openduet-endless/local-chats

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import type { Server as HttpServer } from 'http';
import { tmpdir } from 'os';
import { join } from 'path';
import express from 'express';
import { TranscriptMirror } from '../../../src/services/transcript-mirror/TranscriptMirror.js';
import { TranscriptMirrorRoutes } from '../../../src/services/worker/http/routes/TranscriptMirrorRoutes.js';
import { createClaudeMemMirror } from './mirror.js';
import { createLocalChats } from './server.js';
import { ChatStore } from './store.js';

const KEY = 'local-test-key-0123456789abcdef';

let dir: string;
let claudeMem: HttpServer | null = null;
let claudeMemUrl = '';

async function startClaudeMem(port = 0): Promise<void> {
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  new TranscriptMirrorRoutes(new TranscriptMirror(join(dir, 'claude-mem', 'chat-transcripts'))).setupRoutes(app);
  await new Promise<void>((resolve) => {
    claudeMem = app.listen(port, '127.0.0.1', () => {
      const address = claudeMem!.address();
      if (address && typeof address !== 'string') claudeMemUrl = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
}

async function stopClaudeMem(): Promise<void> {
  await new Promise<void>((resolve) => (claudeMem ? claudeMem.close(() => resolve()) : resolve()));
  claudeMem = null;
}

const kept = async (threadId: string) => {
  const response = await fetch(`${claudeMemUrl}/api/chat-transcripts/openduet/${threadId}`);
  return response.status === 200 ? ((await response.json()) as { title: string | null; messageCount: number; lines: any[] }) : null;
};

let seq = 0;
const add = (store: ChatStore, threadId: string, runId: string, payload: Record<string, unknown>) =>
  store.appendEvent(threadId, runId, `evt-${++seq}`, payload);

function fullRun(store: ChatStore, threadId: string, runId: string, userId: string, question: string, answer: string) {
  add(store, threadId, runId, { type: 'RUN_STARTED', input: { messages: [{ id: userId, role: 'user', content: question }] } });
  add(store, threadId, runId, { type: 'TOOL_CALL_START', toolCallId: `${runId}-c1`, toolCallName: 'search_mail', parentMessageId: `${runId}-a1` });
  add(store, threadId, runId, { type: 'TOOL_CALL_ARGS', toolCallId: `${runId}-c1`, delta: '{"q":"dentist"}' });
  add(store, threadId, runId, { type: 'TOOL_CALL_END', toolCallId: `${runId}-c1` });
  add(store, threadId, runId, { type: 'TOOL_CALL_RESULT', messageId: `${runId}-t1`, toolCallId: `${runId}-c1`, content: '{"found":1}' });
  add(store, threadId, runId, { type: 'TEXT_MESSAGE_START', messageId: `${runId}-a2`, role: 'assistant' });
  add(store, threadId, runId, { type: 'TEXT_MESSAGE_CONTENT', messageId: `${runId}-a2`, delta: answer });
  add(store, threadId, runId, { type: 'TEXT_MESSAGE_END', messageId: `${runId}-a2` });
  add(store, threadId, runId, { type: 'RUN_FINISHED' });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'openduet-mirror-'));
  await startClaudeMem();
});

afterEach(async () => {
  await stopClaudeMem();
  rmSync(dir, { recursive: true, force: true });
});

describe('chat mirror into claude-mem', () => {
  test('a finished run is kept whole: question, tool call, tool result and answer', async () => {
    const store = new ChatStore(join(dir, 'chats.db'));
    store.createThread({ id: 't1', userId: 'u', agentId: 'openduet', name: 'Dentist' });
    fullRun(store, 't1', 'r1', 'u1', 'When is the dentist?', 'Tuesday at 9.');
    const mirror = createClaudeMemMirror({ store, workerUrl: claudeMemUrl, catchUpIntervalMs: 0 });

    expect(await mirror.catchUp()).toMatchObject({ threads: 1, appended: 4, failed: 0 });
    const transcript = (await kept('t1'))!;
    expect(transcript.title).toBe('Dentist');
    expect(transcript.lines.map((line) => [line.role, line.message.content.map((part: any) => part.type)])).toEqual([
      ['user', ['text']],
      ['assistant', ['tool_use']],
      ['tool', ['tool_result']],
      ['assistant', ['text']],
    ]);
    expect(transcript.lines[1].message.content[0]).toMatchObject({ name: 'search_mail', input: { q: 'dentist' } });
    expect(transcript.lines[2].message.content[0]).toMatchObject({ tool_use_id: 'r1-c1', result: { found: 1 } });
    expect(transcript.lines[3].message.content[0].text).toBe('Tuesday at 9.');

    // Nothing new: nothing is sent again.
    expect(await mirror.catchUp()).toMatchObject({ threads: 0, appended: 0 });
    mirror.stop();
    store.close();
  });

  test('a reply still streaming is not kept until its run finishes, and then it is kept in full', async () => {
    const store = new ChatStore(join(dir, 'chats.db'));
    store.createThread({ id: 't1', userId: 'u', agentId: 'openduet' });
    fullRun(store, 't1', 'r1', 'u1', 'first', 'one');
    add(store, 't1', 'r2', { type: 'RUN_STARTED', input: { messages: [{ id: 'u2', role: 'user', content: 'second' }] } });
    add(store, 't1', 'r2', { type: 'TEXT_MESSAGE_START', messageId: 'r2-a2', role: 'assistant' });
    add(store, 't1', 'r2', { type: 'TEXT_MESSAGE_CONTENT', messageId: 'r2-a2', delta: 'half of' });
    const mirror = createClaudeMemMirror({ store, workerUrl: claudeMemUrl, catchUpIntervalMs: 0 });

    await mirror.catchUp();
    expect((await kept('t1'))!.lines.map((line) => line.id)).toEqual(['u1', 'r1-a1', 'r1-t1', 'r1-a2']);

    add(store, 't1', 'r2', { type: 'TEXT_MESSAGE_CONTENT', messageId: 'r2-a2', delta: ' the answer' });
    add(store, 't1', 'r2', { type: 'TEXT_MESSAGE_END', messageId: 'r2-a2' });
    add(store, 't1', 'r2', { type: 'RUN_FINISHED' });
    await mirror.catchUp();
    const lines = (await kept('t1'))!.lines;
    expect(lines.map((line) => line.id)).toEqual(['u1', 'r1-a1', 'r1-t1', 'r1-a2', 'u2', 'r2-a2']);
    expect(lines.at(-1).message.content[0].text).toBe('half of the answer');
    mirror.stop();
    store.close();
  });

  test('chats from while claude-mem was down are caught up once it is back', async () => {
    const store = new ChatStore(join(dir, 'chats.db'));
    store.createThread({ id: 't1', userId: 'u', agentId: 'openduet' });
    fullRun(store, 't1', 'r1', 'u1', 'q', 'a');
    const port = Number(new URL(claudeMemUrl).port);
    await stopClaudeMem();
    const lines: string[] = [];
    const mirror = createClaudeMemMirror({ store, workerUrl: `http://127.0.0.1:${port}`, catchUpIntervalMs: 0, log: (line) => lines.push(line) });

    expect(await mirror.catchUp()).toMatchObject({ threads: 1, failed: 1, appended: 0 });
    expect(lines.join('\n')).toContain('will retry');

    await startClaudeMem(port);
    expect(await mirror.catchUp()).toMatchObject({ threads: 1, failed: 0, appended: 4 });
    mirror.stop();
    store.close();
  });

  test('a thread claude-mem refuses does not hold up the others', async () => {
    const store = new ChatStore(join(dir, 'chats.db'));
    store.createThread({ id: 'first', userId: 'u', agentId: 'openduet' });
    fullRun(store, 'first', 'r1', 'u1', 'q', 'a');
    const mirror = createClaudeMemMirror({ store, workerUrl: claudeMemUrl, catchUpIntervalMs: 0 });
    await mirror.catchUp();
    // Someone edits the kept file by hand; claude-mem then refuses to add to it.
    appendFileSync(new TranscriptMirror(join(dir, 'claude-mem', 'chat-transcripts')).jsonlPathFor('openduet', 'first'), 'edited by hand\n');
    fullRun(store, 'first', 'r2', 'u2', 'q2', 'a2');
    await new Promise((resolve) => setTimeout(resolve, 5));
    store.createThread({ id: 'second', userId: 'u', agentId: 'openduet' });
    fullRun(store, 'second', 'r3', 'u3', 'q3', 'a3');
    expect(await mirror.catchUp()).toMatchObject({ threads: 2, failed: 1, appended: 4 });
    expect((await kept('second'))!.messageCount).toBe(4);
    mirror.stop();
    store.close();
  });

  test('a rename reaches claude-mem without sending anything twice', async () => {
    const store = new ChatStore(join(dir, 'chats.db'));
    store.createThread({ id: 't1', userId: 'u', agentId: 'openduet', name: 'Untitled' });
    fullRun(store, 't1', 'r1', 'u1', 'q', 'a');
    const mirror = createClaudeMemMirror({ store, workerUrl: claudeMemUrl, catchUpIntervalMs: 0 });
    await mirror.catchUp();
    await new Promise((resolve) => setTimeout(resolve, 5));
    store.updateThread('t1', { name: 'Trip to Oslo' });
    expect(await mirror.catchUp()).toMatchObject({ threads: 1, appended: 0 });
    expect(await kept('t1')).toMatchObject({ title: 'Trip to Oslo', messageCount: 4 });
    mirror.stop();
    store.close();
  });

  test('a rename made while the thread is being sent is not lost', async () => {
    const store = new ChatStore(join(dir, 'chats.db'));
    store.createThread({ id: 't1', userId: 'u', agentId: 'openduet', name: 'Untitled' });
    fullRun(store, 't1', 'r1', 'u1', 'q', 'a');
    await new Promise((resolve) => setTimeout(resolve, 5));
    let renamed = false;
    const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      if (!renamed) {
        renamed = true;
        store.updateThread('t1', { name: 'Trip to Oslo' });
      }
      return fetch(input, init);
    }) as typeof fetch;
    const mirror = createClaudeMemMirror({ store, workerUrl: claudeMemUrl, catchUpIntervalMs: 0, fetchImpl });
    await mirror.catchUp();
    expect((await kept('t1'))!.title).toBe('Untitled');
    expect(await mirror.catchUp()).toMatchObject({ threads: 1, appended: 0 });
    expect((await kept('t1'))!.title).toBe('Trip to Oslo');
    expect(await mirror.catchUp()).toMatchObject({ threads: 0 });
    mirror.stop();
    store.close();
  });

  test('a long chat is sent in batches', async () => {
    const store = new ChatStore(join(dir, 'chats.db'));
    store.createThread({ id: 't1', userId: 'u', agentId: 'openduet' });
    for (let i = 0; i < 260; i++) fullRun(store, 't1', `r${i}`, `u${i}`, `question ${i}`, `answer ${i}`);
    const requests: number[] = [];
    const counting: typeof fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        requests.push(JSON.parse(String(init?.body)).messages.length);
        return fetch(input, init);
      },
      { preconnect: fetch.preconnect },
    );
    const mirror = createClaudeMemMirror({ store, workerUrl: claudeMemUrl, catchUpIntervalMs: 0, fetchImpl: counting });
    expect(await mirror.catchUp()).toMatchObject({ appended: 1040, failed: 0 });
    expect(Math.max(...requests)).toBeLessThanOrEqual(200);
    expect(requests.reduce((a, b) => a + b, 0)).toBe(1040);
    expect((await kept('t1'))!.messageCount).toBe(1040);
    mirror.stop();
    store.close();
  });

  test('end to end: a run over the runner socket lands in claude-mem by itself', async () => {
    const instance = createLocalChats({ dbPath: join(dir, 'chats.db'), apiKey: KEY, port: 0, claudeMemUrl, mirrorCatchUpIntervalMs: 0 });
    const base = `http://127.0.0.1:${instance.server.port}`;
    try {
      await fetch(`${base}/api/threads`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ threadId: 't9', userId: 'u', agentId: 'openduet', name: 'Weather' }),
      });
      const socket = new WebSocket(`ws://127.0.0.1:${instance.server.port}/runner/websocket?vsn=2.0.0`, [
        'phoenix',
        `base64url.bearer.phx.${btoa(KEY).replace(/=/g, '')}`,
      ]);
      const replies = new Map<string, any>();
      socket.onmessage = (message) => {
        const frame = JSON.parse(String(message.data));
        if (frame[3] === 'phx_reply') replies.set(frame[1], frame[4]);
      };
      await new Promise<void>((resolve, reject) => {
        socket.onopen = () => resolve();
        socket.onerror = () => reject(new Error('runner socket did not open'));
      });
      let ref = 0;
      const request = async (joinRef: string | null, event: string, payload: unknown) => {
        const id = String(++ref);
        socket.send(JSON.stringify([joinRef, id, 'ingestion:r9', event, payload]));
        for (let i = 0; i < 200 && !replies.has(id); i++) await new Promise((resolve) => setTimeout(resolve, 5));
        return replies.get(id);
      };
      expect((await request('1', 'phx_join', { thread_id: 't9', run_id: 'r9' })).status).toBe('ok');
      let n = 0;
      const send = (body: Record<string, unknown>) =>
        request('1', 'event', { ...body, threadId: 't9', runId: 'r9', metadata: { cpki_event_id: `e2e-${++n}` } });
      await send({ type: 'RUN_STARTED', input: { messages: [{ id: 'q1', role: 'user', content: 'Rain in Oslo?' }] } });
      await send({ type: 'TEXT_MESSAGE_START', messageId: 'a1', role: 'assistant' });
      await send({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'a1', delta: 'Yes, all week.' });
      await send({ type: 'TEXT_MESSAGE_END', messageId: 'a1' });
      await send({ type: 'RUN_FINISHED' });
      socket.close();

      let transcript = null;
      for (let i = 0; i < 100 && !(transcript = await kept('t9')); i++) await new Promise((resolve) => setTimeout(resolve, 20));
      expect(transcript).toMatchObject({ title: 'Weather', messageCount: 2 });
      expect(transcript!.lines.map((line) => line.message.content[0].text)).toEqual(['Rain in Oslo?', 'Yes, all week.']);

      // The file itself is plain JSONL in claude-mem's folder.
      const file = new TranscriptMirror(join(dir, 'claude-mem', 'chat-transcripts')).jsonlPathFor('openduet', 't9');
      expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(2);
    } finally {
      instance.stop();
    }
  });
});
