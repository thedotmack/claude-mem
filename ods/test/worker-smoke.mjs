/** Exercise the real CMEM worker/SQLite with a deterministic local observer. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOdsMemory } from '../native/claude_mem.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ods-worker-smoke-'));
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let observerRequests = 0;
const observer = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw || '{}');
  observerRequests++;
  assert.equal(body.model, 'ods/current');
  const last = body.messages?.at(-1)?.content ?? '';
  const content = /CRITICAL TAG REQUIREMENT/.test(last)
    ? '<summary><request>Remember the accent</request><investigated>ODS canary</investigated><learned>The accent is blue</learned><completed>Recorded native ODS memory</completed><next_steps>Recall it</next_steps><notes>Local fixture</notes></summary>'
    : '<observation><type>decision</type><title>ODS accent is blue</title><subtitle>Native memory canary</subtitle><facts><fact>The ODS accent is blue.</fact></facts><narrative>The owner selected a blue accent in ODS.</narrative><concepts><concept>how-it-works</concept></concepts><files_read></files_read><files_modified></files_modified></observation>';
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 50, completion_tokens: 50, total_tokens: 100 } }));
});
const observerPort = await listen(observer);
const reservation = createServer();
const workerPort = await listen(reservation);
await new Promise(resolve => reservation.close(resolve));
const env = { ...process.env,
  CLAUDE_MEM_DATA_DIR: path.join(temp, 'memory'), CLAUDE_CONFIG_DIR: path.join(temp, 'claude'),
  CLAUDE_MEM_WORKER_HOST: '127.0.0.1', CLAUDE_MEM_WORKER_PORT: String(workerPort),
  CLAUDE_MEM_CHROMA_ENABLED: 'false', CLAUDE_MEM_TELEMETRY: 'false', DO_NOT_TRACK: '1',
  CLAUDE_MEM_WELCOME_HINT_ENABLED: 'false', CLAUDE_MEM_WORK_STATE_ENABLED: 'false',
  CLAUDE_MEM_PROVIDER: 'openai-compatible', CLAUDE_MEM_OPENAI_COMPAT_PRESET: 'custom',
  CLAUDE_MEM_OPENAI_COMPAT_BASE_URL: `http://127.0.0.1:${observerPort}/v1`,
  CLAUDE_MEM_OPENAI_COMPAT_MODEL: 'ods/current', CLAUDE_MEM_OPENAI_COMPAT_API_KEY: '',
};
const logPath = path.join(temp, 'worker.log'), log = fs.openSync(logPath, 'w');
const worker = spawn(process.env.BUN_BIN || 'bun', ['plugin/scripts/worker-service.cjs', '--daemon'], {
  cwd: root, env, stdio: ['ignore', log, log],
});
const workerUrl = `http://127.0.0.1:${workerPort}`;
const get = route => fetch(`${workerUrl}${route}`, { signal: AbortSignal.timeout(1500) });
async function waitFor(predicate, label) {
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    if (worker.exitCode !== null) throw new Error(`Worker exited ${worker.exitCode}; log: ${logPath}`);
    try { if (await predicate()) return; } catch { /* Startup HTTP availability is polled below. */ }
    await delay(250);
  }
  throw new Error(`${label} timed out; log: ${logPath}`);
}
try {
  await waitFor(async () => (await get('/api/health')).ok, 'Worker startup');
  const memory = createOdsMemory({ enabled: true, url: workerUrl, timeoutMs: 3000 });
  const sessionId = `ods-${'b'.repeat(64)}`, project = `ods/${'b'.repeat(64)}`;
  const turn = memory.turn({ sessionId, requestId: 'canary-1', messages: [{ role: 'user', content: 'Keep the accent blue.' }] });
  await turn.prepare();
  turn.complete({ choices: [{ message: { content: 'The accent stays blue.' } }] }, { status: 'none' });
  await memory.flush();
  await waitFor(async () => {
    const value = await (await get(`/api/observations?${new URLSearchParams({ project })}`)).json();
    return JSON.stringify(value).includes('ODS accent is blue');
  }, 'Observation extraction');
  const next = memory.turn({ sessionId, requestId: 'canary-2', messages: [{ role: 'user', content: 'What color did we select?' }] });
  const context = await next.prepare();
  assert.match(context?.content ?? '', /blue/i);
  assert.ok(observerRequests > 0);
  // The released worker deliberately refuses to delete an active observer.
  // Preserve that boundary rather than pretending this is a deletion receipt.
  await assert.rejects(memory.forget(sessionId), /memory-deletion-unconfirmed/);
  const remaining = await (await get(`/api/observations?${new URLSearchParams({ project })}`)).json();
  assert.ok(JSON.stringify(remaining).includes('ODS accent is blue'), 'an active-session refusal does not partly erase memory');
  console.log(JSON.stringify({ status: 'passed', capture: true, localObserver: true, recall: true, activeDeleteRefused: true, observerRequests }));
} finally {
  worker.kill('SIGTERM');
  await Promise.race([new Promise(resolve => worker.once('exit', resolve)), delay(3000)]);
  if (worker.exitCode === null) worker.kill('SIGKILL');
  observer.closeAllConnections();
  await new Promise(resolve => observer.close(resolve));
  fs.closeSync(log);
  // Logs are retained in the printed temporary directory on failure.
}
