// SPDX-License-Identifier: Apache-2.0
//
// The local chat store, spoken to the way CopilotKit's runtime, runner and browser client speak to
// it: REST with the project key, and Phoenix channel frames over WebSockets.
// Run: bun test examples/openduet-endless/local-chats

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { messagesFromEvents, stateFromEvents } from './messages.js';
import { createLocalChats } from './server.js';

const KEY = 'local-test-key-0123456789abcdef';

type Frame = [string | null, string | null, string, string, any];

class PhoenixClient {
  private ws: WebSocket;
  private ref = 0;
  readonly frames: Frame[] = [];
  private waiters: { match: (f: Frame) => boolean; resolve: (f: Frame) => void }[] = [];

  constructor(url: string, protocols?: string[]) {
    this.ws = new WebSocket(url, protocols);
    this.ws.onmessage = (message) => {
      const frame = JSON.parse(String(message.data)) as Frame;
      this.frames.push(frame);
      for (const waiter of [...this.waiters]) {
        if (waiter.match(frame)) {
          this.waiters.splice(this.waiters.indexOf(waiter), 1);
          waiter.resolve(frame);
        }
      }
    };
  }

  static runner(base: string, key = KEY) {
    return new PhoenixClient(`${base}/runner/websocket?vsn=2.0.0`, ['phoenix', `base64url.bearer.phx.${btoa(key).replace(/=/g, '')}`]);
  }

  static client(base: string, joinToken: string) {
    return new PhoenixClient(`${base}/client/websocket?vsn=2.0.0&join_token=${encodeURIComponent(joinToken)}`);
  }

  opened(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws.readyState === WebSocket.OPEN) return resolve();
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error('socket did not open'));
    });
  }

  closed(): Promise<void> {
    return new Promise((resolve) => {
      if (this.ws.readyState === WebSocket.CLOSED) return resolve();
      this.ws.onclose = () => resolve();
      this.ws.onerror = () => resolve();
    });
  }

  next(match: (f: Frame) => boolean, timeoutMs = 2000): Promise<Frame> {
    const found = this.frames.find(match);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for a frame')), timeoutMs);
      this.waiters.push({ match, resolve: (f) => (clearTimeout(timer), resolve(f)) });
    });
  }

  async request(joinRef: string | null, topic: string, event: string, payload: unknown): Promise<any> {
    const ref = String(++this.ref);
    this.ws.send(JSON.stringify([joinRef, ref, topic, event, payload]));
    const reply = await this.next((f) => f[1] === ref && f[3] === 'phx_reply');
    return reply[4];
  }

  async join(topic: string, params: unknown = {}): Promise<{ joinRef: string; reply: any }> {
    const joinRef = String(this.ref + 1);
    const reply = await this.request(joinRef, topic, 'phx_join', params);
    return { joinRef, reply };
  }

  pushed(topic: string, event: string) {
    return this.frames.filter((f) => f[2] === topic && f[3] === event).map((f) => f[4]);
  }

  close() {
    this.ws.close();
  }
}

let n = 0;
const event = (runId: string, threadId: string, body: Record<string, unknown>) => ({
  ...body,
  threadId,
  runId,
  thread_id: threadId,
  run_id: runId,
  metadata: { cpki_event_id: `evt-${++n}`, cpki_event_seq: n },
});

