// The chat transcript mirror keeps whole conversations in Grok Bot's journal format: one JSONL file
// per conversation, every append prepared in a pending file and then committed, a crash finished on
// the next open, and a file changed outside the journal refused.
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import {
  conversationKey,
  toMirrorLine,
  TranscriptMirror,
  TranscriptMirrorError,
  type MirrorMessage,
} from '../../src/services/transcript-mirror/TranscriptMirror.js';
import { createMiddleware } from '../../src/services/worker/http/middleware.js';
import { TranscriptMirrorRoutes } from '../../src/services/worker/http/routes/TranscriptMirrorRoutes.js';
import { logger } from '../../src/utils/logger.js';

let root: string;
let loggerSpies: Array<ReturnType<typeof spyOn>> = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'chat-transcripts-'));
  loggerSpies = [
    spyOn(logger, 'debug').mockImplementation(() => {}),
    spyOn(logger, 'warn').mockImplementation(() => {}),
    spyOn(logger, 'error').mockImplementation(() => {}),
  ];
});

afterEach(() => {
  for (const spy of loggerSpies) spy.mockRestore();
  rmSync(root, { recursive: true, force: true });
});

const conversation: MirrorMessage[] = [
  { id: 'u1', role: 'user', content: 'What is on my calendar tomorrow?' },
  {
    id: 'a1',
    role: 'assistant',
    content: 'Let me look.',
    toolCalls: [{ id: 'call-1', name: 'calendar_list', args: '{"day":"2026-10-31"}' }],
  },
  { id: 't1', role: 'tool', toolCallId: 'call-1', content: '{"events":[{"title":"Dentist","at":"09:00"}]}' },
  { id: 'a2', role: 'assistant', content: 'You have the dentist at 9.' },
];

function files(mirror: TranscriptMirror, conversationId: string) {
  const jsonl = mirror.jsonlPathFor('openduet', conversationId);
  const dir = jsonl.slice(0, jsonl.lastIndexOf('/'));
  return { jsonl, dir, id: conversationKey(conversationId) };
}

