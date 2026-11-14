import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { rmSync } from 'node:fs';
import { jevClient } from '../../src/services/work-view/request-judge.mjs';
import { labelOpenWorkState, readWorkStateLabels } from '../../src/services/work-view/work-state-labels.mjs';
import { scratchDir } from '../helpers/scratch-dir.js';

const NOW = Date.UTC(2026, 10, 14);
const encoder = new TextEncoder();

/** Headers arrive normally; the body fails after its first JSON fragment. */
function brokenResponse(error: Error, status = 200): Response {
  let started = false;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (started) controller.error(error);
      else { started = true; controller.enqueue(encoder.encode('{"answers":')); }
    },
  }), { status });
}

function successfulResponse(questions: Record<string, unknown>): Response {
  return Response.json({ answers: Object.fromEntries(Object.keys(questions).map(id => {
    const choice = id === 'state' ? 'working' : 'none';
    return [id, { type: 'choice', choice, probabilities: { [choice]: 0.9 } }];
  })) });
}

describe('Jev response body transport failures', () => {
  for (const status of [200, 429, 503]) {
    for (const failure of ['disconnect', 'deadline'] as const) {
      it(`classifies a ${failure} after HTTP ${status} headers without resending`, async () => {
        let sends = 0;
        const error = failure === 'disconnect'
          ? new TypeError('Connection terminated while reading body')
          : new DOMException('The request timed out', 'TimeoutError');
        const client = jevClient({
          url: 'https://decisions.invalid/', apiKey: 'synthetic-test-key',
          fetchImpl: (async () => { sends++; return brokenResponse(error, status); }) as typeof fetch,
        });
        await expect(client.decide({}, {})).rejects.toThrow(`Jev request failed: ${error.message}`);
        expect(sends).toBe(1);
      });
    }
  }

  for (const failure of ['disconnect', 'deadline'] as const) {
    it(`leaves the unchanged item eligible for the next refresh after a body ${failure}`, async () => {
      const dir = scratchDir('jev-body-recovery');
      const database = new Database(':memory:');
      database.exec('CREATE TABLE work_state_entries (id INTEGER PRIMARY KEY, project TEXT, list_name TEXT, fields TEXT, created_at_epoch INTEGER)');
      for (const task of ['First', 'Second']) {
        database.prepare('INSERT INTO work_state_entries (project, list_name, fields, created_at_epoch) VALUES (?, ?, ?, ?)')
          .run('repo', 'release', JSON.stringify({ task, status: 'doing', note: 'Building the release' }), NOW - 1000);
      }
      const calls: string[] = [];
      let disconnected = true;
      const client = jevClient({
        url: 'https://decisions.invalid/', apiKey: 'synthetic-test-key',
        fetchImpl: (async (_url: unknown, init: RequestInit) => {
          const { state, questions } = JSON.parse(String(init.body));
          calls.push(state.item.name);
          if (disconnected) return brokenResponse(failure === 'disconnect'
            ? new TypeError('Connection terminated while reading body')
            : new DOMException('The request timed out', 'TimeoutError'));
          return successfulResponse(questions);
        }) as typeof fetch,
      });
      const run = () => labelOpenWorkState({ dir, database, client, now: () => NOW, wait: async () => {} });
      try {
        expect(await run()).toMatchObject({ labeled: 0, notReached: 2, failed: null, serviceFailure: expect.stringContaining('Jev request failed:') });
        expect(calls).toEqual(['First']);
        expect(readWorkStateLabels(dir)).toEqual({ schemaVersion: 1, labels: {}, failures: {} });

        disconnected = false;
        expect(await run()).toMatchObject({ labeled: 2, notReached: 0, failed: null, serviceFailure: null });
        expect(calls).toEqual(['First', 'First', 'Second']);
        expect(Object.keys(readWorkStateLabels(dir).labels)).toEqual(['1', '2']);
        expect(readWorkStateLabels(dir).failures).toEqual({});

        expect(await run()).toMatchObject({ labeled: 0, notReached: 0 });
        expect(calls).toHaveLength(3);
        expect(database.query('SELECT COUNT(*) AS n FROM work_state_entries').get()).toEqual({ n: 2 });
      } finally { database.close(); rmSync(dir, { recursive: true, force: true }); }
    });
  }

  it('keeps complete HTTP errors and invalid answers outside the transport classification', async () => {
    const responses = [
      Response.json({ error: { code: 'bad_request', message: 'Invalid question' } }, { status: 400 }),
      new Response('not JSON'),
      successfulResponse({ state: {} }),
    ];
    let sends = 0;
    const client = jevClient({
      url: 'https://decisions.invalid/', apiKey: 'synthetic-test-key',
      fetchImpl: (async () => responses[sends++]) as typeof fetch,
    });
    await expect(client.decide({}, {})).rejects.toThrow('Jev answered 400 bad_request: Invalid question');
    await expect(client.decide({}, {})).rejects.toThrow('Jev answered without answers.');
    expect(await client.decide({}, { state: {} })).toMatchObject({ answers: { state: { choice: 'working' } } });
    expect(sends).toBe(3);
  });
});
