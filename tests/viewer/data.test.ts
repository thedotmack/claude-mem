import { describe, it, expect } from 'bun:test';
import { mergeAndDeduplicateByProject, buildFeedItems } from '../../src/ui/viewer/utils/data';
import { Observation, Summary, UserPrompt } from '../../src/ui/viewer/types';

function makeObservation(overrides: Partial<Observation> = {}): Observation {
  return {
    id: 1,
    memory_session_id: 'mem-1',
    content_session_id: 'sess-1',
    project: 'claude-mem',
    platform_source: 'claude',
    type: 'discovery',
    title: 'Title',
    subtitle: null,
    narrative: null,
    text: null,
    facts: null,
    concepts: null,
    files_read: null,
    files_modified: null,
    prompt_number: null,
    created_at: '2026-01-01T00:00:00.000Z',
    created_at_epoch: 1000,
    ...overrides,
  };
}

function makeSummary(overrides: Partial<Summary> = {}): Summary {
  return {
    id: 1,
    session_id: 'sess-1',
    project: 'claude-mem',
    platform_source: 'claude',
    created_at_epoch: 1000,
    ...overrides,
  };
}

function makePrompt(overrides: Partial<UserPrompt> = {}): UserPrompt {
  return {
    id: 1,
    content_session_id: 'sess-1',
    project: 'claude-mem',
    platform_source: 'claude',
    prompt_number: 1,
    prompt_text: 'hello',
    created_at_epoch: 1000,
    ...overrides,
  };
}

describe('buildFeedItems', () => {
  it('tags each item with its itemType', () => {
    const items = buildFeedItems(
      [makeObservation({ id: 1 })],
      [makeSummary({ id: 2 })],
      [makePrompt({ id: 3 })]
    );
    const byType = Object.fromEntries(items.map(i => [i.itemType, i]));
    expect(byType.observation.id).toBe(1);
    expect(byType.summary.id).toBe(2);
    expect(byType.prompt.id).toBe(3);
  });

  it('sorts combined items by created_at_epoch descending', () => {
    const items = buildFeedItems(
      [makeObservation({ id: 1, created_at_epoch: 100 })],
      [makeSummary({ id: 2, created_at_epoch: 300 })],
      [makePrompt({ id: 3, created_at_epoch: 200 })]
    );
    expect(items.map(i => i.id)).toEqual([2, 3, 1]);
  });

  it('returns an empty array when given no items', () => {
    expect(buildFeedItems([], [], [])).toEqual([]);
  });
});

describe('mergeAndDeduplicateByProject (existing, regression guard)', () => {
  it('deduplicates by id, preferring live items first', () => {
    const live = [makeObservation({ id: 1, title: 'live' })];
    const paginated = [makeObservation({ id: 1, title: 'paginated' }), makeObservation({ id: 2 })];
    const result = mergeAndDeduplicateByProject(live, paginated);
    expect(result).toHaveLength(2);
    expect(result[0].title).toBe('live');
  });
});
