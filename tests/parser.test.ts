import { describe, it, expect, mock, beforeEach } from 'bun:test';

// Mock dependencies before importing parser
mock.module('../src/utils/logger', () => ({
  logger: {
    info: () => {},
    warn: () => {},
    error: () => {}
  }
}));

mock.module('../src/services/domain/ModeManager', () => ({
  ModeManager: {
    getInstance: () => ({
      getActiveMode: () => ({
        observation_types: [{ id: 'observation' }, { id: 'decision' }],
        prompts: {}
      })
    })
  }
}));

import { parseSummary, parseObservations } from '../src/sdk/parser';

describe('parseSummary', () => {
  it('returns null when no summary or observation tags present', () => {
    const result = parseSummary('some random text');
    expect(result).toBeNull();
  });

  it('returns null when skip_summary tag is present', () => {
    const result = parseSummary('<skip_summary reason="no work done" />');
    expect(result).toBeNull();
  });

  it('parses a valid summary block', () => {
    const text = `
<summary>
  <request>Fix the bug</request>
  <investigated>Found root cause in parser.ts</investigated>
  <learned>The regex was greedy</learned>
  <completed>Fixed the regex</completed>
  <next_steps>Add tests</next_steps>
  <notes>Low risk change</notes>
</summary>
    `;
    const result = parseSummary(text);
    expect(result).not.toBeNull();
    expect(result?.request).toBe('Fix the bug');
    expect(result?.investigated).toBe('Found root cause in parser.ts');
    expect(result?.learned).toBe('The regex was greedy');
    expect(result?.completed).toBe('Fixed the regex');
    expect(result?.next_steps).toBe('Add tests');
    expect(result?.notes).toBe('Low risk change');
  });

  it('salvages summary from observation tags when summary tag is absent (issue #1546)', () => {
    const text = `
<observation>
  <type>observation</type>
  <title>Fixed authentication bug in login handler</title>
  <narrative>The root cause was a missing null check in the token validation logic. Added guard clause to prevent NPE.</narrative>
  <facts>
    <fact>Token validation was missing null check</fact>
    <fact>Added guard clause in auth.ts line 42</fact>
  </facts>
</observation>
    `;
    const result = parseSummary(text);
    expect(result).not.toBeNull();
    expect(result?.completed).toBe('Fixed authentication bug in login handler');
    expect(result?.learned).toBe('The root cause was a missing null check in the token validation logic. Added guard clause to prevent NPE.');
    expect(result?.request).toBeNull();
    expect(result?.investigated).toBeNull();
    expect(result?.next_steps).toBeNull();
  });

  it('salvages summary using facts when observation has no narrative (issue #1546)', () => {
    const text = `
<observation>
  <type>decision</type>
  <title>Chose SQLite over PostgreSQL</title>
  <facts>
    <fact>SQLite has zero configuration</fact>
    <fact>PostgreSQL requires a running server</fact>
  </facts>
</observation>
    `;
    const result = parseSummary(text);
    expect(result).not.toBeNull();
    expect(result?.completed).toBe('Chose SQLite over PostgreSQL');
    expect(result?.learned).toBe('SQLite has zero configuration; PostgreSQL requires a running server');
  });

  it('returns null when observation tags present but no useful data', () => {
    const text = '<observation><type>observation</type></observation>';
    const result = parseSummary(text);
    expect(result).toBeNull();
  });
});
