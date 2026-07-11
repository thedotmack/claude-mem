import { describe, it, expect } from 'bun:test';
import {
  classifyObserverOutput,
  isQuotaLimitedObserverOutput,
  isAuthFailureObserverOutput,
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
  it('detects "Not logged in · Please run /login" prose', () => {
    expect(isAuthFailureObserverOutput('Not logged in · Please run /login')).toBe(true);
  });

  it('detects a 401 invalid-credentials API error', () => {
    expect(
      isAuthFailureObserverOutput('API Error: 401 Invalid authentication credentials'),
    ).toBe(true);
  });

  it('detects "Unauthenticated request" prose', () => {
    expect(isAuthFailureObserverOutput('Unauthenticated request')).toBe(true);
  });

  it('returns false for empty / non-string input (fail-safe)', () => {
    expect(isAuthFailureObserverOutput('')).toBe(false);
    expect(isAuthFailureObserverOutput('   ')).toBe(false);
    expect(isAuthFailureObserverOutput(undefined)).toBe(false);
    expect(isAuthFailureObserverOutput(null)).toBe(false);
  });

  it('does not treat ordinary observer prose as auth failure', () => {
    expect(isAuthFailureObserverOutput('I observe no tool executions to record.')).toBe(false);
  });

  it('does not treat valid observation XML as auth failure', () => {
    expect(
      isAuthFailureObserverOutput('<observation><type>discovery</type><title>x</title></observation>'),
    ).toBe(false);
  });

  it('does not trip on the number 401 in a non-auth sentence', () => {
    expect(isAuthFailureObserverOutput('We processed 401 records without error.')).toBe(false);
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
