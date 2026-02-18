/**
 * Tests for SummaryCard component logic
 *
 * Since @testing-library/react is not installed (vitest runs without a browser),
 * we test:
 * 1. getDefaultExpandedSections - the pure initial state builder
 * 2. buildSections - the pure section-filter / config builder
 * 3. The component module exports without errors (smoke test)
 *
 * Visual / interaction behaviour (CSS animations, chevron clicks) is
 * covered by the Playwright E2E suite.
 */

import { describe, it, expect } from 'vitest';
import type { Summary } from '../../../src/ui/viewer/types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_SUMMARY: Summary = {
  id: 42,
  session_id: 'session-abc-123',
  project: 'test-project',
  request: 'Implement feature X',
  investigated: 'Investigated the codebase structure',
  learned: 'Learned about the hook system',
  completed: 'Completed the implementation',
  next_steps: 'Write tests and review',
  created_at_epoch: 1739836800000,
};

const MINIMAL_SUMMARY: Summary = {
  id: 1,
  session_id: 'session-min',
  project: 'min-project',
  created_at_epoch: 1000,
};

// ---------------------------------------------------------------------------
// getDefaultExpandedSections tests
// ---------------------------------------------------------------------------

describe('getDefaultExpandedSections', () => {
  it('returns investigated as collapsed by default', async () => {
    const { getDefaultExpandedSections } = await import(
      '../../../src/ui/viewer/components/SummaryCard.js'
    );

    const state = getDefaultExpandedSections();
    expect(state['investigated']).toBe(false);
  });

  it('returns learned as collapsed by default', async () => {
    const { getDefaultExpandedSections } = await import(
      '../../../src/ui/viewer/components/SummaryCard.js'
    );

    const state = getDefaultExpandedSections();
    expect(state['learned']).toBe(false);
  });

  it('returns completed as expanded by default', async () => {
    const { getDefaultExpandedSections } = await import(
      '../../../src/ui/viewer/components/SummaryCard.js'
    );

    const state = getDefaultExpandedSections();
    expect(state['completed']).toBe(true);
  });

  it('returns next_steps as expanded by default', async () => {
    const { getDefaultExpandedSections } = await import(
      '../../../src/ui/viewer/components/SummaryCard.js'
    );

    const state = getDefaultExpandedSections();
    expect(state['next_steps']).toBe(true);
  });

  it('returns exactly four section keys', async () => {
    const { getDefaultExpandedSections } = await import(
      '../../../src/ui/viewer/components/SummaryCard.js'
    );

    const state = getDefaultExpandedSections();
    expect(Object.keys(state)).toHaveLength(4);
  });

  it('returns a new object on each call (immutable default)', async () => {
    const { getDefaultExpandedSections } = await import(
      '../../../src/ui/viewer/components/SummaryCard.js'
    );

    const a = getDefaultExpandedSections();
    const b = getDefaultExpandedSections();
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// buildSections tests
// ---------------------------------------------------------------------------

describe('buildSections', () => {
  it('returns all four sections when summary has all fields', async () => {
    const { buildSections } = await import(
      '../../../src/ui/viewer/components/SummaryCard.js'
    );

    const sections = buildSections(BASE_SUMMARY);
    expect(sections).toHaveLength(4);
  });

  it('assigns key "investigated" to the investigated section', async () => {
    const { buildSections } = await import(
      '../../../src/ui/viewer/components/SummaryCard.js'
    );

    const sections = buildSections(BASE_SUMMARY);
    expect(sections.some(s => s.key === 'investigated')).toBe(true);
  });

  it('assigns key "learned" to the learned section', async () => {
    const { buildSections } = await import(
      '../../../src/ui/viewer/components/SummaryCard.js'
    );

    const sections = buildSections(BASE_SUMMARY);
    expect(sections.some(s => s.key === 'learned')).toBe(true);
  });

  it('assigns key "completed" to the completed section', async () => {
    const { buildSections } = await import(
      '../../../src/ui/viewer/components/SummaryCard.js'
    );

    const sections = buildSections(BASE_SUMMARY);
    expect(sections.some(s => s.key === 'completed')).toBe(true);
  });

  it('assigns key "next_steps" to the next_steps section', async () => {
    const { buildSections } = await import(
      '../../../src/ui/viewer/components/SummaryCard.js'
    );

    const sections = buildSections(BASE_SUMMARY);
    expect(sections.some(s => s.key === 'next_steps')).toBe(true);
  });

  it('filters out sections with no content', async () => {
    const { buildSections } = await import(
      '../../../src/ui/viewer/components/SummaryCard.js'
    );

    const partial: Summary = {
      ...BASE_SUMMARY,
      investigated: undefined,
      learned: undefined,
    };

    const sections = buildSections(partial);
    expect(sections).toHaveLength(2);
    expect(sections.every(s => s.key === 'completed' || s.key === 'next_steps')).toBe(true);
  });

  it('returns an empty array when summary has no section content', async () => {
    const { buildSections } = await import(
      '../../../src/ui/viewer/components/SummaryCard.js'
    );

    const sections = buildSections(MINIMAL_SUMMARY);
    expect(sections).toHaveLength(0);
  });

  it('each section has a label string', async () => {
    const { buildSections } = await import(
      '../../../src/ui/viewer/components/SummaryCard.js'
    );

    const sections = buildSections(BASE_SUMMARY);
    sections.forEach(s => {
      expect(typeof s.label).toBe('string');
      expect(s.label.length).toBeGreaterThan(0);
    });
  });

  it('each section has a content string matching the summary field', async () => {
    const { buildSections } = await import(
      '../../../src/ui/viewer/components/SummaryCard.js'
    );

    const sections = buildSections(BASE_SUMMARY);
    const investigatedSection = sections.find(s => s.key === 'investigated');
    expect(investigatedSection?.content).toBe('Investigated the codebase structure');
  });

  it('each section has an icon path string', async () => {
    const { buildSections } = await import(
      '../../../src/ui/viewer/components/SummaryCard.js'
    );

    const sections = buildSections(BASE_SUMMARY);
    sections.forEach(s => {
      expect(typeof s.icon).toBe('string');
      expect(s.icon.length).toBeGreaterThan(0);
    });
  });

  it('does not mutate the input summary', async () => {
    const { buildSections } = await import(
      '../../../src/ui/viewer/components/SummaryCard.js'
    );

    const input = { ...BASE_SUMMARY };
    buildSections(input);
    expect(input).toEqual(BASE_SUMMARY);
  });
});

// ---------------------------------------------------------------------------
// toggleSection tests
// ---------------------------------------------------------------------------

describe('toggleSection', () => {
  it('toggles false to true for given key', async () => {
    const { toggleSection } = await import(
      '../../../src/ui/viewer/components/SummaryCard.js'
    );

    const before: Record<string, boolean> = { investigated: false, learned: false, completed: true, next_steps: true };
    const after = toggleSection(before, 'investigated');
    expect(after['investigated']).toBe(true);
  });

  it('toggles true to false for given key', async () => {
    const { toggleSection } = await import(
      '../../../src/ui/viewer/components/SummaryCard.js'
    );

    const before: Record<string, boolean> = { investigated: false, learned: false, completed: true, next_steps: true };
    const after = toggleSection(before, 'completed');
    expect(after['completed']).toBe(false);
  });

  it('does not mutate the input state (immutability)', async () => {
    const { toggleSection } = await import(
      '../../../src/ui/viewer/components/SummaryCard.js'
    );

    const before: Record<string, boolean> = { investigated: false, learned: false, completed: true, next_steps: true };
    const original = { ...before };
    toggleSection(before, 'investigated');
    expect(before).toEqual(original);
  });

  it('preserves other keys unchanged when toggling one key', async () => {
    const { toggleSection } = await import(
      '../../../src/ui/viewer/components/SummaryCard.js'
    );

    const before: Record<string, boolean> = { investigated: false, learned: false, completed: true, next_steps: true };
    const after = toggleSection(before, 'investigated');
    expect(after['learned']).toBe(false);
    expect(after['completed']).toBe(true);
    expect(after['next_steps']).toBe(true);
  });

  it('returns a new object reference', async () => {
    const { toggleSection } = await import(
      '../../../src/ui/viewer/components/SummaryCard.js'
    );

    const before: Record<string, boolean> = { investigated: false };
    const after = toggleSection(before, 'investigated');
    expect(after).not.toBe(before);
  });
});

// ---------------------------------------------------------------------------
// buildSections empty state — "No details available" scenario (F.6 / F.18)
// ---------------------------------------------------------------------------

describe('buildSections empty state', () => {
  it('returns empty array when all section fields are undefined', async () => {
    const { buildSections } = await import(
      '../../../src/ui/viewer/components/SummaryCard.js'
    );

    const emptySummary: Summary = {
      id: 99,
      session_id: 'session-empty',
      project: 'test',
      created_at_epoch: 1000,
      // All section fields undefined
    };

    expect(buildSections(emptySummary)).toHaveLength(0);
  });

  it('returns empty array when all section fields are empty strings', async () => {
    const { buildSections } = await import(
      '../../../src/ui/viewer/components/SummaryCard.js'
    );

    const emptySummary: Summary = {
      id: 99,
      session_id: 'session-empty',
      project: 'test',
      created_at_epoch: 1000,
      investigated: '',
      learned: '',
      completed: '',
      next_steps: '',
    };

    expect(buildSections(emptySummary)).toHaveLength(0);
  });

  it('returns only sections with content, filtering out empty ones', async () => {
    const { buildSections } = await import(
      '../../../src/ui/viewer/components/SummaryCard.js'
    );

    const partialSummary: Summary = {
      id: 99,
      session_id: 'session-partial',
      project: 'test',
      created_at_epoch: 1000,
      investigated: '',
      learned: undefined,
      completed: 'Done something',
      next_steps: '',
    };

    const sections = buildSections(partialSummary);
    expect(sections).toHaveLength(1);
    expect(sections[0].key).toBe('completed');
  });
});

// ---------------------------------------------------------------------------
// Component import smoke test
// ---------------------------------------------------------------------------

describe('SummaryCard component module', () => {
  it('exports a SummaryCard function component', async () => {
    const mod = await import(
      '../../../src/ui/viewer/components/SummaryCard.js'
    );
    expect(typeof mod.SummaryCard).toBe('function');
  });

  it('exports getDefaultExpandedSections as a function', async () => {
    const mod = await import(
      '../../../src/ui/viewer/components/SummaryCard.js'
    );
    expect(typeof mod.getDefaultExpandedSections).toBe('function');
  });

  it('exports buildSections as a function', async () => {
    const mod = await import(
      '../../../src/ui/viewer/components/SummaryCard.js'
    );
    expect(typeof mod.buildSections).toBe('function');
  });

  it('exports toggleSection as a function', async () => {
    const mod = await import(
      '../../../src/ui/viewer/components/SummaryCard.js'
    );
    expect(typeof mod.toggleSection).toBe('function');
  });
});
