import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../../src/services/sqlite/SessionSearch.js';
import { SearchManager } from '../../../src/services/worker/SearchManager.js';
import { FormattingService } from '../../../src/services/worker/FormattingService.js';
import { TimelineService } from '../../../src/services/worker/TimelineService.js';

const terms = [
  { label: 'ASCII', word: 'zebrafish' },
  { label: 'Latin accent', word: 'café' },
  { label: 'Greek accent', word: 'άλφα' },
  { label: 'Greek final sigma', word: 'κοσμος' },
  { label: 'Cyrillic breve', word: 'мой' },
  { label: 'Vietnamese compound accent', word: 'một' },
] as const;

describe('native unicode61 tokenizer controls', () => {
  for (const mode of [0, 1, 2]) {
    it(`records actual terms with remove_diacritics=${mode}`, () => {
      const db = new Database(':memory:');
      try {
        db.run(`CREATE VIRTUAL TABLE tokens USING fts5(text, tokenize='unicode61 remove_diacritics ${mode}')`);
        db.run("CREATE VIRTUAL TABLE vocabulary USING fts5vocab(tokens, 'row')");
        for (const { word } of terms) {
          db.run('DELETE FROM tokens');
          db.run('INSERT INTO tokens(text) VALUES (?)', [word]);
          const indexed = db.query('SELECT term, doc FROM vocabulary ORDER BY term').all();
          const matched = db.query('SELECT text FROM tokens WHERE tokens MATCH ?').all(`"${word}"`);
          expect(matched).toEqual([{ text: word }]);
          const expected = word === 'κοσμος' ? 'κοσμοσ'
            : word === 'café' && mode !== 0 ? 'cafe'
            : word === 'một' && mode === 2 ? 'mot' : word;
          expect(indexed).toEqual([{ term: expected, doc: 1 }]);
        }
      } finally { db.close(); }
    });
  }
});

describe('long memory questions use the indexed Unicode vocabulary', () => {
  let store: SessionStore;
  let search: SessionSearch;
  let manager: SearchManager;
  let sequence = 0;

  function seed(title: string, project: string): void {
    const key = `unicode-frequency-${sequence++}`;
    const session = store.createSDKSession(key, project, 'fixture request');
    const memory = store.ensureMemorySessionIdRegistered(session, key + '-memory');
    store.storeObservation(memory, project, {
      type: 'discovery', title, subtitle: null, facts: [], narrative: null,
      concepts: [], files_read: [], files_modified: [],
    }, 1);
    store.importSessionSummary({
      memory_session_id: memory, project, request: title,
      investigated: null, learned: null, completed: null, next_steps: null,
      files_read: null, files_edited: null, notes: null, prompt_number: 1, discovery_tokens: 0,
      created_at: '2026-01-01T00:00:00.000Z', created_at_epoch: Date.UTC(2026, 0, 1),
    });
  }

  beforeAll(() => {
    store = new SessionStore(':memory:');
    for (let index = 0; index < 100; index++) seed(`Unrelated neutral background ${index}`, 'vocabulary-project');
    for (const { word } of terms) {
      seed(`Saved token ${word}`, 'vocabulary-project');
      seed(`Outside token ${word}`, 'outside-project');
    }
    search = new SessionSearch(store.db);
    manager = new SearchManager(search, store, null, new FormattingService(), new TimelineService());
  });
  afterAll(() => store.close());

  for (const category of ['observations', 'sessions'] as const) {
    for (const { label, word } of terms) {
      it(`recalls the rare ${label} ${category} term through the public long-query search`, async () => {
        const expected = [`Saved token ${word}`];
        const query = `missing ${word} absent ${'unmatched '.repeat(80)}`;
        expect([...query].length).toBeGreaterThanOrEqual(600);
        const ask = async (text: string): Promise<string[]> => {
          const response = await manager.search({
            query: text, project: 'vocabulary-project', type: category, format: 'json', limit: 50,
          });
          return category === 'observations'
            ? response.observations.map((row: { title: string }) => row.title)
            : response.sessions.map((row: { request: string }) => row.request);
        };
        const keyword = await ask(word);
        const short = await ask(`missing ${word} absent`);
        const long = await ask(query);
        expect(keyword).toEqual(expected);
        expect(short).toEqual(expected);
        expect(long).toEqual(expected);
      });
    }
  }
});


