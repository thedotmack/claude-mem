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
  test(`native ODS request captures and recalls without an agent plugin (stream=${stream})`, { skip: !root, timeout: 10000 }, async t => {
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
      if (route === '/v1/chat/completions') return Response.json({ id: runId,
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'The accent stays blue.' } }] });
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
    const count = memoryCalls.length;
    assert.match(await send(), /accent stays blue/);
    assert.equal(gatewayCalls.filter(call => call.route === '/v1/chat/completions').length, 1, 'cached replay never repeats work');
    assert.equal(memoryCalls.length, count, 'cached replay never captures twice');
    assert.deepEqual(ledger.read(init.contentSessionId).messages, [user], 'recalled context stays out of visible history');
  });
}
