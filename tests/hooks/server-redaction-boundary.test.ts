import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { ServerClient } from '../../src/services/hooks/server-client.js';
import { AgentEventsRepository, ProjectsRepository, ServerSessionsRepository } from '../../src/storage/sqlite/index.js';
import { PostgresServerSessionsRepository } from '../../src/storage/postgres/server-sessions.js';
import { PostgresAgentEventsRepository } from '../../src/storage/postgres/agent-events.js';
import type { PostgresQueryable } from '../../src/storage/postgres/utils.js';
import { _resetRedactionConfigCache } from '../../src/utils/redaction.js';

const KEY = `sk-${'FixtureKey123'.repeat(3)}`;
const PASSWORD = 'fixturePassword123';
const keys = ['CLAUDE_MEM_REDACT_ENABLED', 'CLAUDE_MEM_REDACT_GENERIC_ENABLED', 'CLAUDE_MEM_REDACT_DISABLED_BUILTINS'] as const;
let original: Array<string | undefined>;

beforeEach(() => {
  original = keys.map(key => process.env[key]);
  process.env.CLAUDE_MEM_REDACT_ENABLED = 'true';
  process.env.CLAUDE_MEM_REDACT_GENERIC_ENABLED = 'true';
  process.env.CLAUDE_MEM_REDACT_DISABLED_BUILTINS = '';
  _resetRedactionConfigCache();
});
afterEach(() => {
  keys.forEach((key, index) => {
    if (original[index] === undefined) delete process.env[key];
    else process.env[key] = original[index];
  });
  _resetRedactionConfigCache();
});

const metadata = () => ({ prompt: `Please inspect ${KEY}`, nested: { password: PASSWORD, note: '  keep whitespace\n' }, private: '<private>hidden</private>' });
const redacted = () => ({ prompt: "Please inspect <redacted type='openai_key'/>", nested: { password: "<redacted type='generic_password'/>", note: '  keep whitespace\n' }, private: '' });

describe('server capture redaction boundaries', () => {
  it('redacts start metadata and event content before the real HTTP request reaches storage', async () => {
    const db = new Database(':memory:');
    const project = new ProjectsRepository(db).create({ name: 'Owned redaction fixture' });
    const sessions = new ServerSessionsRepository(db);
    const events = new AgentEventsRepository(db);
    const requests: any[] = [];
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
      const body = await request.json();
      requests.push(body);
      if (new URL(request.url).pathname === '/v1/sessions/start') return Response.json({ session: sessions.create(body) });
      return Response.json({ event: events.create(body) });
    } });
    try {
      const client = new ServerClient({ serverBaseUrl: `http://127.0.0.1:${server.port}`, apiKey: 'cmem_fixture' });
      const input = metadata();
      const start = await client.startSession({ projectId: project.id, contentSessionId: 'owned-session', metadata: input });
      const event = await client.recordEvent({ projectId: project.id, serverSessionId: start.session.id, sourceType: 'hook', eventType: 'tool_use', occurredAtEpoch: Date.now(), payload: input });
      expect(requests.map(body => body.metadata ?? body.payload)).toEqual([redacted(), redacted()]);
      expect(sessions.getById(start.session.id)?.metadata).toEqual(redacted());
      expect(events.getById(event.event.id)?.payload).toEqual(redacted());
      expect(input).toEqual(metadata());
    } finally { await server.stop(true); db.close(); }
  });

  it('redacts a direct SQLite session write from a client that did not sanitize metadata', () => {
    const db = new Database(':memory:');
    try {
      const project = new ProjectsRepository(db).create({ name: 'Direct storage fixture' });
      const session = new ServerSessionsRepository(db).create({ projectId: project.id, metadata: metadata() });
      const stored = db.query('SELECT metadata FROM server_sessions WHERE id = ?').get(session.id) as { metadata: string };
      expect(JSON.parse(stored.metadata)).toEqual(redacted());
    } finally { db.close(); }
  });

  it('applies the same policy to Postgres session and event metadata parameters', async () => {
    // Exercise each production repository through its query boundary. No
    // Postgres server is needed to check the data handed to the SQL driver.
    const writes: Array<{ sql: string; values: unknown[] }> = [];
    const now = new Date();
    const client = { async query(sql: string, values: unknown[] = []) {
      if (sql.includes('SELECT id FROM projects')) return { rows: [{ id: 'project' }] };
      writes.push({ sql, values });
      return { rows: [{ id: 'row', project_id: 'project', team_id: 'team', metadata: JSON.parse(String(values[10])), payload: {}, started_at: now, created_at: now, updated_at: now, occurred_at: now, received_at: now }] };
    } } as PostgresQueryable;
    await new PostgresServerSessionsRepository(client).create({ projectId: 'project', teamId: 'team', metadata: metadata() });
    await new PostgresAgentEventsRepository(client).create({ projectId: 'project', teamId: 'team', sourceAdapter: 'hook', eventType: 'tool_use', occurredAt: now, metadata: metadata() });
    expect(writes).toHaveLength(2);
    expect(writes.map(write => JSON.parse(String(write.values[10])))).toEqual([redacted(), redacted()]);
  });

  it('keeps disabled redaction and disabled builtins while always removing private tags', () => {
    const client = new ServerClient({ serverBaseUrl: 'http://127.0.0.1:1', apiKey: 'cmem_fixture' });
    process.env.CLAUDE_MEM_REDACT_ENABLED = 'false';
    _resetRedactionConfigCache();
    expect(client.buildStartSessionPayload({ projectId: 'p', metadata: metadata() }).metadata).toEqual({ ...metadata(), private: '' });
    process.env.CLAUDE_MEM_REDACT_ENABLED = 'true';
    process.env.CLAUDE_MEM_REDACT_DISABLED_BUILTINS = 'openai_key';
    _resetRedactionConfigCache();
    expect(client.buildStartSessionPayload({ projectId: 'p', metadata: metadata() }).metadata).toEqual({ ...redacted(), prompt: metadata().prompt });
  });
});
