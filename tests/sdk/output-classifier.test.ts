import { describe, it, expect } from 'bun:test';
import {
  classifyObserverOutput,
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

  it('classifies arbitrary conversational prose as prose', () => {
    expect(classifyObserverOutput('Hmm, I think this one is a bit ambiguous, let me consider it.')).toBe('prose');
  });

  it('classifies plain-prose no-op acknowledgements as skip', () => {
    expect(classifyObserverOutput('No observations to record.')).toBe('skip');
    expect(classifyObserverOutput('Nothing to record for this batch.')).toBe('skip');
    expect(classifyObserverOutput('No summary needed.')).toBe('skip');
  });

  it('classifies haiku-style no-op acknowledgements as skip', () => {
    expect(classifyObserverOutput('(no observations - insufficient data in this observation window)')).toBe('skip');
    expect(classifyObserverOutput('(No tool executions observed yet in the primary session.)')).toBe('skip');
    expect(classifyObserverOutput('(Empty - no tool execution data observed yet)')).toBe('skip');
  });

  it('classifies skip prose from repeated scans as skip', () => {
    expect(classifyObserverOutput('Skipping — repeated log scan with no new findings.')).toBe('skip');
    expect(classifyObserverOutput('No substantive tool executions.')).toBe('skip');
  });

  it('keeps XML precedence over skip-prose markers in narrative text', () => {
    const xml =
      '<observation><type>discovery</type><narrative>The agent reported no observations from this scan.</narrative></observation>';
    expect(classifyObserverOutput(xml)).toBe('xml');
  });

  it('rejects long or substantive no-observations prose as prose', () => {
    expect(classifyObserverOutput(`No observations ${'x'.repeat(200)}`)).toBe('prose');
    expect(classifyObserverOutput('No observations, but I found a stale cache bug.')).toBe('prose');
    expect(classifyObserverOutput('No observations to record, however I identified an error.')).toBe('prose');
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
