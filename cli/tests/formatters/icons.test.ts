import { describe, it, expect } from 'bun:test';
import { getTypeIcon, getTypeName } from '../../src/formatters/icons.ts';

// Expected icon values sourced from src/formatters/icons.ts
// Using unicode escapes so the test file is ASCII-safe in all editors.
const ICONS = {
  decision:        '\u26d6',
  bugfix:          '\ud83d\udfe1',
  feature:         '\ud83d\udfe2',
  discovery:       '\ud83d\udfe3',
  change:          '\ud83d\udfe2',
  refactor:        '\ud83d\udd35',
  'how-it-works':  '\ud83d\udd35',
  gotcha:          '\ud83d\udd34',
  'trade-off':     '\u2696\ufe0f',
  'session-request': '\ud83c\udfaf',
  DEFAULT:         '\u25cb',
};

// ─── getTypeIcon ──────────────────────────────────────────────────────────

describe('getTypeIcon', () => {
  it('returns correct icon for "decision"', () => {
    expect(getTypeIcon('decision')).toBe(ICONS.decision);
  });

  it('returns correct icon for "bugfix"', () => {
    expect(getTypeIcon('bugfix')).toBe(ICONS.bugfix);
  });

  it('returns correct icon for "feature"', () => {
    expect(getTypeIcon('feature')).toBe(ICONS.feature);
  });

  it('returns correct icon for "discovery"', () => {
    expect(getTypeIcon('discovery')).toBe(ICONS.discovery);
  });

  it('returns correct icon for "change"', () => {
    expect(getTypeIcon('change')).toBe(ICONS.change);
  });

  it('returns correct icon for "refactor"', () => {
    expect(getTypeIcon('refactor')).toBe(ICONS.refactor);
  });

  it('returns correct icon for "how-it-works"', () => {
    expect(getTypeIcon('how-it-works')).toBe(ICONS['how-it-works']);
  });

  it('returns correct icon for "gotcha"', () => {
    expect(getTypeIcon('gotcha')).toBe(ICONS.gotcha);
  });

  it('returns correct icon for "trade-off"', () => {
    expect(getTypeIcon('trade-off')).toBe(ICONS['trade-off']);
  });

  it('returns correct icon for "session-request"', () => {
    expect(getTypeIcon('session-request')).toBe(ICONS['session-request']);
  });

  it('returns default circle icon for an unknown type', () => {
    expect(getTypeIcon('unknown-type')).toBe(ICONS.DEFAULT);
  });

  it('returns default circle icon for empty string', () => {
    expect(getTypeIcon('')).toBe(ICONS.DEFAULT);
  });

  it('returns default circle icon for a numeric string', () => {
    expect(getTypeIcon('42')).toBe(ICONS.DEFAULT);
  });

  it('returns default circle icon for a mixed-case variant of a known type', () => {
    // Icon lookup is case-sensitive; "Decision" is not in the map
    expect(getTypeIcon('Decision')).toBe(ICONS.DEFAULT);
  });
});

// ─── getTypeName ──────────────────────────────────────────────────────────

describe('getTypeName', () => {
  it('replaces hyphens with spaces', () => {
    expect(getTypeName('how-it-works')).toBe('how it works');
  });

  it('replaces multiple hyphens', () => {
    expect(getTypeName('trade-off')).toBe('trade off');
  });

  it('returns the string unchanged when no hyphens are present', () => {
    expect(getTypeName('decision')).toBe('decision');
  });

  it('returns an empty string unchanged', () => {
    expect(getTypeName('')).toBe('');
  });

  it('handles session-request correctly', () => {
    expect(getTypeName('session-request')).toBe('session request');
  });
});
