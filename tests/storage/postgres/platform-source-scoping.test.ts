import { describe, expect, it } from 'bun:test';
import type { QueryResult, QueryResultRow } from 'pg';
import { buildAgentEventIdempotencyKey } from '../../../src/storage/postgres/agent-events.js';
import { PostgresObservationRepository } from '../../../src/storage/postgres/observations.js';
import {
  buildServerSessionIdempotencyKey,
  PostgresServerSessionsRepository,
} from '../../../src/storage/postgres/server-sessions.js';
import type { PostgresQueryable } from '../../../src/storage/postgres/utils.js';

class CapturingClient implements PostgresQueryable {
  readonly calls: Array<{ text: string; values?: unknown[] }> = [];

  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<T>> {
    this.calls.push({ text, values });
    return {
      command: 'SELECT',
      rowCount: 0,
      oid: 0,
      fields: [],
      rows: [],
    };
  }
}

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

  it('filters externalSessionId lookup by normalized platformSource when supplied', async () => {
    const client = new CapturingClient();
    const repo = new PostgresServerSessionsRepository(client);

    await repo.findByExternalIdForScope({
      externalSessionId: 'shared-raw-session',
      projectId: 'project-1',
      teamId: 'team-1',
      platformSource: 'Cursor',
    });

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].text).toContain('platform_source = $5');
    expect(client.calls[0].values).toEqual([
      'shared-raw-session',
      'project-1',
      'team-1',
      true,
      'cursor',
    ]);
  });

  it('scopes externalSessionId lookup to legacy null platform when platformSource is null', async () => {
    const client = new CapturingClient();
    const repo = new PostgresServerSessionsRepository(client);

    await repo.findByExternalIdForScope({
      externalSessionId: 'shared-raw-session',
      projectId: 'project-1',
      teamId: 'team-1',
      platformSource: null,
    });

    expect(client.calls[0].text).toContain('platform_source IS NULL');
    expect(client.calls[0].values).toEqual([
      'shared-raw-session',
      'project-1',
      'team-1',
      true,
      null,
    ]);
  });

  it('includes platformSource in contentSessionId session linkage lookup when supplied', async () => {
    const client = new CapturingClient();
    const repo = new PostgresServerSessionsRepository(client);

    await repo.findIdByContentSessionId({
      contentSessionId: 'shared-raw-session',
      projectId: 'project-1',
      teamId: 'team-1',
      platformSource: 'codex',
    });

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].text).toContain('platform_source = $5');
    expect(client.calls[0].values).toEqual([
      'shared-raw-session',
      'project-1',
      'team-1',
      true,
      'codex',
    ]);
  });

  it('scopes contentSessionId session linkage lookup to legacy null platform when platformSource is null', async () => {
    const client = new CapturingClient();
    const repo = new PostgresServerSessionsRepository(client);

    await repo.findIdByContentSessionId({
      contentSessionId: 'shared-raw-session',
      projectId: 'project-1',
      teamId: 'team-1',
      platformSource: null,
    });

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].text).toContain('platform_source IS NULL');
    expect(client.calls[0].values).toEqual([
      'shared-raw-session',
      'project-1',
      'team-1',
      true,
      null,
    ]);
  });

  it('preserves back-compat session linkage when platformSource is omitted', async () => {
    const client = new CapturingClient();
    const repo = new PostgresServerSessionsRepository(client);

    await repo.findIdByContentSessionId({
      contentSessionId: 'shared-raw-session',
      projectId: 'project-1',
      teamId: 'team-1',
    });

    expect(client.calls[0].text).toContain('$4::boolean = false');
    expect(client.calls[0].values).toEqual([
      'shared-raw-session',
      'project-1',
      'team-1',
      false,
      null,
    ]);
  });

  it('filters observation search through linked server session platform_source', async () => {
    const client = new CapturingClient();
    const repo = new PostgresObservationRepository(client);

    await repo.search({
      projectId: 'project-1',
      teamId: 'team-1',
      query: 'auth bug',
      limit: 7,
      platformSource: 'Cursor CLI',
    });

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].text).toContain('LEFT JOIN server_sessions');
    expect(client.calls[0].text).toContain('server_sessions.platform_source = $5');
    expect(client.calls[0].text).toContain('observations.server_session_id IS NULL');
    expect(client.calls[0].text).toContain('INNER JOIN agent_events');
    expect(client.calls[0].text).toContain('agent_events.platform_source = $5');
    expect(client.calls[0].values).toEqual([
      'project-1',
      'team-1',
      'auth bug',
      7,
      'cursor',
    ]);
  });
});
