import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../../src/services/sqlite/SessionSearch.js';

describe('extended CJK substring recall', () => {
  let store: SessionStore;
  let search: SessionSearch;
  beforeEach(() => {
    store = new SessionStore(':memory:');
    search = new SessionSearch(store.db);
  });
  afterEach(() => store.close());

  function seed(key: string, text: string, project = 'extended-cjk') {
    const session = store.createSDKSession(key, project, 'prompt');
    store.ensureMemorySessionIdRegistered(session, key + '-memory');
    store.storeObservation(key + '-memory', project, {
      type: 'discovery', title: text, subtitle: null, narrative: null,
      facts: [], concepts: [], files_read: [], files_modified: [],
    }, 1);
    store.importSessionSummary({
      memory_session_id: key + '-memory', project, request: text,
      investigated: null, learned: null, completed: null, next_steps: null,
      files_read: null, files_edited: null, notes: null, prompt_number: 1,
      discovery_tokens: 0, created_at: new Date(1000).toISOString(), created_at_epoch: 1000,
    });
  }

  for (const [name, query, longer] of [
    ['supplementary Han', '𠮷', '𠮷野家'],
    ['halfwidth Katakana', 'ﾒﾓﾘ', 'ﾒﾓﾘ設定'],
    ['Katakana phonetic extensions', 'ㇰ', 'アイヌㇰ語'],
  ]) {
    for (const kind of ['observations', 'summaries'] as const) {
      it(`keeps substring hits alongside whole-token hits for ${name} ${kind}`, () => {
        seed('exact', query);
        seed('longer', longer);
        seed('other-project', longer, 'other');
        const options = { project: 'extended-cjk', orderBy: 'date_asc' as const };
        const find = (offset = 0, limit = 50) => kind === 'observations'
          ? search.searchObservations(query, { ...options, offset, limit }).map(row => row.title)
          : search.searchSessions(query, { ...options, offset, limit }).map(row => row.request);
        expect(find()).toEqual([query, longer]);
        expect(find(1, 1)).toEqual([longer]);
        expect(find(2, 1)).toEqual([]);
      });
    }
  }

  it('keeps mixed supplementary and BMP Han together as one substring term', () => {
    seed('together', '𠮷野家の記録');
    seed('apart', '𠮷 家 野');
    expect(search.searchObservations('𠮷野', { project: 'extended-cjk' }).map(row => row.title))
      .toEqual(['𠮷野家の記録']);
    expect(search.searchSessions('𠮷野', { project: 'extended-cjk' }).map(row => row.request))
      .toEqual(['𠮷野家の記録']);
  });

  it('splits Latin text from supplementary Han without splitting surrogate pairs', () => {
    seed('mixed', 'cache changed for 𠮷野');
    expect(search.searchObservations('cache𠮷', { project: 'extended-cjk' }).map(row => row.title))
      .toEqual(['cache changed for 𠮷野']);
    expect(search.searchSessions('cache𠮷', { project: 'extended-cjk' }).map(row => row.request))
      .toEqual(['cache changed for 𠮷野']);
  });
});
