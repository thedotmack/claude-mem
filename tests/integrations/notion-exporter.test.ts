import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import {
  NOTION_API_VERSION,
  NOTION_PROPERTIES,
  NotionExporter,
  buildNotionChildren,
  buildNotionProperties,
  getNotionExporter,
  normalizeNotionId,
  notifyNotion,
  resetNotionExporterForTests,
  type NotionObservationRecord,
} from '../../src/services/integrations/NotionExporter.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import { logger } from '../../src/utils/logger.js';

const DATABASE_ID = '0123456789abcdef0123456789abcdef';
const DASHED_ID = '01234567-89ab-cdef-0123-456789abcdef';

const observation = {
  type: 'bugfix',
  title: 'Fixed retry loop',
  subtitle: 'Backoff never reset',
  facts: ['Reset happens on success', 'Cap is 60s'],
  narrative: 'First paragraph.\n\nSecond paragraph.',
  concepts: ['retry', 'how-it-works'],
  files_read: ['src/a.ts'],
  files_modified: ['src/b.ts', 'src/c.ts'],
};

function record(overrides: Partial<NotionObservationRecord> = {}): NotionObservationRecord {
  return {
    observationId: 42,
    observation,
    project: 'claude-mem',
    memorySessionId: 'mem-session-1',
    createdAtEpoch: Date.UTC(2026, 9, 15, 12, 0, 0),
    ...overrides,
  };
}

/** A complete schema: every exporter property exists with the expected type. */
function fullSchema(): Record<string, { type: string }> {
  const properties: Record<string, { type: string }> = { Name: { type: 'title' } };
  for (const { name, type } of Object.values(NOTION_PROPERTIES)) properties[name] = { type };
  return properties;
}

type Call = { url: string; method: string; body: any; headers: Record<string, string> };
type Responder = (call: Call) => Response;

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

/** A fake clock: sleep advances it, so throttle and backoff waits are observable and instant. */
function harness(responder: Responder, options: Partial<ConstructorParameters<typeof NotionExporter>[0]> = {}) {
  let clock = 1_000_000;
  const sleeps: number[] = [];
  const calls: Call[] = [];
  const requestTimes: number[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const call: Call = {
      url,
      method: String(init.method),
      body: init.body ? JSON.parse(String(init.body)) : undefined,
      headers: init.headers as Record<string, string>,
    };
    calls.push(call);
    requestTimes.push(clock);
    return responder(call);
  });
  const exporter = new NotionExporter({
    token: 'ntn_test_token',
    databaseId: DASHED_ID,
    fetchImpl,
    now: () => clock,
    sleep: async ms => {
      sleeps.push(ms);
      clock += ms;
    },
    ...options,
  });
  return { exporter, calls, sleeps, requestTimes };
}

/** Routes a healthy Notion: schema GET, query (no match unless `existingPageId`), create/update. */
function healthyNotion(existingPageId: string | null = null, schema = fullSchema()): Responder {
  return call => {
    if (call.method === 'GET') return json({ object: 'database', properties: schema });
    if (call.url.endsWith('/query')) return json({ results: existingPageId ? [{ id: existingPageId }] : [] });
    if (call.method === 'PATCH' && call.url.includes('/databases/')) return json({ object: 'database' });
    return json({ object: 'page', id: existingPageId ?? 'new-page' });
  };
}

