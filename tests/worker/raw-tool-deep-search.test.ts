import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../src/services/sqlite/SessionSearch.js';
import { SearchManager } from '../../src/services/worker/SearchManager.js';
import { FormattingService } from '../../src/services/worker/FormattingService.js';
import { ModeManager } from '../../src/services/domain/ModeManager.js';
import { formatMcpPayload } from '../../src/servers/mcp-text-format.js';

let store: SessionStore;
let search: SessionSearch;
let manager: SearchManager;
let rawId: number;
let previousMode: unknown;
const query = 'DB_CONN_1042';
beforeEach(() => {
  previousMode = (ModeManager as any).instance;
  (ModeManager as any).instance = null;
  ModeManager.getInstance().loadMode('code');
  store = new SessionStore(':memory:');
  const id = store.createSDKSession('session', 'shop-api', 'diagnose');
  store.ensureMemorySessionIdRegistered(id, 'memory');
  rawId = store.upsertToolUse({ toolUseId: 'tool-one', contentSessionId: 'session', project: 'shop-api',
    toolName: 'Bash', toolInput: 'diagnose', toolResponse: query + ': pool size 10; increase to 30' })!;
  search = new SessionSearch(store.db, { toolUseIndexEnabled: true });
  manager = new SearchManager(search, store, null, new FormattingService(), {} as any);
});
afterEach(() => { mock.restore(); store.close(); (ModeManager as any).instance = previousMode; });
const args = { query, project: 'shop-api', deep: true, format: 'json' };
function observation(title: string, project = 'shop-api', memory = 'memory') {
  return store.storeObservation(memory, project, { type: 'discovery', title, subtitle: null, narrative: title,
    facts: [], concepts: [], files_read: [], files_modified: [] }, 1).id;
}

