import { describe, expect, it } from 'bun:test';
import { buildAgentEventIdempotencyKey } from '../../../src/storage/postgres/agent-events.js';
import {
  buildServerSessionIdempotencyKey,
} from '../../../src/storage/postgres/server-sessions.js';

describe('server-beta Postgres platform source scoping', () => {
  it('includes normalized platformSource in native agent event idempotency keys when supplied', () => {
    const base = {
      teamId: 'team-1',
      projectId: 'project-1',
      sourceAdapter: 'api',
      sourceEventId: 'native-event-1',
      eventType: 'tool_use',
      occurredAt: '2026-06-29T18:00:00.000Z',
      payload: { tool: 'read' },
    };

    const legacy = buildAgentEventIdempotencyKey(base);
    const explicitNull = buildAgentEventIdempotencyKey({ ...base, platformSource: null });
    const cursor = buildAgentEventIdempotencyKey({ ...base, platformSource: 'Cursor' });
    const cursorCli = buildAgentEventIdempotencyKey({ ...base, platformSource: 'cursor-cli' });
    const codex = buildAgentEventIdempotencyKey({ ...base, platformSource: 'Codex CLI' });

    expect(explicitNull).toBe(legacy);
    expect(cursor).toBe(cursorCli);
    expect(cursor).not.toBe(codex);
    expect(cursor).not.toBe(legacy);
  });

  it('includes normalized platformSource in derived agent event idempotency keys when supplied', () => {
    const base = {
      teamId: 'team-1',
      projectId: 'project-1',
      sourceAdapter: 'api',
      contentSessionId: 'shared-content-session',
      eventType: 'assistant_response',
      occurredAt: '2026-06-29T18:05:00.000Z',
      payload: { nested: { b: 2, a: 1 } },
    };

    const legacy = buildAgentEventIdempotencyKey(base);
    const explicitNull = buildAgentEventIdempotencyKey({ ...base, platformSource: null });
    const cursor = buildAgentEventIdempotencyKey({ ...base, platformSource: 'Cursor' });
    const codex = buildAgentEventIdempotencyKey({ ...base, platformSource: 'codex' });

    expect(explicitNull).toBe(legacy);
    expect(cursor).not.toBe(codex);
    expect(cursor).not.toBe(legacy);
  });

  it('includes normalized platformSource in external session idempotency keys when supplied', () => {
    const base = {
      projectId: 'project-1',
      teamId: 'team-1',
      externalSessionId: 'shared-raw-session',
    };

    const legacy = buildServerSessionIdempotencyKey(base);
    const cursor = buildServerSessionIdempotencyKey({ ...base, platformSource: 'Cursor' });
    const cursorCli = buildServerSessionIdempotencyKey({ ...base, platformSource: 'cursor-cli' });
    const codex = buildServerSessionIdempotencyKey({ ...base, platformSource: 'Codex CLI' });

    expect(cursor).toBe(cursorCli);
    expect(cursor).not.toBe(codex);
    expect(legacy).not.toBe(cursor);
  });

});
