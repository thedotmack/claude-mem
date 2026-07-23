import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { ObserverJobStore } from '../../src/services/worker/ObserverJobStore.js';

const event = (toolUseId: string) => ({
  type: 'observation' as const,
  tool_name: 'Read',
  tool_input: { path: 'src/example.ts' },
  tool_response: { type: 'text', text: 'example' },
  prompt_number: 1,
  toolUseId,
});

describe('ObserverJobStore', () => {
  test('admits a source event exactly once and restores claimed work after restart', () => {
    const db = new Database(':memory:');
    const first = new ObserverJobStore(db);
    const created = first.admit(7, event('tool-7'));
    const duplicate = first.admit(7, event('tool-7'));

    expect(created.admitted).toBe(true);
    expect(duplicate.admitted).toBe(false);
    expect(first.claim(created.id)).toBe(true);

    const restarted = new ObserverJobStore(db);
    const jobs = restarted.recover(7);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ id: created.id, state: 'pending', payload: event('tool-7') });
  });

  test('records bounded retry metadata and terminal quarantine without settling the source event', () => {
    const db = new Database(':memory:');
    const store = new ObserverJobStore(db);
    const created = store.admit(8, event('tool-8'));
    store.claim(created.id);

    store.reset([created.id], 'malformed_output', 12345);
    expect(store.metrics(8)).toMatchObject({ pending: 1, claimed: 0, quarantined: 0 });
    expect(store.recover(8)[0]).toMatchObject({
      attempts: 1,
      lastErrorClass: 'malformed_output',
      nextAttemptAtEpoch: 12345,
    });

    expect(store.claim(created.id)).toBe(true);
    store.quarantine([created.id], 'malformed_output');
    expect(store.metrics(8)).toMatchObject({ pending: 0, claimed: 0, quarantined: 1 });
    expect(store.recover(8)).toHaveLength(0);
  });

  test('settles only the claimed source event and persists the generation checkpoint', () => {
    const db = new Database(':memory:');
    const store = new ObserverJobStore(db);
    const first = store.admit(9, event('tool-9a'));
    const second = store.admit(9, event('tool-9b'));
    store.claim(first.id);
    store.claim(second.id);

    store.checkpoint(9, 2, { summary: 'durable context', recentEventIds: ['tool-9a'] });
    store.settle([first.id]);

    expect(store.metrics(9)).toMatchObject({ pending: 0, claimed: 1, quarantined: 0, settled: 1 });
    expect(store.getCheckpoint(9)).toEqual({ generation: 2, checkpoint: { summary: 'durable context', recentEventIds: ['tool-9a'] } });
  });

  test('reports a blocked observer only for durable authentication/setup failures', () => {
    const db = new Database(':memory:');
    const store = new ObserverJobStore(db);
    const job = store.admit(11, event('auth-1'));
    expect(store.claim(job.id)).toBe(true);
    store.reset([job.id], 'auth_invalid');

    expect(store.status()).toMatchObject({
      state: 'blocked', pending: 1, lastErrorClass: 'auth_invalid',
    });
  });
});
