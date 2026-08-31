import { describe, it, expect } from 'bun:test';
import {
  classifyObserverOutput,
  isAuthFailureObserverOutput,
  isContextOverflowObserverOutput,
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

describe('isContextOverflowObserverOutput (#3800)', () => {
  it('recognises the exact wording reported in the field', () => {
    // The reporter logged this verbatim, 2,264 times in one day.
    expect(isContextOverflowObserverOutput('Prompt is too long')).toBe(true);
  });

  it('recognises other provider phrasings of a context-window overflow', () => {
    expect(isContextOverflowObserverOutput('Input is too long')).toBe(true);
    expect(isContextOverflowObserverOutput('The conversation is too long.')).toBe(true);
    expect(isContextOverflowObserverOutput(
      "This model's maximum context length is 200000 tokens."
    )).toBe(true);
    expect(isContextOverflowObserverOutput('context window exceeded')).toBe(true);
    expect(isContextOverflowObserverOutput(
      'Your messages exceed the context window for this model.'
    )).toBe(true);
    expect(isContextOverflowObserverOutput(
      'Please reduce the length of the messages and try again.'
    )).toBe(true);
  });

  it('does not classify XML output as overflow, even when it discusses long prompts', () => {
    expect(isContextOverflowObserverOutput(
      '<observation><title>Prompt is too long</title></observation>'
    )).toBe(false);
    expect(isContextOverflowObserverOutput('<skip_summary/>')).toBe(false);
  });

  it('does not classify empty, unrelated, quota, or auth prose as overflow', () => {
    expect(isContextOverflowObserverOutput('')).toBe(false);
    expect(isContextOverflowObserverOutput('   ')).toBe(false);
    expect(isContextOverflowObserverOutput(42)).toBe(false);
    expect(isContextOverflowObserverOutput('No observations to record.')).toBe(false);
    expect(isContextOverflowObserverOutput('The file is too long to read in one go.')).toBe(false);
    expect(isContextOverflowObserverOutput(
      'You have reached your Claude usage limit. Try again later.'
    )).toBe(false);
    expect(isContextOverflowObserverOutput('Authentication failed; run /login.')).toBe(false);
  });

  it('is disjoint from the quota and auth classifiers on real overflow text', () => {
    const overflow = 'Prompt is too long';
    expect(isContextOverflowObserverOutput(overflow)).toBe(true);
    expect(isQuotaLimitedObserverOutput(overflow)).toBe(false);
    expect(isAuthFailureObserverOutput(overflow)).toBe(false);
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
