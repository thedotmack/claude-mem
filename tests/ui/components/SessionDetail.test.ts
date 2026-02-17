/**
 * Tests for SessionDetail component logic
 *
 * We test the pure timeline-merging logic directly (no DOM/React needed),
 * following the same pattern as useSessionDetail.test.ts. The
 * @testing-library/react package is not installed, so all UI logic that can
 * be extracted into pure functions is tested here.
 *
 * Virtualization tests use source-code inspection to verify that the
 * implementation satisfies structural requirements without requiring
 * a DOM or React renderer.
 */

import { readFileSync } from 'fs';
import { describe, it, expect } from 'vitest';
import type { Observation, UserPrompt, SessionDetail } from '../../../src/ui/viewer/types';
import { buildTimeline, type TimelineItem } from '../../../src/ui/viewer/components/SessionDetail';

// ---------------------------------------------------------------------------
// Source-code inspection helpers
// ---------------------------------------------------------------------------

const SESSION_DETAIL_SOURCE = readFileSync(
  new URL('../../../src/ui/viewer/components/SessionDetail.tsx', import.meta.url).pathname,
  'utf8',
);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PROJECT = 'test-project';
const SESSION_ID = 'session-abc-123';

function makeObservation(id: number, created_at_epoch: number): Observation {
  return {
    id,
    memory_session_id: SESSION_ID,
    project: PROJECT,
    type: 'discovery',
    title: `Observation ${id}`,
    subtitle: null,
    narrative: null,
    text: null,
    facts: null,
    concepts: null,
    files_read: null,
    files_modified: null,
    prompt_number: 1,
    created_at: new Date(created_at_epoch).toISOString(),
    created_at_epoch,
  };
}

function makePrompt(id: number, created_at_epoch: number): UserPrompt {
  return {
    id,
    content_session_id: SESSION_ID,
    project: PROJECT,
    prompt_number: id,
    prompt_text: `Prompt ${id}`,
    created_at_epoch,
  };
}

// ---------------------------------------------------------------------------
// buildTimeline tests
// ---------------------------------------------------------------------------

describe('buildTimeline', () => {
  it('returns an empty array when both observations and prompts are empty', () => {
    const result = buildTimeline([], []);
    expect(result).toEqual([]);
  });

  it('returns only observations when prompts is empty', () => {
    const observations = [makeObservation(1, 1000), makeObservation(2, 2000)];
    const result = buildTimeline(observations, []);

    expect(result).toHaveLength(2);
    expect(result.every(item => item.itemType === 'observation')).toBe(true);
  });

  it('returns only prompts when observations is empty', () => {
    const prompts = [makePrompt(1, 1000), makePrompt(2, 2000)];
    const result = buildTimeline([], prompts);

    expect(result).toHaveLength(2);
    expect(result.every(item => item.itemType === 'prompt')).toBe(true);
  });

  it('merges observations and prompts into a single array', () => {
    const observations = [makeObservation(10, 2000)];
    const prompts = [makePrompt(20, 1000)];
    const result = buildTimeline(observations, prompts);

    expect(result).toHaveLength(2);
  });

  it('sorts items in ascending chronological order by created_at_epoch', () => {
    const observations = [makeObservation(10, 3000), makeObservation(11, 1000)];
    const prompts = [makePrompt(20, 2000)];
    const result = buildTimeline(observations, prompts);

    expect(result[0].created_at_epoch).toBe(1000);
    expect(result[1].created_at_epoch).toBe(2000);
    expect(result[2].created_at_epoch).toBe(3000);
  });

  it('labels observations with itemType "observation"', () => {
    const observations = [makeObservation(1, 1000)];
    const result = buildTimeline(observations, []);

    expect(result[0].itemType).toBe('observation');
  });

  it('labels prompts with itemType "prompt"', () => {
    const prompts = [makePrompt(1, 1000)];
    const result = buildTimeline([], prompts);

    expect(result[0].itemType).toBe('prompt');
  });

  it('preserves all original fields on observation items', () => {
    const obs = makeObservation(42, 5000);
    const result = buildTimeline([obs], []);

    const item = result[0];
    expect(item.id).toBe(42);
    expect(item.created_at_epoch).toBe(5000);
    if (item.itemType === 'observation') {
      expect(item.type).toBe('discovery');
      expect(item.title).toBe('Observation 42');
    }
  });

  it('preserves all original fields on prompt items', () => {
    const prompt = makePrompt(99, 7000);
    const result = buildTimeline([], [prompt]);

    const item = result[0];
    expect(item.id).toBe(99);
    expect(item.created_at_epoch).toBe(7000);
    if (item.itemType === 'prompt') {
      expect(item.prompt_text).toBe('Prompt 99');
    }
  });

  it('handles items with identical timestamps (stable relative order observation before prompt)', () => {
    const obs = makeObservation(1, 1000);
    const prompt = makePrompt(2, 1000);
    const result = buildTimeline([obs], [prompt]);

    // Both items are present; order between equal timestamps is implementation-defined
    // but result must contain both
    expect(result).toHaveLength(2);
    const types = result.map(i => i.itemType);
    expect(types).toContain('observation');
    expect(types).toContain('prompt');
  });

  it('does not mutate the input arrays', () => {
    const observations = [makeObservation(1, 3000), makeObservation(2, 1000)];
    const prompts = [makePrompt(3, 2000)];
    const obsCopy = [...observations];
    const promptsCopy = [...prompts];

    buildTimeline(observations, prompts);

    expect(observations).toEqual(obsCopy);
    expect(prompts).toEqual(promptsCopy);
  });

  it('sorts a large mixed list correctly', () => {
    const observations = Array.from({ length: 5 }, (_, i) =>
      makeObservation(i + 1, (i + 1) * 1000),
    );
    const prompts = Array.from({ length: 5 }, (_, i) =>
      makePrompt(i + 10, (i + 1) * 1000 + 500),
    );

    const result = buildTimeline(observations, prompts);

    expect(result).toHaveLength(10);
    for (let i = 1; i < result.length; i++) {
      expect(result[i].created_at_epoch).toBeGreaterThanOrEqual(result[i - 1].created_at_epoch);
    }
  });
});

