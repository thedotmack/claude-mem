import { describe, it, expect, beforeAll } from 'bun:test';
import { parseObservations } from '../../src/sdk/parser.js';
import { ModeManager } from '../../src/services/domain/ModeManager.js';

describe('parseObservations — unstructured fallback', () => {
  beforeAll(() => {
    ModeManager.getInstance().loadMode('code');
  });

  it('extracts title and narrative from plain text when no XML sub-tags', () => {
    const raw = `<observation>
H2 fix verified: User added missing add_score calls in Tier 9 backup checks
and updated the documentation to reflect the new scoring mechanism.
</observation>`;

    const results = parseObservations(raw);
    expect(results.length).toBe(1);
    expect(results[0].title).toBe('H2 fix verified: User added missing add_score calls in Tier 9 backup checks');
    expect(results[0].narrative).toContain('H2 fix verified');
    expect(results[0].narrative).toContain('scoring mechanism');
  });

  it('truncates title to 120 chars for very long first lines', () => {
    const longLine = 'A'.repeat(150);
    const raw = `<observation>${longLine}\nSecond line.</observation>`;

    const results = parseObservations(raw);
    expect(results.length).toBe(1);
    expect(results[0].title).toBe(`${'A'.repeat(117)}...`);
    expect(results[0].narrative).toContain(longLine);
  });

  it('does NOT fallback when proper XML sub-tags are present', () => {
    const raw = `<observation>
  <type>discovery</type>
  <title>Proper title</title>
  <narrative>Proper narrative</narrative>
  <facts><fact>Fact one</fact></facts>
  <concepts><concept>how-it-works</concept></concepts>
  <files_read></files_read>
  <files_modified></files_modified>
</observation>`;

    const results = parseObservations(raw);
    expect(results.length).toBe(1);
    expect(results[0].title).toBe('Proper title');
    expect(results[0].narrative).toBe('Proper narrative');
  });

  it('does NOT fallback when only non-title XML tags are present (e.g. <type>, <files_read>)', () => {
    // Partially structured: has <type> and <files_read> but no <title>/<narrative>
    // Should NOT trigger fallback — raw XML must not leak into title/narrative
    const raw = `<observation>
  <type>discovery</type>
  <files_read><file>src/foo.ts</file></files_read>
</observation>`;

    const results = parseObservations(raw);
    expect(results.length).toBe(1);
    expect(results[0].type).toBe('discovery');
    expect(results[0].title).toBeNull();
    expect(results[0].narrative).toBeNull();
    expect(results[0].files_read).toEqual(['src/foo.ts']);
  });

  it('preserves null fields when structured XML tags are present but empty', () => {
    const raw = `<observation>
  <type>discovery</type>
  <title></title>
  <narrative></narrative>
  <facts></facts>
  <concepts></concepts>
  <files_read></files_read>
  <files_modified></files_modified>
</observation>`;

    const results = parseObservations(raw);
    expect(results.length).toBe(1);
    // title/narrative tags exist but are empty → null, no fallback triggered
    expect(results[0].title).toBeNull();
    expect(results[0].narrative).toBeNull();
  });

  it('triggers fallback when prose contains XML-like literals without closing tags', () => {
    // Plain text mentioning <type> and <title> as literals — not real tag pairs
    const raw = `<observation>
The model mentioned <type> and <title> in its response but never closed them properly.
This should be treated as unstructured text.
</observation>`;

    const results = parseObservations(raw);
    expect(results.length).toBe(1);
    // No real open+close tag pairs → fallback should fire
    expect(results[0].title).toBe('The model mentioned <type> and <title> in its response but never closed them properly.');
    expect(results[0].narrative).toContain('unstructured text');
  });
});
