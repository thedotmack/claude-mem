import { describe, expect, it } from 'bun:test';
import {
  FEED_ENDINGS, FEED_ENDING_WORDS, feedEnding, foldPromptRepeats, kindsByCount, matchesSearch, memoriesBefore, memoryCount,
} from '../../src/ui/viewer/utils/feed-display';
import { SESSION_LIST_ENDING_WORDS } from '../../src/ui/viewer/components/SessionList';
import { formatDayLabel, formatShortTime, localDayKey } from '../../src/ui/viewer/utils/formatters';
import type { FeedItem } from '../../src/ui/viewer/types';

const at = (hours: number) => new Date(2026, 10, 15, hours, 7).getTime();
const prompt = (id: number, text: string, epoch = at(18) - id * 1000): FeedItem => ({
  itemType: 'prompt', id, project: 'p', platform_source: 'claude', content_session_id: `s${id}`, prompt_number: 1, prompt_text: text, created_at_epoch: epoch,
});
const observation = (id: number, title = `Observation ${id}`): FeedItem => ({
  itemType: 'observation', id, project: 'p', platform_source: 'claude', type: 'discovery', title, subtitle: 'the subtitle', narrative: 'the narrative',
  text: null, facts: '["a fact"]', concepts: '[]', files_read: '[]', files_modified: '[]', prompt_number: 1, memory_session_id: 'm',
  content_session_id: 's', created_at: '', created_at_epoch: at(18) - id * 1000,
});

describe('prompt repeats', () => {
  it('folds the same prompt typed in a row into the newest one, even with other rows between them', () => {
    const items = [prompt(1, 'continue'), observation(2), prompt(3, '  Continue '), observation(4), prompt(5, 'continue'), prompt(6, 'other words')];
    const { rows, repeats } = foldPromptRepeats(items);
    expect(rows.map(row => `${row.itemType}-${row.id}`)).toEqual(['prompt-1', 'observation-2', 'observation-4', 'prompt-6']);
    expect(repeats.get('prompt-1')?.map(repeat => repeat.id)).toEqual([3, 5]);
  });

  it('does not fold prompts that another prompt separates', () => {
    const { rows, repeats } = foldPromptRepeats([prompt(1, 'continue'), prompt(2, 'something else'), prompt(3, 'continue')]);
    expect(rows).toHaveLength(3);
    expect(repeats.size).toBe(0);
  });

  // G2 (PR #6229 review): folding runs over the whole loaded timeline first, then the search, so a search never
  // makes prompts look typed in a row that another prompt separated.
  it('folds over the whole timeline before a search filters it', () => {
    const items = [prompt(1, 'continue'), prompt(2, 'run tests'), prompt(3, 'continue')];
    const searched = foldPromptRepeats(items, item => matchesSearch(item, 'continue'));
    expect(searched.rows.map(row => row.id)).toEqual([1, 3]);
    expect(searched.repeats.size).toBe(0);
    expect(memoryCount(searched.rows, searched.repeats)).toBe(2);
    // A folded row stays while it or one of its repeats matches, with every time it was typed.
    const folded = foldPromptRepeats([prompt(4, 'continue'), { ...prompt(5, 'continue'), project: 'other-project' }],
      item => matchesSearch(item, 'other-project'));
    expect(folded.rows.map(row => row.id)).toEqual([4]);
    expect(folded.repeats.get('prompt-4')?.map(repeat => repeat.id)).toEqual([5]);
    expect(memoryCount(folded.rows, folded.repeats)).toBe(2);
  });
});

describe('feed ending', () => {
  it('names one state for the end of the list', () => {
    expect(feedEnding({ rowCount: 0, isLoading: true, hasMore: true })).toBe('first-load');
    expect(feedEnding({ rowCount: 3, isLoading: true, hasMore: true })).toBe('loading');
    // A search that hides every loaded row is loading more, not loading for the first time.
    expect(feedEnding({ rowCount: 0, loadedCount: 40, isLoading: true, hasMore: true, filtered: true })).toBe('loading');
    expect(feedEnding({ rowCount: 3, isLoading: false, hasMore: true, loadError: 'Loading observations timed out. Try again.' })).toBe('failed');
    expect(feedEnding({ rowCount: 0, isLoading: false, hasMore: false })).toBe('empty');
    expect(feedEnding({ rowCount: 3, isLoading: false, hasMore: true })).toBeNull();
    expect(feedEnding({ rowCount: 3, isLoading: false, hasMore: false })).toBe('end');
    // Older rows wait for the reader's "Load older memories" while a filter or search is on.
    expect(feedEnding({ rowCount: 3, isLoading: false, hasMore: true, autoLoad: false })).toBe('more');
    expect(feedEnding({ rowCount: 0, isLoading: false, hasMore: true, autoLoad: false })).toBe('more');
    // An empty list with more to load lets the end load it by itself.
    expect(feedEnding({ rowCount: 0, isLoading: false, hasMore: true })).toBeNull();
    // A filter or search that hides every loaded row, with nothing left to load, is its own state (L8).
    expect(feedEnding({ rowCount: 0, loadedCount: 40, isLoading: false, hasMore: false, filtered: true })).toBe('no-match');
    expect(feedEnding({ rowCount: 0, loadedCount: 0, isLoading: false, hasMore: false, filtered: true })).toBe('empty');
  });

  it('has words for every ending it defines, on the timeline and on the Sessions list', () => {
    const english = (words: string) => words;
    for (const ending of FEED_ENDINGS) {
      expect(FEED_ENDING_WORDS[ending](english).trim()).not.toBe('');
      expect(SESSION_LIST_ENDING_WORDS[ending](english).trim()).not.toBe('');
    }
    expect(Object.keys(FEED_ENDING_WORDS).sort()).toEqual([...FEED_ENDINGS].sort());
    expect(Object.keys(SESSION_LIST_ENDING_WORDS).sort()).toEqual([...FEED_ENDINGS].sort());
    // The two states the Sessions list once drew outside its definition (L8) are worded in its Record.
    expect(SESSION_LIST_ENDING_WORDS['first-load'](english)).toBe('Loading sessions…');
    expect(SESSION_LIST_ENDING_WORDS['no-match'](english)).toBe('No session matches');
  });
});

