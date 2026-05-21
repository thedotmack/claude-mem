import { afterEach, describe, expect, test } from 'bun:test';
import { SearchManager } from '../../../src/services/worker/SearchManager.js';
import { FormattingService } from '../../../src/services/worker/FormattingService.js';
import { TimelineService } from '../../../src/services/worker/TimelineService.js';
import { ModeManager } from '../../../src/services/domain/ModeManager.js';
import {
  __setExternalMemoryDriverLoaderForTesting,
  closeExternalMemorySyncService,
} from '../../../src/services/external-memory/sync-service.js';

const savedEnv = { ...process.env };

class FakePrimaryPool {
  totalCount = 1;
  idleCount = 1;
  waitingCount = 0;
  queries: Array<{ text: string; values?: unknown[] }> = [];

  async connect() {
    return {
      query: this.query.bind(this),
      release() {},
    };
  }

  async query(text: string, values?: unknown[]) {
    this.queries.push({ text, values });
    if (text.includes('format_type(a.atttypid, a.atttypmod)')) {
      return { rows: [{ embedding_type: 'vector(1536)' }], rowCount: 1 };
    }
    if (text.includes('WITH before_items')) {
      return { rows: [{
        id: 77,
        memory_session_id: 'memory-session-primary',
        project: 'claude-mem',
        kind: 'observation',
        type: 'decision',
        title: 'Primary timeline anchor',
        subtitle: null,
        content: 'Primary Postgres timeline hit.',
        facts: [],
        narrative: 'Timeline should hydrate from Postgres, not SQLite.',
        concepts: ['postgres'],
        files_read: [],
        files_modified: [],
        prompt_number: 1,
        discovery_tokens: 10,
        metadata: { primary: true },
        created_at: null,
        created_at_epoch: 1_700_000_000_000,
      }], rowCount: 1 };
    }
    if (text.includes('SELECT id, memory_session_id, project, kind')) {
      return { rows: [{
        id: 77,
        memory_session_id: 'memory-session-primary',
        project: 'claude-mem',
        kind: 'observation',
        type: 'decision',
        title: 'Primary search hit',
        subtitle: null,
        content: 'Primary Postgres search hit.',
        facts: [],
        narrative: 'Search should hydrate from Postgres, not SQLite.',
        concepts: ['postgres'],
        files_read: [],
        files_modified: [],
        prompt_number: 1,
        discovery_tokens: 10,
        metadata: { primary: true },
        created_at: null,
        created_at_epoch: 1_700_000_000_000,
      }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }

  async end() {}
}

class FakeRedis {
  constructor(_url: string, _options: unknown) {}
  async quit() { return 'OK'; }
  disconnect() {}
}

function throwingSqlite() {
  return new Proxy({}, {
    get(_target, prop) {
      throw new Error(`SQLite path should not be used in primary external search (${String(prop)})`);
    },
  });
}

afterEach(async () => {
  process.env = { ...savedEnv };
  await closeExternalMemorySyncService();
});

describe('SearchManager external primary mode', () => {
  test('search hydrates worker/MCP results from Postgres primary without SQLite reads', async () => {
    const pool = new FakePrimaryPool();
    const restore = __setExternalMemoryDriverLoaderForTesting(async () => ({
      Pool: class {
        constructor(_options: unknown) {
          return pool;
        }
      },
      Redis: FakeRedis,
    }));
    process.env.CLAUDE_MEM_EXTERNAL_MEMORY_ENABLED = 'true';
    process.env.CLAUDE_MEM_EXTERNAL_MEMORY_MODE = 'primary';
    process.env.CLAUDE_MEM_PG_URL = 'postgres://claude_mem:test@127.0.0.1:15432/claude_mem';
    process.env.CLAUDE_MEM_VALKEY_URL = 'redis://:test@127.0.0.1:16379';

    try {
      ModeManager.getInstance().loadMode('code');
      const manager = new SearchManager(
        throwingSqlite() as never,
        throwingSqlite() as never,
        null,
        new FormattingService(),
        new TimelineService()
      );

      const result = await manager.search({
        query: 'primary search',
        type: 'observations',
        project: 'claude-mem',
        format: 'json',
      });

      expect(result.totalResults).toBe(1);
      expect(result.observations[0].id).toBe(77);
      expect(result.observations[0].title).toBe('Primary search hit');
      expect(pool.queries.some(query => query.text.includes("content_search @@ websearch_to_tsquery('english'"))).toBe(true);
    } finally {
      restore();
    }
  });

  test('timeline hydrates worker/MCP context from Postgres primary without SQLite reads', async () => {
    const pool = new FakePrimaryPool();
    const restore = __setExternalMemoryDriverLoaderForTesting(async () => ({
      Pool: class {
        constructor(_options: unknown) {
          return pool;
        }
      },
      Redis: FakeRedis,
    }));
    process.env.CLAUDE_MEM_EXTERNAL_MEMORY_ENABLED = 'true';
    process.env.CLAUDE_MEM_EXTERNAL_MEMORY_MODE = 'primary';
    process.env.CLAUDE_MEM_PG_URL = 'postgres://claude_mem:test@127.0.0.1:15432/claude_mem';
    process.env.CLAUDE_MEM_VALKEY_URL = 'redis://:test@127.0.0.1:16379';

    try {
      ModeManager.getInstance().loadMode('code');
      const manager = new SearchManager(
        throwingSqlite() as never,
        throwingSqlite() as never,
        null,
        new FormattingService(),
        new TimelineService()
      );

      const result = await manager.timeline({
        query: 'primary timeline',
        project: 'claude-mem',
        depth_before: 2,
        depth_after: 2,
      });

      expect(result.content[0].text).toContain('Primary timeline anchor');
      expect(pool.queries.some(query => query.text.includes('WITH before_items'))).toBe(true);
    } finally {
      restore();
    }
  });

  test('context timeline accepts HTTP-style string anchors from Postgres primary', async () => {
    const pool = new FakePrimaryPool();
    const restore = __setExternalMemoryDriverLoaderForTesting(async () => ({
      Pool: class {
        constructor(_options: unknown) {
          return pool;
        }
      },
      Redis: FakeRedis,
    }));
    process.env.CLAUDE_MEM_EXTERNAL_MEMORY_ENABLED = 'true';
    process.env.CLAUDE_MEM_EXTERNAL_MEMORY_MODE = 'primary';
    process.env.CLAUDE_MEM_PG_URL = 'postgres://claude_mem:test@127.0.0.1:15432/claude_mem';
    process.env.CLAUDE_MEM_VALKEY_URL = 'redis://:test@127.0.0.1:16379';

    try {
      ModeManager.getInstance().loadMode('code');
      const manager = new SearchManager(
        throwingSqlite() as never,
        throwingSqlite() as never,
        null,
        new FormattingService(),
        new TimelineService()
      );

      const result = await manager.getContextTimeline({
        anchor: '77',
        project: 'claude-mem',
        depth_before: 2,
        depth_after: 2,
      });

      expect(result.content[0].text).toContain('Timeline around anchor: 77');
      expect(result.content[0].text).toContain('Primary timeline anchor');
      expect(pool.queries.some(query => query.text.includes('id = ANY($1::bigint[])'))).toBe(true);
      expect(pool.queries.some(query => query.text.includes('WITH before_items'))).toBe(true);
    } finally {
      restore();
    }
  });

  test('timeline by query uses Postgres primary for both anchor search and window hydration', async () => {
    const pool = new FakePrimaryPool();
    const restore = __setExternalMemoryDriverLoaderForTesting(async () => ({
      Pool: class {
        constructor(_options: unknown) {
          return pool;
        }
      },
      Redis: FakeRedis,
    }));
    process.env.CLAUDE_MEM_EXTERNAL_MEMORY_ENABLED = 'true';
    process.env.CLAUDE_MEM_EXTERNAL_MEMORY_MODE = 'primary';
    process.env.CLAUDE_MEM_PG_URL = 'postgres://claude_mem:test@127.0.0.1:15432/claude_mem';
    process.env.CLAUDE_MEM_VALKEY_URL = 'redis://:test@127.0.0.1:16379';

    try {
      ModeManager.getInstance().loadMode('code');
      const manager = new SearchManager(
        throwingSqlite() as never,
        throwingSqlite() as never,
        null,
        new FormattingService(),
        new TimelineService()
      );

      const result = await manager.getTimelineByQuery({
        query: 'primary timeline',
        project: 'claude-mem',
        depth_before: 2,
        depth_after: 2,
      });

      expect(result.content[0].text).toContain('Timeline for query: "primary timeline"');
      expect(result.content[0].text).toContain('Primary timeline anchor');
      expect(pool.queries.some(query => query.text.includes("content_search @@ websearch_to_tsquery('english'"))).toBe(true);
      expect(pool.queries.some(query => query.text.includes('WITH before_items'))).toBe(true);
    } finally {
      restore();
    }
  });
});
