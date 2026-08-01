import { describe, it, expect } from 'bun:test';
import {
  classifyObserverOutput,
  describeObserverOutputShape,
  formatEmptyOutputReason,
  isAuthFailureObserverOutput,
  isQuotaLimitedObserverOutput,
  previewOutput,
} from '../../src/sdk/output-classifier.js';

describe('classifyObserverOutput (plan-11 #2485)', () => {
  it('classifies valid <observation> XML as xml', () => {
    const xml = `<observation>
      <type>discovery</type>
      <title>A real finding</title>
    </observation>`;
    expect(classifyObserverOutput(xml)).toBe('xml');
  });

  it('classifies <summary> XML as xml', () => {
    expect(classifyObserverOutput('<summary><request>do x</request></summary>')).toBe('xml');
  });

  it('classifies <skip_summary/> as xml', () => {
    expect(classifyObserverOutput('<skip_summary reason="nothing to do"/>')).toBe('xml');
  });

  it('classifies empty string as idle', () => {
    expect(classifyObserverOutput('')).toBe('idle');
  });

  it('classifies whitespace-only output as idle', () => {
    expect(classifyObserverOutput('   \n\t  ')).toBe('idle');
  });

  it('classifies a non-string as idle (fail-safe)', () => {
    expect(classifyObserverOutput(undefined)).toBe('idle');
    expect(classifyObserverOutput(null)).toBe('idle');
  });

  it('classifies conversational prose as prose', () => {
    expect(classifyObserverOutput('Skipping — repeated log scan with no new findings.')).toBe('prose');
  });

  it('classifies former poison marker strings as ordinary prose', () => {
    expect(classifyObserverOutput('This session has been exhausted, I cannot continue.')).toBe('prose');
    expect(classifyObserverOutput('Error: prompt is too long for this model.')).toBe('prose');
    expect(classifyObserverOutput('I hit the context window, so there is no XML.')).toBe('prose');
  });

  it('does not let former poison markers override XML-shaped output', () => {
    expect(classifyObserverOutput('session exhausted <observation></observation>')).toBe('xml');
  });
});

describe('isQuotaLimitedObserverOutput', () => {
  it('detects Claude weekly-limit prose', () => {
    expect(
      isQuotaLimitedObserverOutput('Claude usage limit reached. Your weekly limit will reset soon.'),
    ).toBe(true);
  });

  it('detects subscription quota prose', () => {
    expect(
      isQuotaLimitedObserverOutput('Your subscription quota has been exhausted. Please try again after it resets.'),
    ).toBe(true);
  });

  it('does not treat context-window prose as quota prose', () => {
    expect(
      isQuotaLimitedObserverOutput('I hit the context window and cannot produce valid XML.'),
    ).toBe(false);
  });

  it('does not treat ordinary observer prose as quota prose', () => {
    expect(isQuotaLimitedObserverOutput('No observations to record.')).toBe(false);
  });
});

describe('isAuthFailureObserverOutput', () => {
  it('detects common authentication-failure prose', () => {
    expect(isAuthFailureObserverOutput('Failed to authenticate. API Error: 401')).toBe(true);
    expect(isAuthFailureObserverOutput('Authentication failed with HTTP 403.')).toBe(true);
    expect(isAuthFailureObserverOutput('Authentication failure; please run /login.')).toBe(true);
    expect(isAuthFailureObserverOutput('Please run /login to authenticate again.')).toBe(true);
    expect(isAuthFailureObserverOutput('Authentication required, run /login to continue.')).toBe(true);
    expect(isAuthFailureObserverOutput('401 Unauthorized')).toBe(true);
    expect(isAuthFailureObserverOutput('403 Forbidden')).toBe(true);
    expect(isAuthFailureObserverOutput('Status: 401')).toBe(true);
    expect(isAuthFailureObserverOutput('Request failed with 403')).toBe(true);
  });

  it('does not classify XML, ordinary prose, or unrelated numeric output as auth failure', () => {
    expect(isAuthFailureObserverOutput('<observation><title>HTTP 401</title></observation>')).toBe(false);
    expect(isAuthFailureObserverOutput('The request returned 500 and produced no XML.')).toBe(false);
    expect(isAuthFailureObserverOutput('No observations to record.')).toBe(false);
    expect(isAuthFailureObserverOutput('Please run /login in the observed project instructions.')).toBe(false);
    expect(isAuthFailureObserverOutput('The project authentication guide says to run /login before testing.')).toBe(false);
  });
});

describe('previewOutput', () => {
  it('collapses whitespace and trims', () => {
    expect(previewOutput('  hello\n\n  world  ')).toBe('hello world');
  });

  it('truncates long output and reports remaining length', () => {
    const long = 'x'.repeat(300);
    const preview = previewOutput(long, 50);
    expect(preview.startsWith('x'.repeat(50))).toBe(true);
    expect(preview).toContain('+250 chars');
  });

  it('describes non-string input', () => {
    expect(previewOutput(42)).toContain('non-string');
  });
});

