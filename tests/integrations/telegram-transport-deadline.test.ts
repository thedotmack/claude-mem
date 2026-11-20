import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { postTelegramMessage } from '../../src/services/integrations/telegram-transport.js';

test('a stalled Telegram request aborts once without retrying the notification', async () => {
  const server = createServer(() => {});
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const originalTimeout = AbortSignal.timeout;
  const deadlines: number[] = [];
  AbortSignal.timeout = ms => {
    deadlines.push(ms);
    return originalTimeout.call(AbortSignal, Math.min(ms, 150));
  };
  const watchdogController = new AbortController();
  let watchdogFired = false, attempts = 0;
  const watchdog = setTimeout(() => {
    watchdogFired = true;
    watchdogController.abort(new Error('External watchdog interrupted the Telegram request.'));
  }, 1_500);
  try {
    const request = ((_url, init) => {
      attempts++;
      return fetch(`http://127.0.0.1:${address.port}`, {
        ...init,
        signal: init?.signal ? AbortSignal.any([init.signal, watchdogController.signal]) : watchdogController.signal,
      });
    }) as typeof fetch;
    await assert.rejects(postTelegramMessage('test-token', 'test-chat', 'test notification', request), { name: 'TimeoutError' });
    assert.equal(watchdogFired, false);
    assert.equal(attempts, 1);
    assert.ok(deadlines.length > 0 && deadlines.every(ms => ms > 0 && ms <= 15_000));
  } finally {
    clearTimeout(watchdog);
    AbortSignal.timeout = originalTimeout;
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

for (const status of [200, 429]) {
  test(`releases the unused Telegram response body after HTTP ${status}`, async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    const request = (async () => new Response(body, { status, statusText: status === 200 ? 'OK' : 'Too Many Requests' })) as typeof fetch;
    const sent = postTelegramMessage('test-token', 'test-chat', 'message', request);
    if (status === 200) await sent;
    else await assert.rejects(sent, /Telegram API responded 429 Too Many Requests/);
    assert.equal(cancelled, true);
  });
}

test('a successful send keeps its destination, text and Markdown mode', async () => {
  let sentUrl: string | undefined, sent: RequestInit | undefined;
  await postTelegramMessage('test-token', 'test-chat', 'Escaped \\*text\\*', (async (url, init) => {
    sentUrl = String(url);
    sent = init;
    return new Response(null, { status: 200 });
  }) as typeof fetch);
  assert.equal(sentUrl, 'https://api.telegram.org/bottest-token/sendMessage');
  assert.equal(sent?.method, 'POST');
  assert.deepEqual(JSON.parse(String(sent?.body)), { chat_id: 'test-chat', text: 'Escaped \\*text\\*', parse_mode: 'MarkdownV2' });
});
