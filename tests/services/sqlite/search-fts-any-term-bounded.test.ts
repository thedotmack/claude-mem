// #4804: bound the FTS any-term fallback by prompt size. The current
// `buildFTSAnyTermQuery` joins every whitespace token of the prompt with
// OR -- a 27,700-character prompt is rendered as `token1 OR token2 OR ...`
// and FTS5 scores every observation in the index that contains any of
// those terms before the project filter can run, taking minutes. The fix
// caps the term list at the prompt-size buckets the issue documents,
// keeping recall on short prompts (96% of the top-5 kept) and bounding
// the long case to a few hundred milliseconds.
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../../src/services/sqlite/SessionSearch.js';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Review follow-ups on #4824: the measured recipe from #4804, checked rule by rule.
describe('bounded any-term query follows the measured #4804 recipe', () => {
  let store: SessionStore;
  let search: SessionSearch;

  function seed(project: string, title: string, narrative: string, key: string): void {
    const sdkId = store.createSDKSession(key, project, 'prompt');
    store.ensureMemorySessionIdRegistered(sdkId, `${key}-mem`);
    store.storeObservation(`${key}-mem`, project, {
      type: 'discovery', title, subtitle: null, facts: [], narrative, concepts: [], files_read: [], files_modified: [],
    }, 1);
  }

  // 200 rows: "common" is in every row, "frequent" in 50 (25%), "zebrafish" in one.
  function seedCorpus(): void {
    for (let i = 0; i < 200; i++) {
      seed('proj', `common note ${i}`, i % 4 === 0 ? 'frequent words here' : 'plain words here', `row-${i}`);
    }
    seed('proj', 'zebrafish fin regeneration', 'common zebrafish experiment', 'rare');
  }

  function build(query: string): string | null {
    return (search as unknown as { buildFTSAnyTermQuery: (q: string, t: string) => string | null })
      .buildFTSAnyTermQuery.call(search, query, 'observations_fts');
  }

  function terms(query: string | null): string[] {
    return (query ?? '').split(' OR ').filter(Boolean).map(term => term.replace(/^"|"$/g, '').toLowerCase());
  }

  beforeAll(() => {
    store = new SessionStore(':memory:');
    search = new SessionSearch(store.db);
    seedCorpus();
  });

  afterAll(() => {
    store.close();
  });

  it('drops words that are in >= 2% of rows from a long prompt', () => {
    const prompt = `${'common frequent '.repeat(40)}zebrafish`;
    expect(prompt.length).toBeGreaterThanOrEqual(600);
    const picked = terms(build(prompt));
    expect(picked).toContain('zebrafish');
    expect(picked).not.toContain('common');
    expect(picked).not.toContain('frequent');
  });

  it('does not let words missing from the index crowd out a rare word late in a long prompt', () => {
    const filler = Array.from({ length: 120 }, (_, i) => `absentword${i}`).join(' ');
    const picked = terms(build(`${filler} zebrafish`));
    expect(picked).toEqual(['zebrafish']);
  });

  it('drops words that are in >= 30% of rows from a short prompt', () => {
    const picked = terms(build('common zebrafish frequent note'));
    expect(picked).toContain('zebrafish');
    expect(picked).toContain('frequent');
    expect(picked).not.toContain('common');
  });

  it('deduplicates tokens case-insensitively, keeping the first spelling', () => {
    const built = build('Retry retry RETRY zebrafish');
    expect(built).not.toBeNull();
    const retries = (built ?? '').split(' OR ').filter(term => term.toLowerCase() === '"retry"');
    expect(retries).toEqual(['"Retry"']);
  });


  it('leaves the database schema untouched', () => {
    build(`${'common '.repeat(100)}zebrafish`);
    const created = store.db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%vocab%'").all();
    expect(created).toEqual([]);
  });
});