describe('local chats', () => {
  let dir: string;
  let instance: ReturnType<typeof createLocalChats>;
  let base: string;
  let ws: string;

  const api = (path: string, init: RequestInit = {}, key = KEY) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    });
  const post = (path: string, body: unknown, method = 'POST') => api(path, { method, body: JSON.stringify(body) });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'local-chats-'));
    instance = createLocalChats({ dbPath: join(dir, 'chats.db'), apiKey: KEY, port: 0 });
    base = `http://127.0.0.1:${instance.server.port}`;
    ws = `ws://127.0.0.1:${instance.server.port}`;
  });

  afterEach(() => {
    instance.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  test('refuses requests without the key, and claims no entitlement', async () => {
    expect((await api('/api/threads?userId=u&agentId=a', {}, 'wrong-key-0123456789')).status).toBe(401);
    const entitlement = await (await api('/api/entitlements/runtime')).json();
    expect(entitlement.status).toBe('unavailable');
    expect(entitlement.error.retryable).toBe(false);
    expect((await api('/api/memories')).status).toBe(404);
    expect((await api('/api/inspector/metadata')).status).toBe(404);
  });

  test('creates, lists, renames, archives and deletes threads', async () => {
    expect((await api('/api/threads/t1?userId=u1')).status).toBe(404);
    const created = await (await post('/api/threads', { threadId: 't1', userId: 'u1', agentId: 'openduet' })).json();
    expect(created.thread).toMatchObject({ id: 't1', agentId: 'openduet', archived: false });
    expect((await post('/api/threads', { threadId: 't1', userId: 'u1', agentId: 'openduet' })).status).toBe(409);
    await post('/api/threads', { threadId: 't2', userId: 'u1', agentId: 'openduet' });
    await post('/api/threads', { threadId: 't3', userId: 'u2', agentId: 'openduet' });

    const renamed = await (await post('/api/threads/t1', { userId: 'u1', agentId: 'openduet', name: 'Plans' }, 'PATCH')).json();
    expect(renamed.thread.name).toBe('Plans');
    await post('/api/threads/t2', { userId: 'u1', agentId: 'openduet', archived: true }, 'PATCH');

    const listed = await (await api('/api/threads?userId=u1&agentId=openduet')).json();
    expect(listed.threads.map((t: any) => t.id)).toEqual(['t1']);
    expect(typeof listed.joinCode).toBe('string');
    const withArchived = await (await api('/api/threads?userId=u1&agentId=openduet&includeArchived=true&limit=1')).json();
    expect(withArchived.threads).toHaveLength(1);
    expect(withArchived.nextCursor).toBeTruthy();
    const second = await (await api(`/api/threads?userId=u1&agentId=openduet&includeArchived=true&limit=1&cursor=${withArchived.nextCursor}`)).json();
    expect(second.threads).toHaveLength(1);
    expect(second.threads[0].id).not.toBe(withArchived.threads[0].id);

    expect((await api('/api/threads/t1', { method: 'DELETE', body: JSON.stringify({ userId: 'u1', agentId: 'openduet' }) })).status).toBe(200);
    expect((await api('/api/threads/t1?userId=u1')).status).toBe(404);
  });

  test('one run at a time per thread', async () => {
    await post('/api/threads', { threadId: 't1', userId: 'u1', agentId: 'openduet' });
    const first = await (await post('/api/threads/t1/lock', { runId: 'r1', userId: 'u1', agentId: 'openduet', ttlSeconds: 30 })).json();
    expect(first).toMatchObject({ threadId: 't1', runId: 'r1' });
    expect(typeof first.joinToken).toBe('string');
    expect((await post('/api/threads/t1/lock', { runId: 'r2', userId: 'u1', agentId: 'openduet' })).status).toBe(409);
    expect((await (await post('/api/threads/t1/lock', { runId: 'r1', ttlSeconds: 45 }, 'PATCH')).json()).ttlSeconds).toBe(45);
    const connect = await (await post('/api/threads/t1/connect', { userId: 'u1', agentId: 'openduet' })).json();
    expect(connect.runId).toBe('r1');
    await api('/api/threads/t1/lock', { method: 'DELETE', body: JSON.stringify({ runId: 'r1' }) });
    expect((await post('/api/threads/t1/lock', { runId: 'r2', userId: 'u1', agentId: 'openduet' })).status).toBe(200);
    expect((await post('/api/threads/nope/connect', { userId: 'u1', agentId: 'openduet' })).status).toBe(204);
  });

  test('a run streams to the browser live, is kept, and replays on reconnect', async () => {
    await post('/api/threads', { threadId: 't1', userId: 'u1', agentId: 'openduet' });
    const lock = await (await post('/api/threads/t1/lock', { runId: 'r1', userId: 'u1', agentId: 'openduet' })).json();

    const runner = PhoenixClient.runner(ws);
    await runner.opened();
    const ingestion = await runner.join('ingestion:r1', { thread_id: 't1', run_id: 'r1' });
    expect(ingestion.reply.status).toBe('ok');
    expect(ingestion.reply.response.capabilities).toContain('runner_event_batch_v1');

    const started = event('r1', 't1', {
      type: 'RUN_STARTED',
      input: { threadId: 't1', runId: 'r1', messages: [{ id: 'u-1', role: 'user', content: 'Hi there' }] },
    });
    expect((await runner.request(ingestion.joinRef, 'ingestion:r1', 'event', started)).status).toBe('ok');

    // The browser joins after the run has begun, in run mode, and gets the start replayed.
    const browser = PhoenixClient.client(ws, lock.joinToken);
    await browser.opened();
    const joined = await browser.join('thread:t1', { stream_mode: 'run', run_id: 'r1' });
    expect(joined.reply.status).toBe('ok');
    await browser.next((f) => f[3] === 'ag_ui_event' && f[4].type === 'RUN_STARTED');

    const batch = [
      event('r1', 't1', { type: 'TEXT_MESSAGE_START', messageId: 'a-1', role: 'assistant' }),
      event('r1', 't1', { type: 'TEXT_MESSAGE_CONTENT', messageId: 'a-1', delta: 'Hello ' }),
      event('r1', 't1', { type: 'TEXT_MESSAGE_CONTENT', messageId: 'a-1', delta: 'back' }),
      event('r1', 't1', { type: 'TEXT_MESSAGE_END', messageId: 'a-1' }),
      event('r1', 't1', { type: 'RUN_FINISHED' }),
    ];
    const ack = await runner.request(ingestion.joinRef, 'ingestion:r1', 'events', { events: batch });
    expect(ack).toMatchObject({ status: 'ok', response: { accepted: 5, rejected: 0 } });
    // A resend after a lost acknowledgement is kept once.
    await runner.request(ingestion.joinRef, 'ingestion:r1', 'events', { events: batch });

    await browser.next((f) => f[3] === 'ag_ui_event' && f[4].type === 'RUN_FINISHED');
    expect(browser.pushed('thread:t1', 'ag_ui_event').map((p) => p.type)).toEqual([
      'RUN_STARTED',
      'TEXT_MESSAGE_START',
      'TEXT_MESSAGE_CONTENT',
      'TEXT_MESSAGE_CONTENT',
      'TEXT_MESSAGE_END',
      'RUN_FINISHED',
    ]);

    const history = await (await api('/api/threads/t1/messages?userId=u1')).json();
    expect(history.messages).toEqual([
      { id: 'u-1', role: 'user', content: 'Hi there' },
      { id: 'a-1', role: 'assistant', content: 'Hello back' },
    ]);

    // The run is over, so the thread takes a new one.
    expect((await post('/api/threads/t1/lock', { runId: 'r2', userId: 'u1', agentId: 'openduet' })).status).toBe(200);
    await api('/api/threads/t1/lock', { method: 'DELETE', body: JSON.stringify({ runId: 'r2' }) });

    // Reconnecting from scratch replays everything, then says the replay is done and nothing runs.
    const connect = await (await post('/api/threads/t1/connect', { userId: 'u1', agentId: 'openduet' })).json();
    const again = PhoenixClient.client(ws, connect.joinToken);
    await again.opened();
    await again.join('thread:t1', { stream_mode: 'connect', last_seen_event_id: null });
    const idle = await again.next((f) => f[3] === 'stream_idle');
    expect(again.pushed('thread:t1', 'ag_ui_event')).toHaveLength(6);
    const complete = again.pushed('thread:t1', 'replay_complete')[0];
    expect(complete.latestEventId).toBe(idle[4].latestEventId);

    // Resuming from a cursor sends only what came after it.
    const cursor = again.pushed('thread:t1', 'ag_ui_event')[3].metadata.cpki_event_id;
    const resumed = PhoenixClient.client(ws, connect.joinToken);
    await resumed.opened();
    await resumed.join('thread:t1', { stream_mode: 'connect', last_seen_event_id: cursor });
    await resumed.next((f) => f[3] === 'stream_idle');
    expect(resumed.pushed('thread:t1', 'ag_ui_event').map((p) => p.type)).toEqual(['TEXT_MESSAGE_END', 'RUN_FINISHED']);

    for (const socket of [runner, browser, again, resumed]) socket.close();
  });

  test('stop from the browser reaches the runner', async () => {
    await post('/api/threads', { threadId: 't1', userId: 'u1', agentId: 'openduet' });
    const lock = await (await post('/api/threads/t1/lock', { runId: 'r1', userId: 'u1', agentId: 'openduet' })).json();
    const runner = PhoenixClient.runner(ws);
    await runner.opened();
    await runner.join('ingestion:r1', { thread_id: 't1', run_id: 'r1' });
    const browser = PhoenixClient.client(ws, lock.joinToken);
    await browser.opened();
    const { joinRef } = await browser.join('thread:t1', { stream_mode: 'run', run_id: 'r1' });
    expect((await browser.request(joinRef, 'thread:t1', 'stop_run', { run_id: 'r1' })).status).toBe('ok');
    const stop = await runner.next((f) => f[2] === 'ingestion:r1' && f[3] === 'ag-ui');
    expect(stop[4]).toMatchObject({ type: 'CUSTOM', name: 'stop' });
    runner.close();
    browser.close();
  });

  test('a connect watcher waits for the running turn before going idle', async () => {
    await post('/api/threads', { threadId: 't1', userId: 'u1', agentId: 'openduet' });
    await post('/api/threads/t1/lock', { runId: 'r1', userId: 'u1', agentId: 'openduet' });
    const runner = PhoenixClient.runner(ws);
    await runner.opened();
    const { joinRef } = await runner.join('ingestion:r1', { thread_id: 't1', run_id: 'r1' });
    await runner.request(joinRef, 'ingestion:r1', 'event', event('r1', 't1', { type: 'RUN_STARTED' }));

    const connect = await (await post('/api/threads/t1/connect', { userId: 'u1', agentId: 'openduet' })).json();
    expect(connect.runId).toBe('r1');
    const watcher = PhoenixClient.client(ws, connect.joinToken);
    await watcher.opened();
    await watcher.join('thread:t1', { stream_mode: 'connect' });
    await watcher.next((f) => f[3] === 'replay_complete');
    expect(watcher.pushed('thread:t1', 'stream_idle')).toHaveLength(0);

    await runner.request(joinRef, 'ingestion:r1', 'event', event('r1', 't1', { type: 'RUN_FINISHED' }));
    await watcher.next((f) => f[3] === 'stream_idle');
    expect(watcher.pushed('thread:t1', 'ag_ui_event').map((p) => p.type)).toEqual(['RUN_STARTED', 'RUN_FINISHED']);
    runner.close();
    watcher.close();
  });

  test('sockets need a valid key or join token, and a token opens only its own thread', async () => {
    const badRunner = PhoenixClient.runner(ws, 'not-the-key-0123456789');
    await badRunner.closed();
    const badClient = PhoenixClient.client(ws, 'made-up-token');
    await badClient.closed();

    await post('/api/threads', { threadId: 't1', userId: 'u1', agentId: 'openduet' });
    await post('/api/threads', { threadId: 't2', userId: 'u1', agentId: 'openduet' });
    const connect = await (await post('/api/threads/t1/connect', { userId: 'u1', agentId: 'openduet' })).json();
    const browser = PhoenixClient.client(ws, connect.joinToken);
    await browser.opened();
    expect((await browser.join('thread:t2', { stream_mode: 'connect' })).reply.status).toBe('error');
    expect((await browser.join('ingestion:r1', { thread_id: 't1' })).reply.status).toBe('error');
    expect((await browser.request(null, 'phoenix', 'heartbeat', {})).status).toBe('ok');
    browser.close();
  });

  test('the thread list hears about new and renamed threads', async () => {
    const listed = await (await api('/api/threads?userId=u1&agentId=openduet')).json();
    const socket = PhoenixClient.client(ws, listed.joinToken);
    await socket.opened();
    expect((await socket.join(`user_meta:${listed.joinCode}`)).reply.status).toBe('ok');
    await post('/api/threads', { threadId: 't1', userId: 'u1', agentId: 'openduet' });
    await post('/api/threads/t1', { userId: 'u1', agentId: 'openduet', name: 'Trip' }, 'PATCH');
    await socket.next((f) => f[3] === 'thread_metadata' && f[4].operation === 'updated');
    expect(socket.pushed(`user_meta:${listed.joinCode}`, 'thread_metadata').map((p) => [p.operation, p.thread.name])).toEqual([
      ['created', null],
      ['updated', 'Trip'],
    ]);
    socket.close();
  });

  test('chats survive a restart', async () => {
    await post('/api/threads', { threadId: 't1', userId: 'u1', agentId: 'openduet' });
    instance.store.appendEvent('t1', 'r1', 'e1', {
      type: 'RUN_STARTED',
      input: { messages: [{ id: 'u-1', role: 'user', content: 'remember me' }] },
    });
    instance.stop();
    instance = createLocalChats({ dbPath: join(dir, 'chats.db'), apiKey: KEY, port: 0 });
    base = `http://127.0.0.1:${instance.server.port}`;
    const history = await (await api('/api/threads/t1/messages?userId=u1')).json();
    expect(history.messages).toEqual([{ id: 'u-1', role: 'user', content: 'remember me' }]);
  });
});