describe('one counting rule', () => {
  it('counts memories, so a folded repeat counts each time it was typed', () => {
    const items = [prompt(1, 'continue'), observation(2), prompt(3, 'continue'), prompt(4, 'continue'), observation(5)];
    const { rows, repeats } = foldPromptRepeats(items);
    expect(rows.map(row => row.id)).toEqual([1, 2, 5]);
    expect(memoriesBefore(rows, repeats)).toEqual([0, 3, 4]);
  });
});

describe('timeline search and kinds', () => {
  it('matches every word anywhere in the row, ignoring case', () => {
    expect(matchesSearch(observation(1, 'Pinned Bar works'), 'bar PINNED')).toBe(true);
    expect(matchesSearch(observation(1), 'narrative fact')).toBe(true);
    expect(matchesSearch(observation(1), 'missing')).toBe(false);
    expect(matchesSearch(prompt(1, 'use the plan'), '')).toBe(true);
  });

  // G3 (PR #6229 review): what the card shows in its Facts view and footer is found too.
  it('finds an observation by its files read and modified, its concepts and its #id', () => {
    const card = { ...observation(4242), concepts: '["concept-zeta"]', files_read: '["src/read-only-file.ts"]', files_modified: '["src/modified-only-file.ts"]' };
    for (const query of ['read-only-file', 'modified-only-file', 'concept-zeta', '4242', '#4242']) {
      expect({ query, found: matchesSearch(card, query) }).toEqual({ query, found: true });
    }
    expect(matchesSearch(card, 'a fact')).toBe(true);
    expect(matchesSearch(card, 'not-on-this-card')).toBe(false);
  });

  // G3, the row ID: a summary's footer shows "Session #<id>" and a prompt's time details show "#<id>", so each is found by it.
  it('finds a summary and a prompt by the #id their cards show', () => {
    const summary: FeedItem = {
      itemType: 'summary', id: 5151, session_id: 's', project: 'p', platform_source: 'claude', request: 'the request',
      next_steps: 'the next steps', created_at_epoch: at(18),
    };
    for (const row of [summary, prompt(6161, 'use the plan')]) {
      for (const query of [String(row.id), `#${row.id}`]) {
        expect({ row: row.itemType, query, found: matchesSearch(row, query) }).toEqual({ row: row.itemType, query, found: true });
      }
      expect(matchesSearch(row, '#7272')).toBe(false);
    }
  });

  it('orders kinds by how many rows they have, keeping chosen kinds with no rows', () => {
    expect(kindsByCount({ prompt: 1, discovery: 38, change: 9, decision: 2 })).toEqual(['discovery', 'change', 'decision', 'prompt']);
    expect(kindsByCount({ discovery: 2 }, ['bugfix'])).toEqual(['discovery', 'bugfix']);
  });
});

describe('short local times and day labels', () => {
  it('reads "6:07 pm" in English', () => {
    expect(formatShortTime(at(18)).replace(/\s/g, ' ')).toBe('6:07 pm');
    expect(formatShortTime(at(9)).replace(/\s/g, ' ')).toBe('9:07 am');
  });

  it('labels today, yesterday, the last week by weekday, and older days by date', () => {
    const now = at(20);
    expect(formatDayLabel(at(8), now)).toBe('Today · Nov 15');
    expect(formatDayLabel(new Date(2026, 10, 14, 23, 0).getTime(), now)).toBe('Yesterday · Nov 14');
    expect(formatDayLabel(new Date(2026, 10, 12, 10, 0).getTime(), now)).toBe('Thursday · Nov 12');
    expect(formatDayLabel(new Date(2026, 10, 1, 10, 0).getTime(), now)).toBe('Nov 1');
    expect(formatDayLabel(new Date(2025, 10, 1, 10, 0).getTime(), now)).toBe('Nov 1, 2025');
    expect(localDayKey(at(1))).toBe(localDayKey(at(23)));
  });
});