describe('native long-query tokenization stays bounded and connection-local', () => {
  function save(store: SessionStore, title: string): void {
    const session = store.createSDKSession('readonly-unicode', 'project', 'fixture');
    store.ensureMemorySessionIdRegistered(session, 'readonly-unicode-memory');
    store.storeObservation('readonly-unicode-memory', 'project', {
      type: 'discovery', title, subtitle: null, facts: [], narrative: null,
      concepts: [], files_read: [], files_modified: [],
    }, 1);
  }

  function build(search: SessionSearch, query: string): string[] {
    const result = (search as unknown as {
      buildFTSAnyTermQuery(query: string, table: string): string | null;
    }).buildFTSAnyTermQuery(query, 'observations_fts');
    return (result ?? '').split(' OR ').filter(Boolean).map(term => term.slice(1, -1));
  }

  it('reads a rare Unicode word after many absent words on a read-only database', () => {
    const directory = mkdtempSync(join(tmpdir(), 'unicode-frequency-readonly-'));
    const path = join(directory, 'memory.db');
    let writer: SessionStore | undefined;
    let reader: Database | undefined;
    try {
      writer = new SessionStore(path);
      save(writer, 'άλφα');
      new SessionSearch(writer.db);
      const schema = writer.db.query('SELECT type, name, sql FROM sqlite_master ORDER BY type, name').all();
      writer.close();
      writer = undefined;

      reader = new Database(path, { readonly: true, create: false });
      const search = new SessionSearch(reader, { readOnly: true });
      const question = Array.from({ length: 100 }, (_, index) => 'missingword' + index).join(' ') + ' άλφα';
      expect(search.searchObservations(question, { project: 'project' }).map(row => row.title)).toEqual(['άλφα']);
      expect(reader.query('SELECT type, name, sql FROM sqlite_master ORDER BY type, name').all()).toEqual(schema);
      // The tokenizer must not retain words from the previous query or persist a main-schema index.
      expect(build(search, 'missing absent unknown '.repeat(40))).toEqual([]);
      expect(reader.query("SELECT name FROM sqlite_master WHERE name LIKE '_any_term%'").all()).toEqual([]);
      expect(reader.query('SELECT term FROM temp._any_term_words_vocab').all()).toEqual([]);
    } finally {
      reader?.close();
      writer?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('keeps the first 40 distinct indexed Unicode words in prompt order', () => {
    const store = new SessionStore(':memory:');
    try {
      const words = Array.from({ length: 50 }, (_, index) => 'άλφα' + String(index).padStart(2, '0')).reverse();
      save(store, words.join(' '));
      const search = new SessionSearch(store.db);
      const question = words.join(' ') + ' ' + 'missing '.repeat(50);
      expect(build(search, question)).toEqual(words.slice(0, 40));
    } finally { store.close(); }
  });

  it('deduplicates unicode61-equivalent words before applying the long-query cap', () => {
    const store = new SessionStore(':memory:');
    try {
      save(store, 'κοσμοσ zebrafish');
      const search = new SessionSearch(store.db);
      expect(build(search, 'κοσμος κοσμοσ ΚΟΣΜΟΣ zebrafish ' + 'missing '.repeat(80)))
        .toEqual(['κοσμοσ', 'zebrafish']);
    } finally { store.close(); }
  });

  it('drops genuinely common accented words without confusing their unaccented neighbors', () => {
    const store = new SessionStore(':memory:');
    try {
      save(store, 'άλφα');
      const insert = store.db.prepare(
        "INSERT INTO observations (memory_session_id, project, text, type, title, created_at, created_at_epoch) " +
        "VALUES ('readonly-unicode-memory', 'project', '', 'discovery', ?, '2026-01-01', 1767225600000)",
      );
      try {
        store.db.transaction(() => {
          for (let index = 0; index < 200; index++) insert.run('αλφα μία');
        })();
      } finally { insert.finalize(); }
      const search = new SessionSearch(store.db);
      expect(build(search, 'αλφα άλφα μία ' + 'missing '.repeat(80))).toEqual(['άλφα']);
    } finally { store.close(); }
  });
});