function lines(path: string) {
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

describe('TranscriptMirror', () => {
  it('keeps every message, tool calls and tool results included, in Grok Bot line form', async () => {
    const mirror = new TranscriptMirror(root);
    const result = await mirror.append({ source: 'openduet', conversationId: 'thread-1', title: 'Calendar', messages: conversation });
    expect(result).toMatchObject({ appended: 4, skipped: 0, messageCount: 4 });

    const kept = lines(files(mirror, 'thread-1').jsonl);
    expect(kept.map((line) => line.id)).toEqual(['u1', 'a1', 't1', 'a2']);
    expect(kept[0].message.content).toEqual([{ type: 'text', text: 'What is on my calendar tomorrow?' }]);
    expect(kept[1].message.content).toEqual([
      { type: 'text', text: 'Let me look.' },
      { type: 'tool_use', id: 'call-1', name: 'calendar_list', input: { day: '2026-10-31' } },
    ]);
    expect(kept[2]).toMatchObject({
      role: 'tool',
      message: { content: [{ type: 'tool_result', tool_use_id: 'call-1', result: { events: [{ title: 'Dentist', at: '09:00' }] } }] },
    });
    expect(statSync(files(mirror, 'thread-1').jsonl).mode & 0o777).toBe(0o600);
  });

  it('skips messages already kept, so a whole conversation can be sent again after every turn', async () => {
    const mirror = new TranscriptMirror(root);
    await mirror.append({ source: 'openduet', conversationId: 'thread-1', messages: conversation.slice(0, 2) });
    const second = await mirror.append({ source: 'openduet', conversationId: 'thread-1', messages: conversation });
    expect(second).toMatchObject({ appended: 2, skipped: 2, messageCount: 4 });

    // A fresh process has no memory of what was kept: it reads the ids back from the file.
    const restarted = new TranscriptMirror(root);
    const third = await restarted.append({ source: 'openduet', conversationId: 'thread-1', messages: conversation });
    expect(third).toMatchObject({ appended: 0, skipped: 4, messageCount: 4 });
    expect(lines(files(mirror, 'thread-1').jsonl)).toHaveLength(4);
  });

  it('runs appends to one conversation one at a time', async () => {
    const mirror = new TranscriptMirror(root);
    await Promise.all(
      Array.from({ length: 8 }, () => mirror.append({ source: 'openduet', conversationId: 'thread-1', messages: conversation })),
    );
    expect(lines(files(mirror, 'thread-1').jsonl).map((line) => line.id)).toEqual(['u1', 'a1', 't1', 'a2']);
  });

  it('records a new title without a new message', async () => {
    const mirror = new TranscriptMirror(root);
    await mirror.append({ source: 'openduet', conversationId: 'thread-1', title: null, messages: conversation });
    await mirror.append({ source: 'openduet', conversationId: 'thread-1', title: 'Dentist tomorrow', messages: [] });
    const { summary } = await mirror.read('openduet', 'thread-1');
    expect(summary).toMatchObject({ title: 'Dentist tomorrow', messageCount: 4, conversationId: 'thread-1', source: 'openduet' });
  });

  it('removes <private> blocks and nothing else', async () => {
    const mirror = new TranscriptMirror(root);
    await mirror.append({
      source: 'openduet',
      conversationId: 'thread-1',
      messages: [{ id: 'u1', role: 'user', content: 'My code is <private>4321</private> ok, and <b>bold</b> stays' }],
    });
    const raw = readFileSync(files(mirror, 'thread-1').jsonl, 'utf8');
    expect(raw).not.toContain('4321');
    expect(raw).toContain('<b>bold</b> stays');
  });

  it('removes <private> blocks from a tool result even when its JSON escapes the tag', () => {
    const line = toMirrorLine(
      { id: 't1', role: 'tool', toolCallId: 'c1', content: '{"note":"\\u003cprivate\\u003esecret\\u003c/private\\u003e visible"}' },
      '2026-10-30T00:00:00.000Z',
    );
    expect(JSON.stringify(line)).not.toContain('secret');
    expect(line.message.content[0]).toMatchObject({ type: 'tool_result', result: { note: ' visible' } });
  });

  it('keeps structured content as-is', () => {
    const line = toMirrorLine(
      { id: 'u1', role: 'user', content: [{ type: 'text', text: 'see image' }, { type: 'binary', mimeType: 'image/png', url: 'file:///x.png' }] },
      '2026-10-30T00:00:00.000Z',
    );
    expect(line.message.content).toEqual([
      { type: 'text', text: 'see image' },
      { type: 'content', value: { type: 'binary', mimeType: 'image/png', url: 'file:///x.png' } },
    ]);
  });

  it('finishes a write a crash interrupted, without a duplicate or half a line', async () => {
    const mirror = new TranscriptMirror(root);
    await mirror.append({ source: 'openduet', conversationId: 'thread-1', messages: conversation.slice(0, 2) });
    const { jsonl, dir, id } = files(mirror, 'thread-1');
    const cursor = JSON.parse(readFileSync(join(dir, `${id}.journal-cursor.json`), 'utf8'));

    // The crash: the pending checkpoint was installed and half of its first line reached the file.
    const pendingLines = conversation.slice(2).map((message) => JSON.stringify(toMirrorLine(message, '2026-10-30T00:00:00.000Z')));
    writeFileSync(
      join(dir, `${id}.journal-pending.json`),
      JSON.stringify({
        version: 1,
        appendOffset: cursor.bytes,
        device: cursor.device,
        inode: cursor.inode,
        lines: pendingLines,
        cursor: { ...cursor, messageCount: 4, updatedAt: '2026-10-30T00:00:00.000Z', bytes: undefined, device: undefined, inode: undefined },
      }),
    );
    appendFileSync(jsonl, pendingLines[0].slice(0, 20));

    const restarted = new TranscriptMirror(root);
    const result = await restarted.append({ source: 'openduet', conversationId: 'thread-1', messages: conversation });
    expect(result).toMatchObject({ appended: 0, messageCount: 4 });
    expect(lines(jsonl).map((line) => line.id)).toEqual(['u1', 'a1', 't1', 'a2']);
    expect(existsSync(join(dir, `${id}.journal-pending.json`))).toBe(false);
  });

  it('finishes a write that crashed after its cursor but before the pending file was removed', async () => {
    const mirror = new TranscriptMirror(root);
    await mirror.append({ source: 'openduet', conversationId: 'thread-1', messages: conversation.slice(0, 2) });
    const { jsonl, dir, id } = files(mirror, 'thread-1');
    const before = JSON.parse(readFileSync(join(dir, `${id}.journal-cursor.json`), 'utf8'));
    const pendingLines = conversation.slice(2).map((message) => JSON.stringify(toMirrorLine(message, '2026-10-30T00:00:00.000Z')));
    const pending = {
      version: 1,
      appendOffset: before.bytes,
      device: before.device,
      inode: before.inode,
      lines: pendingLines,
      cursor: { version: 1, source: 'openduet', conversationId: 'thread-1', title: null, messageCount: 4, createdAt: before.createdAt, updatedAt: before.updatedAt },
    };
    writeFileSync(join(dir, `${id}.journal-pending.json`), JSON.stringify(pending));
    appendFileSync(jsonl, pendingLines.map((line) => `${line}\n`).join(''));
    const size = statSync(jsonl).size;
    writeFileSync(join(dir, `${id}.journal-cursor.json`), JSON.stringify({ ...before, messageCount: 4, bytes: size }));

    const { summary, lines: kept } = await new TranscriptMirror(root).read('openduet', 'thread-1');
    expect(kept.map((line) => line.id)).toEqual(['u1', 'a1', 't1', 'a2']);
    expect(summary.messageCount).toBe(4);
    expect(summary.bytes).toBe(size);
  });

  it('refuses a transcript changed outside the journal instead of writing over it', async () => {
    const mirror = new TranscriptMirror(root);
    await mirror.append({ source: 'openduet', conversationId: 'thread-1', messages: conversation.slice(0, 2) });
    appendFileSync(files(mirror, 'thread-1').jsonl, '{"id":"x","role":"user","message":{"content":[]}}\n');
    const attempt = new TranscriptMirror(root).append({ source: 'openduet', conversationId: 'thread-1', messages: conversation });
    await expect(attempt).rejects.toThrow(TranscriptMirrorError);
    await expect(attempt).rejects.toMatchObject({ code: 'changed_outside' });
  });

  it('refuses an edit that keeps the file the same size', async () => {
    const mirror = new TranscriptMirror(root);
    await mirror.append({ source: 'openduet', conversationId: 'thread-1', messages: conversation.slice(0, 2) });
    const { jsonl } = files(mirror, 'thread-1');
    await new Promise((resolve) => setTimeout(resolve, 20));
    const text = readFileSync(jsonl, 'utf8');
    writeFileSync(jsonl, text.replace('What is on my calendar', 'What is in my calendar'));
    expect(statSync(jsonl).size).toBe(Buffer.byteLength(text));
    await expect(new TranscriptMirror(root).read('openduet', 'thread-1')).rejects.toMatchObject({ code: 'changed_outside' });
  });

  it('never reads or adds to a folder that holds another conversation', async () => {
    const mirror = new TranscriptMirror(root);
    await mirror.append({ source: 'openduet', conversationId: 'thread-1', messages: conversation.slice(0, 1) });
    const { dir, id } = files(mirror, 'thread-1');
    const cursorPath = join(dir, `${id}.journal-cursor.json`);
    writeFileSync(cursorPath, JSON.stringify({ ...JSON.parse(readFileSync(cursorPath, 'utf8')), conversationId: 'thread-2' }));
    await expect(mirror.read('openduet', 'thread-1')).rejects.toMatchObject({ code: 'not_found' });
    await expect(mirror.append({ source: 'openduet', conversationId: 'thread-1', messages: conversation })).rejects.toMatchObject({ code: 'corrupt' });
  });

  it('keeps every conversation id inside its own folder', async () => {
    const mirror = new TranscriptMirror(root);
    for (const bad of ['', ' padded', 'nul\0id', 'x'.repeat(201)]) {
      await expect(mirror.append({ source: 'openduet', conversationId: bad, messages: conversation })).rejects.toMatchObject({ code: 'invalid_input' });
    }
    for (const badSource of ['', '../x', 'Upper', 'a/b']) {
      await expect(mirror.append({ source: badSource, conversationId: 'ok', messages: conversation })).rejects.toMatchObject({ code: 'invalid_input' });
    }
    await mirror.append({ source: 'openduet', conversationId: '../escape/attempt', messages: conversation });
    expect(readdirSync(join(root, 'openduet'))).toEqual([expect.stringMatching(/^___escape_attempt-[0-9a-f]{16}$/)]);
  });

  it('gives ids that look alike their own folders, and keeps long ids to a short name', async () => {
    const mirror = new TranscriptMirror(root);
    // Grok Bot's encoding gave these two one folder.
    for (const conversationId of ['a/b', 'a_2Fb', '.', '..', 'x'.repeat(200)]) {
      await mirror.append({ source: 'openduet', conversationId, messages: [{ id: 'u1', role: 'user', content: conversationId }] });
    }
    const folders = readdirSync(join(root, 'openduet'));
    expect(folders).toHaveLength(5);
    expect(Math.max(...folders.map((name) => name.length))).toBeLessThanOrEqual(65);
    expect((await mirror.read('openduet', 'a/b')).lines[0].message.content[0].text).toBe('a/b');
    expect((await mirror.read('openduet', 'a_2Fb')).lines[0].message.content[0].text).toBe('a_2Fb');
  });

  it('lists conversations newest first', async () => {
    const mirror = new TranscriptMirror(root);
    await mirror.append({ source: 'openduet', conversationId: 'older', title: 'Older', messages: conversation.slice(0, 1) });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await mirror.append({ source: 'openduet', conversationId: 'newer', title: 'Newer', messages: conversation.slice(0, 1) });
    const listed = await mirror.list();
    expect(listed.map((entry) => entry.title)).toEqual(['Newer', 'Older']);
    expect(await new TranscriptMirror(join(root, 'missing')).list()).toEqual([]);
  });
});

describe('TranscriptMirrorRoutes', () => {
  let server: Server | undefined;
  let base = '';

  beforeEach(async () => {
    // The worker's own middleware, so its 5 MB body limit is in the way unless the route skips it.
    const app = express();
    for (const middleware of createMiddleware()) app.use(middleware);
    new TranscriptMirrorRoutes(new TranscriptMirror(root)).setupRoutes(app);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const address = server!.address();
        if (address && typeof address !== 'string') base = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  const post = (body: unknown) =>
    fetch(`${base}/api/chat-transcripts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  it('keeps, lists and reads a conversation', async () => {
    const first = await post({ source: 'openduet', conversationId: 'thread-1', title: 'Calendar', messages: conversation });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ appended: 4, messageCount: 4 });
    expect(await (await post({ source: 'openduet', conversationId: 'thread-1', messages: conversation })).json()).toMatchObject({ appended: 0, skipped: 4 });

    const listed = await (await fetch(`${base}/api/chat-transcripts?source=openduet`)).json();
    expect(listed.transcripts).toHaveLength(1);
    expect(listed.transcripts[0]).toMatchObject({ conversationId: 'thread-1', title: 'Calendar', messageCount: 4 });

    const read = await (await fetch(`${base}/api/chat-transcripts/openduet/thread-1`)).json();
    expect(read.lines.map((line: { id: string }) => line.id)).toEqual(['u1', 'a1', 't1', 'a2']);

    const jsonl = await fetch(`${base}/api/chat-transcripts/openduet/thread-1?format=jsonl`);
    expect(jsonl.headers.get('content-type')).toContain('application/x-ndjson');
    expect((await jsonl.text()).trim().split('\n')).toHaveLength(4);
  });

  it('answers 400 for bad input, 404 for an unknown conversation and 409 for a changed file', async () => {
    expect((await post({ source: 'openduet', conversationId: 'thread-1', messages: [{ role: 'user' }] })).status).toBe(400);
    expect((await post({ source: 'Bad Source', conversationId: 'thread-1', messages: [] })).status).toBe(400);
    expect((await fetch(`${base}/api/chat-transcripts/openduet/nope`)).status).toBe(404);

    await post({ source: 'openduet', conversationId: 'thread-1', messages: conversation.slice(0, 1) });
    appendFileSync(new TranscriptMirror(root).jsonlPathFor('openduet', 'thread-1'), 'tampered\n');
    const refused = await post({ source: 'openduet', conversationId: 'thread-1', messages: conversation });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: 'changed_outside' });
  });

  it('takes a message larger than the worker\'s usual 5 MB body limit', async () => {
    const big = 'x'.repeat(6 * 1024 * 1024);
    const response = await post({ source: 'openduet', conversationId: 'big', messages: [{ id: 't1', role: 'tool', toolCallId: 'c1', content: big }] });
    expect(response.status).toBe(200);
    const read = await (await fetch(`${base}/api/chat-transcripts/openduet/big`)).json();
    expect(read.lines[0].message.content[0].result).toHaveLength(big.length);
  });
});
