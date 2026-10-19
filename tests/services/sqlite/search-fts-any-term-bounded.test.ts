// #4804: bound the FTS any-term fallback by prompt size. The current
// `buildFTSAnyTermQuery` joins every whitespace token of the prompt with
// OR -- a 27,700-character prompt is rendered as `token1 OR token2 OR ...`
// and FTS5 scores every observation in the index that contains any of
// those terms before the project filter can run, taking minutes. The fix
// caps the term list at the prompt-size buckets the issue documents,
// keeping recall on short prompts (96% of the top-5 kept) and bounding
// the long case to a few hundred milliseconds.
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../../src/services/sqlite/SessionSearch.js';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('FTS any-term fallback is bounded by prompt size (#4804)', () => {
  let store: SessionStore;
  let search: SessionSearch;

  function seedManyObservationsWithCommonWords(project: string, count: number): void {
    // Many observations whose titles and narratives share common English
    // words ("with", "not", "test", "value", "state") so a long any-term
    // query against this table would otherwise score a huge index.
    const commonWords = ['with', 'not', 'test', 'value', 'state'];
    for (let i = 0; i < count; i++) {
      const sdkId = store.createSDKSession(`sess-${i}`, project, 'prompt');
      store.ensureMemorySessionIdRegistered(sdkId, `sess-${i}-mem`);
      const word = commonWords[i % commonWords.length];
      store.storeObservation(`sess-${i}-mem`, project, {
        type: 'discovery',
        title: `observation ${i} with common ${word}`,
        subtitle: null,
        facts: [],
        narrative: `observation ${i} contains the word ${word} and not much else`,
        concepts: [],
        files_read: [],
        files_modified: [],
      }, 1);
    }
  }

  beforeEach(() => {
    store = new SessionStore(':memory:');
    search = new SessionSearch(store.db);
  });

  afterEach(() => {
    store.close();
  });

  // #4804: cap the OR term list to the issue's recipe. A 1,000-token
  // prompt with all distinct tokens must not produce a 1,000-term OR; the
  // cap (40 for prompt >= 600 chars) plus the >= 3-char token filter and
  // the document-frequency filter for the long-prompt bucket keep the OR
  // bounded. Without the fix, this query would scan the whole index and
  // take minutes on a 2.5 GB DB.
  it('caps the number of OR terms on a 1,000-token prompt (long bucket 3)', () => {
    // 200 rows of common words make a long doc-freq vocabulary. None of
    // the 1,000 distinct "tokN" tokens appears in any row, so each one
    // gets the "rarer than the cap" treatment and the function takes
    // 40 of them, drops the rest.
    seedManyObservationsWithCommonWords('big', 200);
    const tokens = Array.from({ length: 1_000 }, (_, i) => `tok${i}`);
    const prompt = tokens.join(' ');
    expect(prompt.length).toBeGreaterThan(1_000);

    // Probe the OR-count directly through the private function the public
    // searchObservations call dispatches to. A 1,000-term OR over the
    // whole index is the regression the issue is fixing.
    const builder = (search as unknown as {
      buildFTSAnyTermQuery: (q: string, t: string) => string | null;
    }).buildFTSAnyTermQuery.bind(search);
    // No "tokN" is in any row, so none can match: the long-prompt rule keeps only indexed words and the query
    // is not widened at all. Either way the OR stays within the cap.
    const q = builder(prompt, 'observations_fts');
    expect(q).toBeNull();

    // The 1,000-token search must also complete promptly. Without the cap
    // it would scan the whole index, taking minutes on the issue's 2.5 GB
    // store; the fix keeps it bounded. A generous 5 s budget catches a
    // regression even on slow CI without flaking on a loaded box.
    const start = Date.now();
    const results = search.searchObservations(prompt, { project: 'big' });
    expect(Date.now() - start).toBeLessThan(5_000);
    expect(Array.isArray(results)).toBe(true);
  });

  // Regression: the small-prompt path must keep working. Seed the same
  // shape as the existing search-fts-any-term test: a row that actually
  // matches the search prompt, plus 4 rows of common words to make sure
  // "payment" / "retry" / "limit" sit in only 1/5 of the store (20%),
  // well below the 30% threshold for the small-prompt bucket. The fix
  // must keep those three rare terms; dropping them would yield 0 rows.
  it('keeps a small prompt exactly as today (regression: short case unchanged)', () => {
    seedManyObservationsWithCommonWords('proj', 4);
    const sdkId = store.createSDKSession('sess-target', 'proj', 'prompt');
    store.ensureMemorySessionIdRegistered(sdkId, 'sess-target-mem');
    store.storeObservation('sess-target-mem', 'proj', {
      type: 'discovery',
      title: 'Payment retry limit raised',
      subtitle: null,
      facts: [],
      narrative: 'The charge retry limit went from three to five after the outage',
      concepts: [],
      files_read: [],
      files_modified: [],
    }, 1);
    const prompt = 'when did we change the payment retry limit';
    const results = search.searchObservations(prompt, { project: 'proj' });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].title).toBe('Payment retry limit raised');
  });
});

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

  beforeEach(() => {
    store = new SessionStore(':memory:');
    search = new SessionSearch(store.db);
    seedCorpus();
  });

  afterEach(() => {
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

  it('widens over session summaries with the same bound', () => {
    const sdkId = store.createSDKSession('sum-rare-raw', 'proj', 'prompt');
    store.ensureMemorySessionIdRegistered(sdkId, 'sum-rare');
    store.importSessionSummary({
      memory_session_id: 'sum-rare', project: 'proj', request: 'Retune the compensation loop after the oscillator drift',
      investigated: null, learned: null, completed: null, next_steps: null, files_read: null, files_edited: null,
      notes: null, prompt_number: 1, discovery_tokens: 0,
      created_at: new Date(1_700_000_000_000).toISOString(), created_at_epoch: 1_700_000_000_000,
    });
    const results = search.searchSessions('why did the compensation loop need retuning today', { project: 'proj' });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].request).toBe('Retune the compensation loop after the oscillator drift');
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

  beforeEach(() => {
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

  afterEach(() => {
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
