import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { ObserverJobStore } from '../../src/services/worker/ObserverJobStore.js';

describe('observer job settlement', () => {
  test('settles claimed source events in the observation storage transaction', () => {
    const db = new Database(':memory:');
    const sessions = new SessionStore(db);
    const sessionDbId = sessions.createSDKSession('content-job-settlement', 'project', 'prompt');
    sessions.ensureMemorySessionIdRegistered(sessionDbId, 'memory-job-settlement');
    const jobs = new ObserverJobStore(db);
    const job = jobs.admit(sessionDbId, {
      type: 'observation',
      tool_name: 'Read',
      tool_input: { path: 'src/a.ts' },
      tool_response: { type: 'text', text: 'a' },
      prompt_number: 1,
      toolUseId: 'settlement-event',
    });
    expect(jobs.claim(job.id)).toBe(true);

    sessions.storeObservations(
      'memory-job-settlement',
      'project',
      [{
        type: 'discovery',
        title: 'Settled source event',
        subtitle: null,
        facts: [],
        narrative: 'The observer source event was persisted.',
        concepts: [],
        files_read: [],
        files_modified: [],
      }],
      null,
      1,
      0,
      12345,
      'test-model',
      [job.id],
    );

    expect(jobs.metrics(sessionDbId)).toMatchObject({ settled: 1, pending: 0, claimed: 0 });
  });
});
