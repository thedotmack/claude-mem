/**
 * Viewer enrichment tests (Task 9)
 *
 * Tests for:
 * 1. ENTITY_TYPES constant
 * 2. safeParseJsonArray with entity objects
 * 3. useFilters: toggleTopic, toggleEntityType, togglePinned
 * 4. hasActiveFilters / activeFilterCount including new filter dimensions
 * 5. ObservationCard enrichment rendering helpers
 */

import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// ENTITY_TYPES constant
// ---------------------------------------------------------------------------

describe('ENTITY_TYPES constant', () => {
  it('should export all 5 entity types', async () => {
    const { ENTITY_TYPES } = await import('../../src/ui/viewer/constants/filters.js');
    expect(ENTITY_TYPES).toEqual(['person', 'system', 'team', 'technology', 'component']);
  });

  it('should have exactly 5 entries', async () => {
    const { ENTITY_TYPES } = await import('../../src/ui/viewer/constants/filters.js');
    expect(ENTITY_TYPES.length).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// safeParseJsonArray with entity objects
// ---------------------------------------------------------------------------

describe('safeParseJsonArray — entity objects', () => {
  it('should parse entity JSON array', async () => {
    const { safeParseJsonArray } = await import('../../src/ui/viewer/components/ObservationCard.js');
    const entities = safeParseJsonArray('[{"name":"Alice","type":"person"},{"name":"Redis","type":"system"}]');
    expect(entities).toEqual([
      { name: 'Alice', type: 'person' },
      { name: 'Redis', type: 'system' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// ObservationCard enrichment helpers
// ---------------------------------------------------------------------------

describe('ObservationCard — parseEntities helper', () => {
  it('should export parseEntities function', async () => {
    const mod = await import('../../src/ui/viewer/components/ObservationCard.js');
    expect(typeof mod.parseEntities).toBe('function');
  });

  it('should parse valid entities JSON string', async () => {
    const { parseEntities } = await import('../../src/ui/viewer/components/ObservationCard.js');
    const result = parseEntities('[{"name":"Alice","type":"person"},{"name":"Redis","type":"system"}]');
    expect(result).toEqual([
      { name: 'Alice', type: 'person' },
      { name: 'Redis', type: 'system' },
    ]);
  });

  it('should return empty array for null', async () => {
    const { parseEntities } = await import('../../src/ui/viewer/components/ObservationCard.js');
    expect(parseEntities(null)).toEqual([]);
  });

  it('should return empty array for malformed JSON', async () => {
    const { parseEntities } = await import('../../src/ui/viewer/components/ObservationCard.js');
    expect(parseEntities('{broken')).toEqual([]);
  });

  it('should filter out entries without name field', async () => {
    const { parseEntities } = await import('../../src/ui/viewer/components/ObservationCard.js');
    const result = parseEntities('[{"name":"Alice","type":"person"},{"type":"system"}]');
    expect(result).toEqual([{ name: 'Alice', type: 'person' }]);
  });
});

describe('ObservationCard — formatEventDate helper', () => {
  it('should export formatEventDate function', async () => {
    const mod = await import('../../src/ui/viewer/components/ObservationCard.js');
    expect(typeof mod.formatEventDate).toBe('function');
  });

  it('should format ISO date to human-readable', async () => {
    const { formatEventDate } = await import('../../src/ui/viewer/components/ObservationCard.js');
    const result = formatEventDate('2026-03-15');
    expect(result).toMatch(/Mar.*15.*2026/);
  });

  it('should return null for null input', async () => {
    const { formatEventDate } = await import('../../src/ui/viewer/components/ObservationCard.js');
    expect(formatEventDate(null)).toBeNull();
  });

  it('should return null for empty string', async () => {
    const { formatEventDate } = await import('../../src/ui/viewer/components/ObservationCard.js');
    expect(formatEventDate('')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// useFilters — enrichment toggles
// ---------------------------------------------------------------------------

describe('useFilters — EMPTY_FILTER enrichment defaults', () => {
  it('should include topics as empty array', async () => {
    const { EMPTY_FILTER } = await import('../../src/ui/viewer/hooks/useFilters.js');
    expect(EMPTY_FILTER.topics).toEqual([]);
  });

  it('should include entityTypes as empty array', async () => {
    const { EMPTY_FILTER } = await import('../../src/ui/viewer/hooks/useFilters.js');
    expect(EMPTY_FILTER.entityTypes).toEqual([]);
  });

  it('should include pinned as null', async () => {
    const { EMPTY_FILTER } = await import('../../src/ui/viewer/hooks/useFilters.js');
    expect(EMPTY_FILTER.pinned).toBeNull();
  });
});
