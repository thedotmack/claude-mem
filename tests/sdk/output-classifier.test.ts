import { describe, it, expect } from 'bun:test';
import {
  classifyObserverOutput,
  isAuthFailureObserverOutput,
  isPromptTooLongObserverOutput,
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

// #3800: the observer stopped producing anything for 94 minutes while every
// batch came back "Prompt is too long". The rejection is per conversation, not
// per batch — it arrived on the 29th prompt of one long-lived SDK session — so
// the batch was dropped, reloaded identically, and sent back into a
// conversation that could only keep growing.
describe('isPromptTooLongObserverOutput', () => {
  it('detects the rejection the SDK actually returned', () => {
    expect(isPromptTooLongObserverOutput('Prompt is too long')).toBe(true);
    expect(isPromptTooLongObserverOutput('  prompt is too long  ')).toBe(true);
  });

  it('detects the same refusal from other providers', () => {
    expect(
      isPromptTooLongObserverOutput(
        "This model's maximum context length is 200000 tokens, however your messages exceed the context window.",
      ),
    ).toBe(true);
    expect(
      isPromptTooLongObserverOutput('The input exceeds the maximum context length for this model.'),
    ).toBe(true);
  });

  it('does not fire on ordinary observer prose', () => {
    // These reach the same branch and must keep being confirmed as no-op
    // batches rather than recycling a healthy conversation.
    expect(isPromptTooLongObserverOutput('')).toBe(false);
    expect(isPromptTooLongObserverOutput('Nothing worth recording in this batch.')).toBe(false);
    expect(isPromptTooLongObserverOutput('The user asked about a long prompt file.')).toBe(false);
    expect(isPromptTooLongObserverOutput('<observation>ok</observation>')).toBe(false);
    expect(isPromptTooLongObserverOutput(null)).toBe(false);
  });
});
