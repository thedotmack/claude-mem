import { afterEach, describe, expect, it } from 'bun:test';
import express from 'express';
import type { Server } from 'node:http';
import { join } from 'node:path';
import { WorkViewRoutes } from '../../../../src/services/worker/http/routes/WorkViewRoutes.js';
import { SetupScan } from '../../../../src/services/prompt-import/setup-scan.js';
import { SessionStore } from '../../../../src/services/sqlite/SessionStore.js';

const FIXTURE_HOME = join(import.meta.dir, '..', '..', '..', 'fixtures', 'prompt-import', 'home');

let server: Server;
let routes: WorkViewRoutes;
let store: SessionStore;
let origin: string;
const controllers: AbortController[] = [];

async function start(setupScan: SetupScan | null) {
  routes = new WorkViewRoutes({
    databasePath: join(FIXTURE_HOME, 'no-work-state.db'), reviewPath: ':memory:', pollIntervalMs: 20,
    humanCopy: null, ledgerDir: null, setupScan,
  });
  const app = express();
  app.use(express.json());
  routes.setupRoutes(app);
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  origin = `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  controllers.forEach(controller => controller.abort());
  routes.close();
  store?.close();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

function scanWithFixtures() {
  store = new SessionStore(':memory:');
  return new SetupScan({
    getStore: () => store,
    now: () => Date.parse('2026-10-10T00:00:00.000Z'),
    progressIntervalMs: 0,
    scanOptions: { homeDirectory: FIXTURE_HOME, resolveProject: () => 'fixture' },
  });
}

function postScan(headers: Record<string, string> = { 'Content-Type': 'application/json', Origin: origin }, body = '{}') {
  return fetch(`${origin}/api/setup/scan`, { method: 'POST', headers, body });
}

/** Reads `setup-scan` events from the work view stream until one reports done. */
async function scanEventsUntilDone(): Promise<any[]> {
  const controller = new AbortController();
  controllers.push(controller);
  const response = await fetch(`${origin}/api/work-view/events`, { signal: controller.signal });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const events: any[] = [];
  let buffer = '';
  while (!events.some(event => event.done)) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      if (block.startsWith('event: setup-scan\n')) events.push(JSON.parse(block.split('\ndata: ')[1]));
      boundary = buffer.indexOf('\n\n');
    }
  }
  controller.abort();
  return events;
}

describe('setup scan endpoints', () => {
  it('answer 503 when the worker has no scan', async () => {
    await start(null);
    expect((await fetch(`${origin}/api/setup/scan`)).status).toBe(503);
    expect((await postScan()).status).toBe(503);
  });

  it('reject a start from outside the viewer page', async () => {
    await start(scanWithFixtures());
    expect((await postScan({ 'Content-Type': 'application/json', Origin: 'https://evil.example' })).status).toBe(403);
    expect((await postScan({ 'Content-Type': 'text/plain', Origin: origin })).status).toBe(403);
    expect((await postScan({ 'Content-Type': 'application/json', Origin: origin }, '{"days":5}')).status).toBe(400);
    expect((await (await fetch(`${origin}/api/setup/scan`)).json()).phase).toBe('idle');
  });

  it('keeps a failed extraction stopped until an explicit start and then completes the retry', async () => {
    const setupScan = scanWithFixtures();
    const attempts: boolean[] = [];
    const message = 'Hosted setup failed (HTTP 503): Please try again later.';
    setupScan.setExtractor(async (_prompts, improveProduct) => {
      attempts.push(improveProduct);
      if (attempts.length === 1) throw new Error(message);
    });
    await start(setupScan);
    expect((await postScan(undefined, '{"improveProduct":false}')).status).toBe(202);
    await setupScan.finished();
    const failed = await (await fetch(`${origin}/api/setup/scan`)).json();
    expect(failed).toMatchObject({ phase: 'failed', done: true, error: message });
    expect(attempts).toEqual([false]);

    expect((await postScan()).status).toBe(202);
    await setupScan.finished();
    const retried = await (await fetch(`${origin}/api/setup/scan`)).json();
    expect(retried).toMatchObject({ phase: 'done', done: true, error: null, improveProduct: false, added: 0 });
    expect(attempts).toEqual([false, false]);
  });

  it('start the scan, stream its progress on the work view events, and report where prompts came from', async () => {
    await start(scanWithFixtures());
    const events = scanEventsUntilDone();
    await new Promise(resolve => setTimeout(resolve, 50));
    const started = await postScan();
    expect(started.status).toBe(202);
    const streamed = await events;
    expect(streamed.map(event => event.phase)).toEqual(expect.arrayContaining(['reading', 'checking', 'saving', 'done']));
    const percents = streamed.map(event => event.percent);
    expect(percents).toEqual([...percents].sort((left, right) => left - right));

    const state = await (await fetch(`${origin}/api/setup/scan`)).json();
    expect(state).toMatchObject({ phase: 'done', done: true, percent: 100, added: 13 });
    expect(state.agents.map((agent: any) => [agent.id, agent.label, agent.detected, agent.prompts, agent.fromMemory, agent.fromTranscripts])).toEqual([
      ['claude-code', 'Claude Code', true, 5, 0, 5],
      ['codex', 'Codex', true, 1, 0, 1],
      ['gemini-cli', 'Gemini CLI', true, 4, 0, 4],
      ['antigravity-cli', 'Antigravity CLI', true, 2, 0, 2],
      ['opencode', 'OpenCode', true, 1, 0, 1],
    ]);
  });
});