describe('Notion exporter', () => {
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    errorSpy = spyOn(logger, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    resetNotionExporterForTests();
  });

  describe('mapping', () => {
    it('maps every observation field onto its database property', () => {
      const properties = buildNotionProperties(record(), 'Name') as Record<string, any>;
      expect(properties.Name.title[0].text.content).toBe('Fixed retry loop');
      expect(properties['Observation ID']).toEqual({ number: 42 });
      expect(properties.Type).toEqual({ select: { name: 'bugfix' } });
      expect(properties.Project).toEqual({ select: { name: 'claude-mem' } });
      expect(properties.Subtitle.rich_text[0].text.content).toBe('Backoff never reset');
      expect(properties.Concepts.multi_select).toEqual([{ name: 'retry' }, { name: 'how-it-works' }]);
      expect(properties['Files Read'].rich_text[0].text.content).toBe('src/a.ts');
      expect(properties['Files Modified'].rich_text[0].text.content).toBe('src/b.ts\nsrc/c.ts');
      expect(properties.Created).toEqual({ date: { start: '2026-10-15T12:00:00.000Z' } });
      expect(properties['Session ID'].rich_text[0].text.content).toBe('mem-session-1');
    });

    it('puts the narrative and facts in the page body', () => {
      const blocks = buildNotionChildren(observation) as any[];
      expect(blocks.map(block => block.type)).toEqual([
        'paragraph', 'paragraph', 'heading_3', 'bulleted_list_item', 'bulleted_list_item',
      ]);
      expect(blocks[0].paragraph.rich_text[0].text.content).toBe('First paragraph.');
      expect(blocks[4].bulleted_list_item.rich_text[0].text.content).toBe('Cap is 60s');
    });

    it('splits long text into 2000-character chunks and strips commas from select names', () => {
      const long = 'x'.repeat(4500);
      const properties = buildNotionProperties(
        record({ project: 'a,b', observation: { ...observation, subtitle: long } }),
        'Name',
      ) as Record<string, any>;
      expect(properties.Subtitle.rich_text.map((t: any) => t.text.content.length)).toEqual([2000, 2000, 500]);
      expect(properties.Project.select.name).toBe('a b');
    });

    it('falls back to a generated title when the observation has none', () => {
      const properties = buildNotionProperties(
        record({ observation: { ...observation, title: null, subtitle: null } }),
        'Title',
      ) as Record<string, any>;
      expect(properties.Title.title[0].text.content).toBe('Observation #42');
    });

    it('normalizes a bare, dashed, or URL database id', () => {
      expect(normalizeNotionId(DATABASE_ID)).toBe(DASHED_ID);
      expect(normalizeNotionId(DASHED_ID)).toBe(DASHED_ID);
      expect(normalizeNotionId(`https://www.notion.so/team/Feed-${DATABASE_ID}?v=ffffffffffffffffffffffffffffffff`)).toBe(DASHED_ID);
      expect(normalizeNotionId('not-an-id')).toBeNull();
    });
  });

  describe('upsert / dedupe', () => {
    it('creates a page when no page holds the observation id', async () => {
      const { exporter, calls } = harness(healthyNotion());
      expect(await exporter.upsert(record())).toBe('created');

      const query = calls.find(call => call.url.endsWith('/query'))!;
      expect(query.body.filter).toEqual({ property: 'Observation ID', number: { equals: 42 } });

      const create = calls.at(-1)!;
      expect(create.method).toBe('POST');
      expect(create.url).toBe('https://api.notion.com/v1/pages');
      expect(create.body.parent).toEqual({ database_id: DASHED_ID });
      expect(create.body.children.length).toBeGreaterThan(0);
      expect(create.headers.authorization).toBe('Bearer ntn_test_token');
      expect(create.headers['notion-version']).toBe(NOTION_API_VERSION);
    });

    it('updates the existing page instead of creating a duplicate', async () => {
      const { exporter, calls } = harness(healthyNotion('page-123'));
      expect(await exporter.upsert(record())).toBe('updated');
      const last = calls.at(-1)!;
      expect(last.method).toBe('PATCH');
      expect(last.url).toBe('https://api.notion.com/v1/pages/page-123');
      expect(calls.some(call => call.method === 'POST' && call.url.endsWith('/pages'))).toBe(false);
    });

    it('reads the schema once and auto-creates missing properties', async () => {
      const { exporter, calls } = harness(healthyNotion(null, { Name: { type: 'title' } }));
      await exporter.upsert(record());
      await exporter.upsert(record({ observationId: 43 }));

      expect(calls.filter(call => call.method === 'GET')).toHaveLength(1);
      const schemaPatches = calls.filter(call => call.method === 'PATCH' && call.url.includes('/databases/'));
      expect(schemaPatches).toHaveLength(1);
      expect(schemaPatches[0].body.properties['Observation ID']).toEqual({ number: {} });
      expect(schemaPatches[0].body.properties.Type).toEqual({ select: {} });
    });

    it('without auto-create, writes only the properties that exist', async () => {
      const { exporter, calls } = harness(
        healthyNotion(null, { Title: { type: 'title' }, Type: { type: 'rich_text' } }),
        { autoCreateProperties: false },
      );
      await exporter.upsert(record());

      expect(calls.some(call => call.method === 'PATCH')).toBe(false);
      // No Observation ID property means no dedupe query is possible.
      expect(calls.some(call => call.url.endsWith('/query'))).toBe(false);
      const create = calls.at(-1)!;
      // Type exists with the wrong type, so it is skipped rather than failing the write.
      expect(Object.keys(create.body.properties)).toEqual(['Title']);
    });
  });

  describe('retry / backoff', () => {
    it('honors a 429 Retry-After, then succeeds', async () => {
      let rateLimited = false;
      const ok = healthyNotion();
      const { exporter, sleeps, calls } = harness(call => {
        if (call.url.endsWith('/query') && !rateLimited) {
          rateLimited = true;
          return json({ code: 'rate_limited' }, 429, { 'retry-after': '7' });
        }
        return ok(call);
      });
      exporter.enqueue(record());
      await exporter.idle();

      expect(sleeps).toContain(7000);
      expect(calls.at(-1)!.url).toBe('https://api.notion.com/v1/pages');
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it('backs off exponentially on 5xx and network errors, then gives up and logs', async () => {
      const { exporter, sleeps, calls } = harness(
        call => {
          if (call.method === 'GET') throw new TypeError('fetch failed');
          return json({ code: 'internal_server_error' }, 502);
        },
        { maxRetries: 3, minRequestIntervalMs: 0 },
      );
      exporter.enqueue(record());
      await exporter.idle();

      expect(calls).toHaveLength(4);
      expect(sleeps).toEqual([1000, 2000, 4000]);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy.mock.calls[0][1]).toContain('observation skipped');
    });

    it('retries the whole upsert so a create that landed is found, not duplicated', async () => {
      let created = false;
      const { exporter, calls } = harness(call => {
        if (call.method === 'GET') return json({ properties: fullSchema() });
        if (call.url.endsWith('/query')) return json({ results: created ? [{ id: 'page-1' }] : [] });
        if (call.method === 'POST' && call.url.endsWith('/pages')) {
          created = true;
          return json({ code: 'service_unavailable' }, 503);
        }
        return json({ id: 'page-1' });
      });
      exporter.enqueue(record());
      await exporter.idle();

      expect(calls.filter(call => call.method === 'POST' && call.url.endsWith('/pages'))).toHaveLength(1);
      expect(calls.at(-1)!.method).toBe('PATCH');
    });

    it('does not retry a 400 and keeps exporting the next observation', async () => {
      const ok = healthyNotion();
      const { exporter, calls, sleeps } = harness(call => {
        if (call.method === 'POST' && call.url.endsWith('/pages') && call.body.properties['Observation ID'].number === 1) {
          return json({ code: 'validation_error', message: 'bad' }, 400);
        }
        return ok(call);
      }, { minRequestIntervalMs: 0 });
      exporter.enqueue(record({ observationId: 1 }));
      exporter.enqueue(record({ observationId: 2 }));
      await exporter.idle();

      expect(sleeps).toEqual([]);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      const creates = calls.filter(call => call.method === 'POST' && call.url.endsWith('/pages'));
      expect(creates.map(call => call.body.properties['Observation ID'].number)).toEqual([1, 2]);
    });

    it('stops calling Notion after a 401 until settings change', async () => {
      const { exporter, calls } = harness(() => json({ code: 'unauthorized' }, 401));
      exporter.enqueue(record({ observationId: 1 }));
      exporter.enqueue(record({ observationId: 2 }));
      await exporter.idle();
      exporter.enqueue(record({ observationId: 3 }));
      await exporter.idle();

      expect(calls).toHaveLength(1);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy.mock.calls[0][1]).toContain('disabled until settings change');
      // The token never reaches the log.
      expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('ntn_test_token');
    });
  });

  describe('throttle', () => {
    it('spaces requests at least 334ms apart (~3 req/s)', async () => {
      const { exporter, requestTimes } = harness(healthyNotion());
      for (let id = 1; id <= 4; id++) exporter.enqueue(record({ observationId: id }));
      await exporter.idle();

      expect(requestTimes.length).toBe(1 + 4 * 2); // schema + (query, create) per observation
      for (let i = 1; i < requestTimes.length; i++) {
        expect(requestTimes[i] - requestTimes[i - 1]).toBeGreaterThanOrEqual(334);
      }
    });

    it('drops the oldest entry once the queue is full', async () => {
      const { exporter, calls } = harness(healthyNotion(), { maxQueue: 1 });
      // #1 is taken off the queue at once by the drain loop; #2 and #3 then compete for one slot.
      exporter.enqueue(record({ observationId: 1 }));
      exporter.enqueue(record({ observationId: 2 }));
      exporter.enqueue(record({ observationId: 3 }));
      await exporter.idle();

      const ids = calls.filter(call => call.url.endsWith('/query')).map(call => call.body.filter.number.equals);
      expect(ids).toEqual([1, 3]);
      expect(errorSpy.mock.calls[0][1]).toContain('queue full');
    });
  });

  describe('settings', () => {
    let settingsSpy: ReturnType<typeof spyOn>;
    let fetchSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
      settingsSpy = spyOn(SettingsDefaultsManager, 'loadFromFile');
      fetchSpy = spyOn(globalThis, 'fetch');
    });

    afterEach(() => {
      settingsSpy.mockRestore();
      fetchSpy.mockRestore();
    });

    function mockSettings(overrides: Record<string, string>): void {
      settingsSpy.mockReturnValue({ ...SettingsDefaultsManager.getAllDefaults(), ...overrides });
    }

    const input = {
      observations: [observation],
      observationIds: [42],
      project: 'claude-mem',
      memorySessionId: 'mem-session-1',
      createdAtEpoch: 0,
    };

    it('is off by default', () => {
      expect(SettingsDefaultsManager.getAllDefaults().CLAUDE_MEM_NOTION_ENABLED).toBe('false');
      mockSettings({});
      expect(getNotionExporter()).toBeNull();
      notifyNotion(input);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('is a no-op when enabled but misconfigured', () => {
      mockSettings({ CLAUDE_MEM_NOTION_ENABLED: 'true', CLAUDE_MEM_NOTION_TOKEN: '', CLAUDE_MEM_NOTION_DATABASE_ID: DATABASE_ID });
      expect(getNotionExporter()).toBeNull();
      mockSettings({ CLAUDE_MEM_NOTION_ENABLED: 'true', CLAUDE_MEM_NOTION_TOKEN: 'ntn_x', CLAUDE_MEM_NOTION_DATABASE_ID: 'nope' });
      expect(getNotionExporter()).toBeNull();
      notifyNotion(input);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('returns one shared exporter per configuration and queues without awaiting Notion', async () => {
      mockSettings({ CLAUDE_MEM_NOTION_ENABLED: 'true', CLAUDE_MEM_NOTION_TOKEN: 'ntn_x', CLAUDE_MEM_NOTION_DATABASE_ID: DATABASE_ID });
      const exporter = getNotionExporter()!;
      expect(exporter.databaseId).toBe(DASHED_ID);
      expect(getNotionExporter()).toBe(exporter);

      fetchSpy.mockImplementation(async () => json({ code: 'unauthorized' }, 401));
      expect(notifyNotion(input)).toBeUndefined(); // synchronous: capture never waits on Notion
      await exporter.idle();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  });
});