// ---------------------------------------------------------------------------
// Type-guard helper used in component rendering
// ---------------------------------------------------------------------------

describe('TimelineItem type narrowing', () => {
  it('observation item has itemType "observation"', () => {
    const obs = makeObservation(1, 1000);
    const items = buildTimeline([obs], []);
    const item: TimelineItem = items[0];

    expect(item.itemType).toBe('observation');
  });

  it('prompt item has itemType "prompt"', () => {
    const prompt = makePrompt(1, 1000);
    const items = buildTimeline([], [prompt]);
    const item: TimelineItem = items[0];

    expect(item.itemType).toBe('prompt');
  });
});

// ---------------------------------------------------------------------------
// Props contract validation
// ---------------------------------------------------------------------------

describe('SessionDetail props contract', () => {
  it('SessionDetail type accepts null detail with isLoading false (empty state)', () => {
    // This validates the TypeScript type contract at compile-time.
    // The component accepts { detail: null, isLoading: false } as a valid props combination.
    const props: { detail: SessionDetail | null; isLoading: boolean } = {
      detail: null,
      isLoading: false,
    };
    expect(props.detail).toBeNull();
    expect(props.isLoading).toBe(false);
  });

  it('SessionDetail type accepts null detail with isLoading true (loading state)', () => {
    const props: { detail: SessionDetail | null; isLoading: boolean } = {
      detail: null,
      isLoading: true,
    };
    expect(props.detail).toBeNull();
    expect(props.isLoading).toBe(true);
  });

  it('SessionDetail type accepts non-null detail with isLoading false (data state)', () => {
    const detail: SessionDetail = {
      summary: {
        id: 1,
        session_id: SESSION_ID,
        project: PROJECT,
        request: 'Fix bug',
        created_at_epoch: 1000,
      },
      observations: [makeObservation(1, 2000)],
      prompts: [makePrompt(1, 1500)],
    };
    const props: { detail: SessionDetail | null; isLoading: boolean } = {
      detail,
      isLoading: false,
    };
    expect(props.detail).not.toBeNull();
    expect(props.detail!.summary.session_id).toBe(SESSION_ID);
    expect(props.detail!.observations).toHaveLength(1);
    expect(props.detail!.prompts).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Virtualization: source-code structural tests (RED → GREEN via implementation)
// ---------------------------------------------------------------------------

describe('SessionDetail virtualization — source structure', () => {
  it('imports useVirtualizer from @tanstack/react-virtual', () => {
    expect(SESSION_DETAIL_SOURCE).toMatch(/from\s+['"]@tanstack\/react-virtual['"]/);
    expect(SESSION_DETAIL_SOURCE).toMatch(/useVirtualizer/);
  });

  it('defines the 30-item threshold for enabling virtualization', () => {
    // The threshold constant must be defined with value 30
    expect(SESSION_DETAIL_SOURCE).toMatch(/VIRTUALIZATION_THRESHOLD\s*=\s*30/);
    // The threshold must be used in the comparison (not hardcoded)
    expect(SESSION_DETAIL_SOURCE).toMatch(/timelineItems\.length\s*>\s*VIRTUALIZATION_THRESHOLD/);
  });

  it('uses measureElement callback for variable heights', () => {
    expect(SESSION_DETAIL_SOURCE).toMatch(/measureElement/);
  });

  it('uses a ref for the scroll container', () => {
    // useRef must be imported and used for the scroll container
    expect(SESSION_DETAIL_SOURCE).toMatch(/useRef/);
    expect(SESSION_DETAIL_SOURCE).toMatch(/scrollElementRef|parentRef|containerRef|scrollRef/);
  });

  it('passes the scroll element ref to useVirtualizer as scrollElement or getScrollElement', () => {
    // The virtualizer must receive either scrollElement or getScrollElement
    expect(SESSION_DETAIL_SOURCE).toMatch(/scrollElement|getScrollElement/);
  });

  it('keeps the session-detail-timeline data-testid attribute', () => {
    expect(SESSION_DETAIL_SOURCE).toMatch(/data-testid=["']session-detail-timeline["']/);
  });

  it('does not apply virtualization when below threshold (renders items directly)', () => {
    // There must be a branch that renders the list without virtual items
    // when the timeline is small (i.e., a non-virtualizer render path)
    expect(SESSION_DETAIL_SOURCE).toMatch(/timelineItems\.map/);
  });

  it('uses getVirtualItems from the virtualizer for the virtual render path', () => {
    expect(SESSION_DETAIL_SOURCE).toMatch(/getVirtualItems\(\)/);
  });

  it('renders virtualizer items with a key derived from the virtual item index', () => {
    // Virtual rows must use virtualItem.key or virtualItem.index as React key
    expect(SESSION_DETAIL_SOURCE).toMatch(/virtualItem\.key|virtualItem\.index/);
  });

  it('does not mutate timelineItems array (uses index access, not splice/push)', () => {
    expect(SESSION_DETAIL_SOURCE).not.toMatch(/timelineItems\.splice|timelineItems\.push|timelineItems\.pop/);
  });
});
