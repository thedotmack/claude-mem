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
    const q = builder(prompt, 'observations_fts');
    expect(q).not.toBeNull();
    const orTermCount = q!.split(' OR ').length;
    expect(orTermCount).toBeLessThanOrEqual(40);

    // The 1,000-token search must also complete promptly. Without the cap
    // it would scan the whole index, taking minutes on the issue's 2.5 GB
    // store; the fix keeps it bounded. A generous 5 s budget catches a
    // regression even on slow CI without flaking on a loaded box.
    const start = Date.now();
    const results = search.searchObservations(prompt, { project: 'big' });
    expect(Date.now() - start).toBeLessThan(5_000);
    expect(Array.isArray(results)).toBe(true);
  });

  // Regression: the small-prompt path must keep working. Pick terms that
  // the doc-frequency filter does NOT drop -- i.e. words that are not in
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