// Each cap, with more qualifying words than it allows. 300 rows: `aNN` (NN 0..69) is in NN + 1 rows, so it is
// rarer the lower NN is and always under 30% (90 rows); `bNN` (NN 0..49) is in exactly one row, under 2% (6 rows).
describe('bounded any-term query caps each prompt size (#4804)', () => {
  let store: SessionStore;
  let search: SessionSearch;

  const word = (prefix: string, n: number) => `${prefix}${String(n).padStart(2, '0')}`;
  const range = (count: number) => Array.from({ length: count }, (_, n) => n);

  function build(query: string): string[] {
    const built = (search as unknown as { buildFTSAnyTermQuery: (q: string, t: string) => string | null })
      .buildFTSAnyTermQuery.call(search, query, 'observations_fts');
    return (built ?? '').split(' OR ').filter(Boolean).map(term => term.replace(/^"|"$/g, ''));
  }

  beforeAll(() => {
    store = new SessionStore(':memory:');
    search = new SessionSearch(store.db);
    for (let row = 0; row < 300; row++) {
      const aWords = range(70).filter(n => n >= row).map(n => word('a', n));
      const bWords = row < 50 ? [word('b', row)] : [];
      const sdkId = store.createSDKSession(`cap-${row}`, 'proj', 'prompt');
      store.ensureMemorySessionIdRegistered(sdkId, `cap-${row}-mem`);
      store.storeObservation(`cap-${row}-mem`, 'proj', {
        type: 'discovery', title: `row ${row}`, subtitle: null, facts: [],
        narrative: [...aWords, ...bWords].join(' ') || 'filler', concepts: [], files_read: [], files_modified: [],
      }, 1);
    }
  });

  afterAll(() => {
    store.close();
  });

  it('keeps the 40 rarest tokens of a short prompt', () => {
    const prompt = range(45).map(n => word('a', n)).reverse().join(' ');
    expect(prompt.length).toBeLessThan(200);
    expect(build(prompt).sort()).toEqual(range(40).map(n => word('a', n)));
  });

  it('keeps the 60 rarest tokens of a medium prompt', () => {
    const prompt = range(70).map(n => word('a', n)).reverse().join(' ');
    expect(prompt.length).toBeGreaterThanOrEqual(200);
    expect(prompt.length).toBeLessThan(600);
    expect(build(prompt).sort()).toEqual(range(60).map(n => word('a', n)));
  });

  it('keeps the first 40 qualifying words of a long prompt, in prompt order', () => {
    const rare = range(50).map(n => word('b', n)).reverse();
    const filler = range(40).map(n => `absentfiller${n}`).join(' ');
    const prompt = `${rare.join(' ')} ${filler}`;
    expect(prompt.length).toBeGreaterThanOrEqual(600);
    expect(build(prompt)).toEqual(rare.slice(0, 40));
  });
});

describe('bounded any-term query on a store with a handful of rows (#4804)', () => {
  it('keeps a word that is in one row, however small the store', () => {
    const store = new SessionStore(':memory:');
    try {
      const search = new SessionSearch(store.db);
      const sdkId = store.createSDKSession('one', 'proj', 'prompt');
      store.ensureMemorySessionIdRegistered(sdkId, 'one-mem');
      store.storeObservation('one-mem', 'proj', {
        type: 'discovery', title: 'zebrafish fin regeneration', subtitle: null, facts: [],
        narrative: 'notes', concepts: [], files_read: [], files_modified: [],
      }, 1);
      expect(search.searchObservations('what did we find about zebrafish', { project: 'proj' }).map(r => r.title))
        .toEqual(['zebrafish fin regeneration']);
      const long = `${'please tell me what we learned about '.repeat(20)}zebrafish`;
      expect(search.searchObservations(long, { project: 'proj' }).map(r => r.title))
        .toEqual(['zebrafish fin regeneration']);
    } finally {
      store.close();
    }
  });
});

describe('bounded any-term query on a read-only connection (#4804)', () => {
  it('answers a long question without throwing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'any-term-ro-'));
    const dbPath = join(dir, 'memory.db');
    try {
      const writer = new SessionStore(dbPath);
      new SessionSearch(writer.db);
      const sdkId = writer.createSDKSession('ro', 'proj', 'prompt');
      writer.ensureMemorySessionIdRegistered(sdkId, 'ro-mem');
      writer.storeObservation('ro-mem', 'proj', {
        type: 'discovery', title: 'zebrafish fin regeneration', subtitle: null, facts: [],
        narrative: 'notes', concepts: [], files_read: [], files_modified: [],
      }, 1);
      writer.close();

      const reader = new Database(dbPath, { readonly: true, create: false });
      try {
        const search = new SessionSearch(reader);
        const question = `${'please tell me what we learned about '.repeat(20)}zebrafish`;
        const results = search.searchObservations(question, { project: 'proj' });
        expect(results.map(r => r.title)).toEqual(['zebrafish fin regeneration']);
      } finally {
        reader.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
