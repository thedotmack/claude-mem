import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createOdsMemory } from '../native/claude_mem.mjs';

const root = process.env.ODS_TEST_ROOT;
const host = root && path.join(root, 'extensions/services/pixel-agent/host');
const user = { role: 'user', content: 'Remember that the accent is blue.' };
const runId = 'chatcmpl_11111111-2222-4333-8444-555555555555';
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

for (const stream of [false, true]) {
  for (const pollWhileRunning of [false, true]) {
  test(`native ODS capture, recall and final activity (stream=${stream}, polling=${pollWhileRunning})`, { skip: !root, timeout: 10000 }, async t => {
    const { createIngressServer } = await import(pathToFileURL(path.join(host, 'pixel_ingress.mjs')));
    const { createChatHistoryLedger } = await import(pathToFileURL(path.join(host, 'chat_history_ledger.mjs')));
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ods-native-test-'));
    const ledger = createChatHistoryLedger(directory), memoryCalls = [], gatewayCalls = [];
    const memory = createOdsMemory({ enabled: true, fetchImpl: async (url, init) => {
      memoryCalls.push({ url: String(url), body: init.body && JSON.parse(init.body) });
      return String(url).includes('/api/observations?')
        ? Response.json({ items: [{ title: 'Prior blue accent decision', narrative: 'Keep the accent blue.' }] })
        : Response.json({});
    } });
    let startedAt, finishedAt;
    const deps = { setTimeout, clearTimeout, fetch: async (url, init) => {
      const route = new URL(url).pathname;
      const body = init.body && JSON.parse(init.body);
      gatewayCalls.push({ route, body });
      if (route === '/pixel-ods/context') return Response.json({ schemaVersion: 1, status: 'ready', sessionExists: true,
        sessionRevision: 'a'.repeat(64), context: { used: 100, window: 32000, measuredAt: 1 },
        model: { id: 'local-test', provider: 'local', contextWindow: 32000 },
        compaction: { status: 'idle', requestId: null, tokensBefore: null, tokensAfter: null, reason: null, count: 0 } });
      if (route === '/pixel-ods/verification') return Response.json({ status: 'none' });
      if (route === '/pixel-ods/subagent-delivery') return Response.json({ schemaVersion: 1, kind: 'ods-subagent-delivery', runId, status: 'not-delegated' });
      if (route === '/pixel-ods/activity') return Response.json({ task: {
        schemaVersion: 3, runId, startedAt, finishedAt: finishedAt ?? null,
        state: finishedAt ? 'completed' : 'running', calls: 2, failures: 0, blocked: 0, truncated: false,
        activities: [{ kind: 'read', calls: 1, failures: 0, blocked: 0 }, { kind: 'edit', calls: 1, failures: 0, blocked: 0 }],
        events: [
          { sequence: 1, kind: 'read', state: 'completed', startedAt, finishedAt: startedAt, display: null },
          { sequence: 2, kind: 'edit', state: finishedAt ? 'completed' : 'running', startedAt,
            finishedAt: finishedAt ?? null, display: null },
        ], context: null, goal: null,
      } });
      if (route === '/v1/chat/completions') {
        startedAt = new Date().toISOString();
        if (pollWhileRunning) await new Promise(resolve => setTimeout(resolve, 400));
        finishedAt = new Date().toISOString();
        return Response.json({ id: runId,
          choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'The accent stays blue.' } }] });
      }
      return new Response('{}', { status: 404 });
    } };
    const server = createIngressServer({ token: 'test-gateway-token', gatewayPort: 1, deps, historyLedger: ledger, memory });
    const port = await listen(server);
    t.after(async () => { await memory.flush(); await new Promise(resolve => server.close(resolve)); fs.rmSync(directory, { recursive: true }); });
    const body = { user: 'native-chat', request_id: 'native-turn-1', stream,
      history_snapshot: { schemaVersion: 1, messages: [user] }, messages: [user] };
    async function send() {
      const result = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      assert.equal(result.status, 200);
      return result.text();
    }
    assert.match(await send(), /accent stays blue/);
    await memory.flush();
    const outgoing = gatewayCalls.find(call => call.route === '/v1/chat/completions').body;
    assert.match(outgoing.messages[0].content, /Prior blue accent decision/);
    assert.equal(outgoing.messages.at(-1).content, user.content);
    const init = memoryCalls.find(call => call.url.endsWith('/api/sessions/init')).body;
    assert.equal(init.platformSource, 'ods');
    assert.equal(init.nativePromptId, 'native-turn-1');
    assert.ok(memoryCalls.some(call => call.body?.tool_name === 'ODSConversation'));
    const activity = memoryCalls.filter(call => call.body?.tool_name === 'ODSActivity');
    assert.deepEqual(activity.map(call => call.body.tool_input.sequence), [1, 2], 'running and terminal snapshots are deduplicated');
    assert.ok(activity.every(call => JSON.parse(call.body.tool_response).state === 'completed'));
    const pollCalls = gatewayCalls.filter(call => call.route === '/pixel-ods/activity');
    assert.equal(pollCalls.length, pollWhileRunning ? 2 : 1, 'final snapshot is collected even before the first timer fires');
    assert.ok(memoryCalls.indexOf(activity.at(-1)) < memoryCalls.findIndex(call => call.body?.tool_name === 'ODSConversation'));
    const count = memoryCalls.length;
    assert.match(await send(), /accent stays blue/);
    assert.equal(gatewayCalls.filter(call => call.route === '/v1/chat/completions').length, 1, 'cached replay never repeats work');
    assert.equal(memoryCalls.length, count, 'cached replay never captures twice');
    assert.deepEqual(ledger.read(init.contentSessionId).messages, [user], 'recalled context stays out of visible history');
  });
  }
}
