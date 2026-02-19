/**
 * Tests for ObservationCard component
 *
 * Since @testing-library/react is not installed, we test:
 * 1. stripProjectRoot — the exported pure utility function
 * 2. mergeNarrative — the exported pure subtitle-merging function
 * 3. safeParseJsonArray — the exported malformed-JSON guard
 *
 * Visual / interaction behaviour is covered by Playwright E2E tests.
 */

import { describe, it, expect } from 'vitest';
import { stripProjectRoot, safeParseJsonArray, mergeNarrative } from '../../../src/ui/viewer/components/ObservationCard';

// ---------------------------------------------------------------------------
// stripProjectRoot — pure utility tests
// ---------------------------------------------------------------------------

describe('stripProjectRoot', () => {
  it('strips paths that contain the /src/ marker', () => {
    const result = stripProjectRoot('/home/user/magic-claude-mem/src/hooks/post-tool-use.ts');
    expect(result).toBe('src/hooks/post-tool-use.ts');
  });

  it('strips paths that contain the /plugin/ marker', () => {
    const result = stripProjectRoot('/home/user/magic-claude-mem/plugin/scripts/worker-service.cjs');
    expect(result).toBe('plugin/scripts/worker-service.cjs');
  });

  it('strips paths that contain the /docs/ marker', () => {
    const result = stripProjectRoot('/home/user/magic-claude-mem/docs/public/getting-started.mdx');
    expect(result).toBe('docs/public/getting-started.mdx');
  });

  it('strips paths that contain the /Scripts/ marker (capital S)', () => {
    const result = stripProjectRoot('/home/user/magic-claude-mem/Scripts/build.js');
    expect(result).toBe('Scripts/build.js');
  });

  it('strips paths that contain the magic-claude-mem/ project name marker', () => {
    const result = stripProjectRoot('/mnt/c/projects/magic-claude-mem/tsconfig.json');
    expect(result).toBe('tsconfig.json');
  });

  it('returns last 3 segments when no known markers are found', () => {
    const result = stripProjectRoot('/some/deep/unknown/path/to/file.ts');
    expect(result).toBe('path/to/file.ts');
  });

  it('returns the path unchanged when it has 3 or fewer segments and no markers', () => {
    const result = stripProjectRoot('a/b/c');
    expect(result).toBe('a/b/c');
  });

  it('handles empty string without throwing', () => {
    expect(() => stripProjectRoot('')).not.toThrow();
  });

  it('handles a path with only a filename (no slashes)', () => {
    const result = stripProjectRoot('file.ts');
    expect(result).toBe('file.ts');
  });

  it('prioritises the first matching marker when path contains multiple markers', () => {
    const result = stripProjectRoot('/home/user/magic-claude-mem/src/docs/something.ts');
    expect(result).toBe('src/docs/something.ts');
  });
});

// ---------------------------------------------------------------------------
// mergeNarrative — pure subtitle-merging function tests
// ---------------------------------------------------------------------------

describe('mergeNarrative', () => {
  it('returns narrative unchanged when subtitle is null', () => {
    expect(mergeNarrative(null, 'Title', 'Narrative text.')).toBe('Narrative text.');
  });

  it('returns narrative unchanged when subtitle equals title', () => {
    expect(mergeNarrative('Same text', 'Same text', 'Narrative.')).toBe('Narrative.');
  });

  it('appends subtitle to narrative when subtitle differs from title', () => {
    expect(mergeNarrative('Additional context', 'Main title', 'Original narrative.'))
      .toBe('Original narrative.\n\nAdditional context');
  });

  it('returns subtitle only when narrative is null and subtitle differs from title', () => {
    expect(mergeNarrative('Additional context', 'Main title', null))
      .toBe('Additional context');
  });

  it('returns null when both subtitle and narrative are null', () => {
    expect(mergeNarrative(null, 'Title', null)).toBeNull();
  });

  it('returns empty string subtitle when narrative is empty and subtitle differs from title', () => {
    expect(mergeNarrative('Sub', 'Title', '')).toBe('Sub');
  });

  it('trims whitespace from the merged result', () => {
    expect(mergeNarrative('Sub', 'Title', '  ')).toBe('Sub');
  });
});

// ---------------------------------------------------------------------------
// safeParseJsonArray — malformed JSON guard tests
// ---------------------------------------------------------------------------

describe('safeParseJsonArray', () => {
  it('returns empty array for null input', () => {
    expect(safeParseJsonArray(null)).toEqual([]);
  });

  it('returns empty array for undefined input', () => {
    expect(safeParseJsonArray(undefined)).toEqual([]);
  });

  it('returns empty array for empty string', () => {
    expect(safeParseJsonArray('')).toEqual([]);
  });

  it('parses valid JSON array of strings', () => {
    expect(safeParseJsonArray('["a","b","c"]')).toEqual(['a', 'b', 'c']);
  });

  it('returns empty array for valid JSON that is not an array', () => {
    expect(safeParseJsonArray('{"key": "value"}')).toEqual([]);
  });

  it('returns empty array for valid JSON number', () => {
    expect(safeParseJsonArray('42')).toEqual([]);
  });

  it('returns empty array for valid JSON string (not array)', () => {
    expect(safeParseJsonArray('"hello"')).toEqual([]);
  });

  it('returns empty array for malformed JSON', () => {
    expect(safeParseJsonArray('{broken json')).toEqual([]);
  });

  it('returns empty array for truncated JSON array', () => {
    expect(safeParseJsonArray('["a","b"')).toEqual([]);
  });

  it('parses valid empty JSON array', () => {
    expect(safeParseJsonArray('[]')).toEqual([]);
  });

  it('does not throw on any input', () => {
    const inputs = [null, undefined, '', 'null', '{}', '"str"', '42', '{bad', '["truncated'];
    for (const input of inputs) {
      expect(() => safeParseJsonArray(input)).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// ObservationCard component module — smoke test (import must not throw)
// ---------------------------------------------------------------------------

describe('ObservationCard module', () => {
  it('exports stripProjectRoot as a named export', async () => {
    const mod = await import('../../../src/ui/viewer/components/ObservationCard');
    expect(typeof mod.stripProjectRoot).toBe('function');
  });

  it('exports mergeNarrative as a named export', async () => {
    const mod = await import('../../../src/ui/viewer/components/ObservationCard');
    expect(typeof mod.mergeNarrative).toBe('function');
  });

  it('exports ObservationCard as a named export', async () => {
    const mod = await import('../../../src/ui/viewer/components/ObservationCard');
    expect(mod.ObservationCard).toBeDefined();
    expect(typeof mod.ObservationCard).toMatch(/function|object/);
  });
});