describe('messages from events', () => {
  test('tool calls use the stored dialect and results sit right after their call', () => {
    const messages = messagesFromEvents([
      { type: 'RUN_STARTED', input: { messages: [{ id: 'u1', role: 'user', content: 'weather?' }] } },
      { type: 'TOOL_CALL_START', toolCallId: 'c1', toolCallName: 'weather', parentMessageId: 'a1' },
      { type: 'TOOL_CALL_ARGS', toolCallId: 'c1', delta: '{"city":' },
      { type: 'TOOL_CALL_ARGS', toolCallId: 'c1', delta: '"Oslo"}' },
      { type: 'TOOL_CALL_END', toolCallId: 'c1' },
      { type: 'TEXT_MESSAGE_START', messageId: 'a2', role: 'assistant' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'a2', delta: 'Checking.' },
      { type: 'TOOL_CALL_RESULT', messageId: 't1', toolCallId: 'c1', content: 'rain' },
    ]);
    expect(messages).toEqual([
      { id: 'u1', role: 'user', content: 'weather?' },
      { id: 'a1', role: 'assistant', toolCalls: [{ id: 'c1', name: 'weather', args: '{"city":"Oslo"}' }] },
      { id: 't1', role: 'tool', content: 'rain', toolCallId: 'c1' },
      { id: 'a2', role: 'assistant', content: 'Checking.' },
    ]);
  });

  test('a later run does not repeat the history the browser sent again', () => {
    const messages = messagesFromEvents([
      { type: 'RUN_STARTED', input: { messages: [{ id: 'u1', role: 'user', content: 'one' }] } },
      { type: 'TEXT_MESSAGE_CHUNK', messageId: 'a1', role: 'assistant', delta: 'first' },
      {
        type: 'RUN_STARTED',
        input: {
          messages: [
            { id: 'u1', role: 'user', content: 'one' },
            { id: 'a1', role: 'assistant', content: 'first' },
            { id: 'u2', role: 'user', content: 'two' },
          ],
        },
      },
    ]);
    expect(messages.map((m) => m.id)).toEqual(['u1', 'a1', 'u2']);
  });

  test('snapshots replace, AG-UI tool calls are translated, activity follows its deltas', () => {
    const messages = messagesFromEvents([
      { type: 'ACTIVITY_SNAPSHOT', messageId: 'act', activityType: 'progress', content: { done: 1 } },
      { type: 'ACTIVITY_DELTA', messageId: 'act', activityType: 'progress', patch: [{ op: 'replace', path: '/done', value: 2 }] },
      {
        type: 'MESSAGES_SNAPSHOT',
        messages: [
          { id: 'u1', role: 'user', content: 'hi' },
          { id: 'a1', role: 'assistant', toolCalls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }] },
        ],
      },
    ]);
    expect(messages).toEqual([
      { id: 'act', role: 'activity', activityType: 'progress', content: { done: 2 } },
      { id: 'u1', role: 'user', content: 'hi' },
      { id: 'a1', role: 'assistant', toolCalls: [{ id: 'c1', name: 'f', args: '{}' }] },
    ]);
  });

  test('state folds deltas onto the last snapshot', () => {
    expect(stateFromEvents([{ type: 'RUN_STARTED' }])).toEqual({ kind: 'no-snapshot' });
    expect(
      stateFromEvents([
        { type: 'STATE_SNAPSHOT', snapshot: { items: ['a'] } },
        { type: 'STATE_DELTA', delta: [{ op: 'add', path: '/items/-', value: 'b' }] },
        { type: 'STATE_DELTA', delta: [{ op: 'remove', path: '/missing/deep' }] },
      ]),
    ).toEqual({ kind: 'snapshot', state: { items: ['a', 'b'] }, skippedDeltas: 1 });
  });
});
