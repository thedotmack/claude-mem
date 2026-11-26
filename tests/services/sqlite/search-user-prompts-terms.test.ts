import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../../src/services/sqlite/SessionSearch.js';

// #4130 and #4148 made a multi-term observation or summary query match rows
// that hold every term. Prompt search must match the same way, or one query
// finds the observation but not the prompt that produced it.
describe('searchUserPrompts with several terms', () => {
  let store: SessionStore;
  let search: SessionSearch;

  beforeEach(() => {
    store = new SessionStore(':memory:');
    search = new SessionSearch(store.db);
    const sessionDbId = store.createSDKSession('content-1', 'proj', 'fix the bug in the auth module');
    store.ensureMemorySessionIdRegistered(sessionDbId, 'memory-1');
    const prompts = ['fix the bug in the auth module', 'payload优先使用LLM', 'rename 100%_done flag'];
    prompts.forEach((text, index) => {
      store.saveUserPrompt('content-1', index + 1, text);
      store.storeObservation('memory-1', 'proj', {
        type: 'bugfix', title: text, subtitle: null, facts: [],
        narrative: null, concepts: [], files_read: [], files_modified: [],
      }, index + 1);
    });
  });

  afterEach(() => {
    store.close();
  });

  const promptTexts = (query: string) =>
    search.searchUserPrompts(query, { project: 'proj' }).map(row => row.prompt_text);

  it('matches a prompt that holds every word, in any order, as observations do', () => {
    expect(search.searchObservations('auth bug', { project: 'proj' }).map(row => row.title))
      .toEqual(['fix the bug in the auth module']);
    expect(promptTexts('auth bug')).toEqual(['fix the bug in the auth module']);
  });

  it('matches a mixed-script prompt term by term', () => {
    expect(promptTexts('payload 优先')).toEqual(['payload优先使用LLM']);
  });

  it('still needs every term and still matches % and _ literally', () => {
    expect(promptTexts('auth missing')).toEqual([]);
    expect(promptTexts('100%_done')).toEqual(['rename 100%_done flag']);
    expect(promptTexts('100%xdone')).toEqual([]);
  });
});
