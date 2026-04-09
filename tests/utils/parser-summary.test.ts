/**
 * Tests for parseSummary — covers the <observation>-instead-of-<summary> regression (#1649)
 *
 * When the LLM applies pattern-completion bias from prior observation turns it emits
 * <observation> tags on the summarize turn. parseSummary must:
 *   1. Return null (no summary stored)
 *   2. Log a WARN with "observation" in the message so operators can detect it
 */
import { describe, it, expect, spyOn, beforeEach, afterEach } from 'bun:test';
import { parseSummary } from '../../src/sdk/parser.js';
import { logger } from '../../src/utils/logger.js';

describe('parseSummary (#1649 regression)', () => {
  let warnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    warnSpy = spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('returns null when response contains only <observation> tags (no <summary>)', () => {
    const observationOnlyResponse = `
<observation>
  <type>bugfix</type>
  <title>Fixed login bug</title>
  <narrative>Identified and fixed the authentication issue</narrative>
</observation>`;

    const result = parseSummary(observationOnlyResponse, 42);
    expect(result).toBeNull();
  });

  it('logs a warning when <observation> tags appear without <summary> (#1649)', () => {
    const observationOnlyResponse = `
<observation>
  <type>bugfix</type>
  <title>Fixed login bug</title>
</observation>`;

    parseSummary(observationOnlyResponse, 42);

    // Must warn so operators can detect the pattern-completion bias issue
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [, warningMessage] = warnSpy.mock.calls[0] as [string, string, ...unknown[]];
    expect(warningMessage).toContain('observation');
    expect(warningMessage).toContain('summary');
  });

  it('does NOT warn when response is simply empty (no XML tags)', () => {
    const emptyResponse = 'I have nothing to report.';

    parseSummary(emptyResponse, 42);

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('parses a valid <summary> block correctly', () => {
    const validSummary = `
<summary>
  <request>Fix the login bug</request>
  <investigated>Traced the auth flow</investigated>
  <learned>Token refresh was missing</learned>
  <completed>Added token refresh</completed>
  <next_steps>Write tests for refresh flow</next_steps>
  <notes>Reviewed 3 files</notes>
</summary>`;

    const result = parseSummary(validSummary, 42);
    expect(result).not.toBeNull();
    expect(result!.request).toBe('Fix the login bug');
    expect(result!.learned).toBe('Token refresh was missing');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does NOT warn when <observation> tag appears alongside a valid <summary> block', () => {
    // Edge case: response contains both — summary wins, no warning
    const mixed = `
<observation><type>discovery</type></observation>
<summary>
  <request>Fix bug</request>
  <investigated>traced</investigated>
  <learned>found root cause</learned>
  <completed>patched it</completed>
  <next_steps>deploy</next_steps>
</summary>`;

    const result = parseSummary(mixed, 42);
    expect(result).not.toBeNull();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