describe('describeObserverOutputShape and formatEmptyOutputReason (#3454)', () => {
  it('returns no-content-blocks for null', () => {
    const r = describeObserverOutputShape(null);
    expect(r.shape).toBe('no-content-blocks');
    expect(r.blockKinds).toEqual([]);
    expect(formatEmptyOutputReason(r)).toBe('no-content-blocks');
  });

  it('returns no-content-blocks for undefined', () => {
    const r = describeObserverOutputShape(undefined);
    expect(r.shape).toBe('no-content-blocks');
    expect(formatEmptyOutputReason(r)).toBe('no-content-blocks');
  });

  it('returns unrecognized-content for a plain object', () => {
    const r = describeObserverOutputShape({});
    expect(r.shape).toBe('unrecognized-content');
    expect(r.blockKinds).toEqual([]);
    expect(formatEmptyOutputReason(r)).toBe('unrecognized-content');
  });

  it('returns unrecognized-content for a number', () => {
    const r = describeObserverOutputShape(42);
    expect(r.shape).toBe('unrecognized-content');
  });

  it('returns no-content-blocks for an empty array', () => {
    const r = describeObserverOutputShape([]);
    expect(r.shape).toBe('no-content-blocks');
    expect(r.blockKinds).toEqual([]);
  });

  it('returns text for a non-blank string', () => {
    const r = describeObserverOutputShape('<observation/>');
    expect(r.shape).toBe('text');
    expect(r.blockKinds).toEqual([]);
    expect(formatEmptyOutputReason(r)).toBeUndefined();
  });

  it('returns blank-text for whitespace string', () => {
    const r = describeObserverOutputShape('   ');
    expect(r.shape).toBe('blank-text');
    expect(formatEmptyOutputReason(r)).toBe('blank-text');
  });

  it('returns text for array with non-blank text block', () => {
    const r = describeObserverOutputShape([{ type: 'text', text: 'hello' }]);
    expect(r.shape).toBe('text');
    expect(r.blockKinds).toEqual(['text']);
    expect(formatEmptyOutputReason(r)).toBeUndefined();
  });

  it('returns blank-text for array with blank text block', () => {
    const r = describeObserverOutputShape([{ type: 'text', text: '' }]);
    expect(r.shape).toBe('blank-text');
    expect(r.blockKinds).toEqual(['text']);
    expect(formatEmptyOutputReason(r)).toBe('blank-text');
  });

  it('returns non-text-blocks-only(tool_use) for tool_use block', () => {
    const r = describeObserverOutputShape([{ type: 'tool_use', name: 'bash', input: {} }]);
    expect(r.shape).toBe('non-text-blocks-only');
    expect(r.blockKinds).toEqual(['tool_use']);
    expect(formatEmptyOutputReason(r)).toBe('non-text-blocks-only(tool_use)');
  });

  it('returns non-text-blocks-only(thinking,tool_use) for mixed non-text blocks', () => {
    const r = describeObserverOutputShape([
      { type: 'thinking', thinking: 'thought' },
      { type: 'tool_use', name: 'bash', input: {} },
    ]);
    expect(r.shape).toBe('non-text-blocks-only');
    expect(r.blockKinds).toEqual(['thinking', 'tool_use']);
    expect(formatEmptyOutputReason(r)).toBe('non-text-blocks-only(thinking,tool_use)');
  });

  it('whitelist boundary: unknown type becomes "other" and output contains no input substring', () => {
    const malicious = 'wat-<script>alert(1)</script>';
    const r = describeObserverOutputShape([{ type: malicious }]);
    expect(r.shape).toBe('non-text-blocks-only');
    expect(r.blockKinds).toEqual(['other']);
    const reason = formatEmptyOutputReason(r);
    expect(reason).toBe('non-text-blocks-only(other)');
    expect(reason).not.toContain(malicious);
  });

  it('totality: nested array [[]]] does not throw', () => {
    expect(() => describeObserverOutputShape([[]])).not.toThrow();
  });

  it('totality: array with null element does not throw', () => {
    expect(() => describeObserverOutputShape([null])).not.toThrow();
    const r = describeObserverOutputShape([null]);
    expect(r.blockKinds).toContain('other');
  });

  it('totality: array with plain object (no type) does not throw', () => {
    expect(() => describeObserverOutputShape([{}])).not.toThrow();
    const r = describeObserverOutputShape([{}]);
    expect(r.blockKinds).toContain('other');
  });

  it('totality: block with throwing type getter does not throw', () => {
    const evil = Object.defineProperty({}, 'type', {
      get() { throw new Error('boom'); },
    });
    expect(() => describeObserverOutputShape([evil])).not.toThrow();
    const r = describeObserverOutputShape([evil]);
    expect(r.blockKinds).toContain('other');
  });

  it('totality: block with throwing text getter does not throw (Preservation Invariant 2)', () => {
    const block = Object.defineProperties({}, {
      type: { get() { return 'text'; }, enumerable: true },
      text: { get() { throw new Error('boom'); }, enumerable: true },
    });
    expect(() => describeObserverOutputShape([block])).not.toThrow();
    const r = describeObserverOutputShape([block]);
    expect(r.blockKinds).toContain('text');
    expect(r.shape).toBe('blank-text');
  });
});
