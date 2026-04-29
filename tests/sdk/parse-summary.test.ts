import { describe, it, expect, mock } from 'bun:test';

mock.module('../../src/services/domain/ModeManager.js', () => ({
  ModeManager: {
    getInstance: () => ({
      getActiveMode: () => ({
        observation_types: [{ id: 'bugfix' }, { id: 'discovery' }, { id: 'refactor' }],
      }),
    }),
  },
}));

import { parseAgentXml } from '../../src/sdk/parser.js';

describe('parseAgentXml — summaries', () => {
  it('returns invalid when response is plain text (no XML)', () => {
    const result = parseAgentXml('Some plain text response without any XML tags');
    expect(result.valid).toBe(false);
  });

  it('returns invalid when <summary> has no sub-tags (false positive — was #1360)', () => {
    const result = parseAgentXml('<observation>done <summary>some content here</summary></observation>');
    expect(result.valid).toBe(false);
  });

  it('returns invalid for bare <summary> with only plain text, no sub-tags', () => {
    const result = parseAgentXml('<summary>This session was productive.</summary>');
    expect(result.valid).toBe(false);
  });

  it('returns valid summary when at least one sub-tag is present', () => {
    const text = `<summary><request>Fix the bug</request></summary>`;
    const result = parseAgentXml(text);
    expect(result.valid).toBe(true);
    if (result.valid && result.kind === 'summary') {
      expect(result.data.request).toBe('Fix the bug');
      expect(result.data.investigated).toBeNull();
      expect(result.data.learned).toBeNull();
    }
  });

  it('returns full summary when all fields are present', () => {
    const text = `<summary>
      <request>Fix login bug</request>
      <investigated>Auth flow and JWT expiry</investigated>
      <learned>Token was expiring too soon</learned>
      <completed>Extended token TTL to 24h</completed>
      <next_steps>Monitor error rates</next_steps>
    </summary>`;
    const result = parseAgentXml(text);
    expect(result.valid).toBe(true);
    if (result.valid && result.kind === 'summary') {
      expect(result.data.request).toBe('Fix login bug');
      expect(result.data.investigated).toBe('Auth flow and JWT expiry');
      expect(result.data.learned).toBe('Token was expiring too soon');
      expect(result.data.completed).toBe('Extended token TTL to 24h');
      expect(result.data.next_steps).toBe('Monitor error rates');
    }
  });

  it('treats <skip_summary reason="…"/> as a first-class summary with skipped:true', () => {
    const result = parseAgentXml('<skip_summary reason="no work done"/>');
    expect(result.valid).toBe(true);
    if (result.valid && result.kind === 'summary') {
      expect(result.data.skipped).toBe(true);
      expect(result.data.skip_reason).toBe('no work done');
    }
  });

  it('does NOT coerce <observation> into a summary (former #1633 path deleted)', () => {
    const result = parseAgentXml('<observation><title>foo</title></observation>');
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.kind).toBe('observation');
    }
  });

  it('prefers <summary> over <observation> when both present', () => {
    const text = `<observation><title>obs title</title></observation>
    <summary><request>summary request</request></summary>`;
    const result = parseAgentXml(text);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.kind).toBe('observation');
    }
  });

  it('returns invalid for empty input', () => {
    expect(parseAgentXml('').valid).toBe(false);
    expect(parseAgentXml('   \n  ').valid).toBe(false);
  });
});
