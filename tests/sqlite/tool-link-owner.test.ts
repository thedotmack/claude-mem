import { expect, it } from 'bun:test';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
it('does not change the first observation memory owner when a later batch reclaims a tool', () => {
  const s = new SessionStore(':memory:');
  try {
    s.upsertToolUse({
      toolUseId: 'tool',
      contentSessionId: 'content',
      toolName: 'Read',
      project: 'app',
    });
    expect(
      s.linkToolUsesToObservation({
        contentSessionId: 'content',
        toolUseIds: ['tool'],
        observationId: 1,
        memorySessionId: 'owner1',
      })
    ).toBe(1);
    expect(
      s.linkToolUsesToObservation({
        contentSessionId: 'content',
        toolUseIds: ['tool'],
        observationId: 2,
        memorySessionId: 'owner2',
      })
    ).toBe(0);
    expect(s.queryToolUses()[0]).toMatchObject({ observation_id: 1, memory_session_id: 'owner1' });
  } finally {
    s.close();
  }
});
it('allows the same owner to backfill a previously unknown memory session', () => {
  const s = new SessionStore(':memory:');
  try {
    s.upsertToolUse({
      toolUseId: 'tool',
      contentSessionId: 'content',
      toolName: 'Read',
      project: 'app',
    });
    s.linkToolUsesToObservation({
      contentSessionId: 'content',
      toolUseIds: ['tool'],
      observationId: 1,
    });
    s.linkToolUsesToObservation({
      contentSessionId: 'content',
      toolUseIds: ['tool'],
      observationId: 2,
      memorySessionId: 'wrong',
    });
    expect(s.queryToolUses()[0].memory_session_id).toBeNull();
    s.linkToolUsesToObservation({
      contentSessionId: 'content',
      toolUseIds: ['tool'],
      observationId: 1,
      memorySessionId: 'correct',
    });
    expect(s.queryToolUses()[0]).toMatchObject({ observation_id: 1, memory_session_id: 'correct' });
  } finally {
    s.close();
  }
});

it('lets the first authoritative observation replace an inferred session', () => {
  const store = new SessionStore(':memory:');
  try {
    store.upsertToolUse({
      toolUseId: 'tool',
      contentSessionId: 'content',
      toolName: 'Read',
      project: 'app',
      memorySessionId: 'inferred',
    });
    store.linkToolUsesToObservation({
      contentSessionId: 'content',
      toolUseIds: ['tool'],
      observationId: 1,
      memorySessionId: 'authoritative',
    });
    expect(store.queryToolUses()[0]).toMatchObject({
      observation_id: 1,
      memory_session_id: 'authoritative',
    });
  } finally {
    store.close();
  }
});

it('keeps a linked owner when a replay refreshes the raw tool payload', () => {
  const store = new SessionStore(':memory:');
  try {
    store.upsertToolUse({
      toolUseId: 'tool',
      contentSessionId: 'content',
      toolName: 'Read',
      project: 'app',
      memorySessionId: 'inferred',
      toolInput: 'first',
    });
    store.linkToolUsesToObservation({
      contentSessionId: 'content',
      toolUseIds: ['tool'],
      observationId: 1,
      memorySessionId: 'authoritative',
    });
    store.upsertToolUse({
      toolUseId: 'tool',
      contentSessionId: 'content',
      toolName: 'Read',
      project: 'app',
      memorySessionId: 'other',
      toolResponse: 'replayed result',
    });
    store.linkToolUsesToObservation({
      contentSessionId: 'content',
      toolUseIds: ['tool'],
      observationId: 2,
      memorySessionId: 'other',
    });
    expect(store.queryToolUses({ memorySessionId: 'authoritative' })[0]).toMatchObject({
      observation_id: 1,
      memory_session_id: 'authoritative',
      tool_response: 'replayed result',
    });
    expect(store.queryToolUses({ memorySessionId: 'other' })).toEqual([]);
  } finally {
    store.close();
  }
});