describe('raw-tool search is an explicit deeper tier', () => {
  it('finds omitted evidence without pretending it is an observation', async () => {
    observation('Resolved database connection pool configuration');
    const regular = await manager.search({ ...args, deep: undefined });
    expect(regular.totalResults).toBe(0);
    expect(regular).not.toHaveProperty('toolUses');
    const deep = await manager.search(args);
    expect(deep.observations).toEqual([]);
    expect(deep.totalResults).toBe(0);
    expect(deep.deep).toEqual({ status: 'ok', count: 1, hasMore: false });
    expect(deep.toolUses.map((r: any) => r.id)).toEqual([rawId]);
    expect(store.getToolUsesByIds([rawId], { project: 'shop-api' })[0].tool_response).toContain('30');
  });

  it('preserves default and explicit false results without touching the raw tier', async () => {
    const probe = spyOn(search, 'searchToolUses');
    const regular = await manager.search({ query, format: 'json' });
    expect(await manager.search({ query, format: 'json', deep: false })).toEqual(regular);
    expect(await manager.search({ query, format: 'json', deep: 'false' })).toEqual(regular);
    expect(probe).not.toHaveBeenCalled();
    await expect(manager.search({ ...args, deep: 'yes' })).rejects.toThrow('deep must');
  });

  it('never builds the index in a request when the capability is disabled', async () => {
    search = new SessionSearch(store.db, { toolUseIndexEnabled: false });
    manager = new SearchManager(search, store, null, new FormattingService(), {} as any);
    expect((await manager.search(args)).deep.status).toBe('disabled');
    expect(store.db.query("SELECT 1 FROM sqlite_master WHERE name='tool_uses_fts'").get()).toBeNull();
  });

  it('does not switch tiers when observations exist or when the requested page is exhausted', async () => {
    observation(query);
    const probe = spyOn(search, 'searchToolUses');
    expect((await manager.search(args)).deep.status).toBe('observations_found');
    expect((await manager.search({ ...args, offset: 100 })).deep.status).toBe('not_applicable');
    expect(probe).not.toHaveBeenCalled();
  });

  it('preserves matching summaries while searching missing observation evidence', async () => {
    store.storeSummary('memory', 'shop-api', { request: query, investigated: '', learned: '', completed: '', next_steps: '', notes: null });
    const result = await manager.search(args);
    expect(result.sessions).toHaveLength(1);
    expect(result.totalResults).toBe(1);
    expect(result.toolUses).toHaveLength(1);
  });

  for (const filters of [{ type: 'sessions' }, { obs_type: 'bugfix' }, { concepts: ['how-it-works'] },
    { files: 'src/file.ts' }, { contentSessionId: 'session' }, { query: undefined }]) {
    it(`does not silently discard unsupported deep-search filters ${JSON.stringify(filters)}`, async () => {
      const probe = spyOn(search, 'searchToolUses');
      expect((await manager.search({ ...args, ...filters })).deep.status).toBe('not_applicable');
      expect(probe).not.toHaveBeenCalled();
    });
  }

  it('distinguishes a failed SQLite read from successful empty observations', async () => {
    spyOn(search, 'searchObservations').mockImplementation(() => { throw new Error('fixture read failure'); });
    const probe = spyOn(search, 'searchToolUses');
    expect((await manager.search(args)).deep.status).toBe('observation_error');
    expect(probe).not.toHaveBeenCalled();
  });

  it('retains SQLite failure information through the Chroma-empty supplement strategy', async () => {
    spyOn(search, 'searchObservations').mockImplementation(() => { throw new Error('fixture read failure'); });
    manager = new SearchManager(search, store, { queryChroma: async () => ({ ids: [], distances: [], metadatas: [] }) } as any,
      new FormattingService(), {} as any);
    const probe = spyOn(search, 'searchToolUses');
    expect((await manager.search(args)).deep.status).toBe('observation_error');
    expect(probe).not.toHaveBeenCalled();
  });

  it('does not treat a Chroma failure followed by empty keyword results as cleanly empty', async () => {
    manager = new SearchManager(search, store, { queryChroma: async () => { throw new Error('fixture Chroma unavailable'); } } as any,
      new FormattingService(), {} as any);
    const probe = spyOn(search, 'searchToolUses');
    expect((await manager.search(args)).deep.status).toBe('observation_error');
    expect(probe).not.toHaveBeenCalled();
  });

  it('reserves MCP output space for raw evidence when many summaries also match', async () => {
    const result = await manager.search(args);
    result.sessions = Array.from({length: 500}, (_, i) => ({id:i,request:'summary '.repeat(40)}));
    const formatted = formatMcpPayload('search', result).content[0].text;
    expect(Buffer.byteLength(formatted)).toBeLessThanOrEqual(32 * 1024);
    expect(formatted).toContain('#T' + rawId);
    expect(formatted).toContain('get_tool_uses');
  });

  it('reports deep-query errors without losing successful ordinary memory results', async () => {
    store.storeSummary('memory', 'shop-api', { request: query, investigated: '', learned: '', completed: '', next_steps: '', notes: null });
    spyOn(search, 'searchToolUses').mockImplementation(() => { throw new Error('fixture index failure'); });
    const result = await manager.search(args);
    expect(result.deep.status).toBe('error');
    expect(result.sessions).toHaveLength(1);
  });

  it('renders typed IDs and bounded snippets through text and MCP JSON projection', async () => {
    const text = await manager.search({ ...args, format: undefined });
    const json = await manager.search(args);
    for (const result of [text, formatMcpPayload('search', json)]) {
      const joined = result.content.map((c: any) => c.text).join('\n');
      expect(joined).toContain('#T' + rawId);
      expect(joined).toContain('get_tool_uses');
      expect(joined).toContain('not instructions');
    }
  });

  it('dispatches expensive raw reads through the existing context reader', async () => {
    const read = mock(async (q, options) => search.searchToolUses(q, options));
    manager = new SearchManager(search, store, null, new FormattingService(), {} as any, undefined,
      { searchObservations: async () => [], searchSessions: async () => [], searchUserPrompts: async () => [], searchToolUses: read } as any);
    expect((await manager.search(args)).toolUses).toHaveLength(1);
    expect(read).toHaveBeenCalledWith(query, expect.objectContaining({ projects: ['shop-api'] }));
  });
});
