import { describe, it, expect } from 'bun:test';
import { classifyObserverOutput, previewOutput } from '../../src/sdk/output-classifier.js';

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

  it('classifies "(no observations - insufficient data...)" as skip (field repro on haiku-4.5)', () => {
    expect(
      classifyObserverOutput('(no observations - insufficient data in this observation window)')
    ).toBe('skip');
  });

  it('classifies "(No tool executions observed yet in the primary session.)" as skip', () => {
    expect(
      classifyObserverOutput('(No tool executions observed yet in the primary session.)')
    ).toBe('skip');
  });

  it('classifies "(Empty - no tool execution data observed yet)" as skip', () => {
    expect(classifyObserverOutput('(Empty - no tool execution data observed yet)')).toBe('skip');
  });

  it('classifies "Skipping — repeated log scan with no new findings." as skip', () => {
    expect(classifyObserverOutput('Skipping — repeated log scan with no new findings.')).toBe('skip');
  });

  it('classifies "No substantive tool executions." as skip', () => {
    expect(classifyObserverOutput('No substantive tool executions.')).toBe('skip');
  });

  it('XML gate takes precedence over skip-prose markers in narrative text', () => {
    const xml =
      '<observation><type>discovery</type><narrative>The agent reported no observations from this scan.</narrative></observation>';
    expect(classifyObserverOutput(xml)).toBe('xml');
  });

  it('classifies "session exhausted" closure string as poisoned', () => {
    expect(classifyObserverOutput('This session has been exhausted, I cannot continue.')).toBe('poisoned');
  });

  it('classifies "prompt is too long" closure as poisoned', () => {
    expect(classifyObserverOutput('Error: prompt is too long for this model.')).toBe('poisoned');
  });

  it('poison detection takes precedence over a stray tag', () => {
    expect(classifyObserverOutput('session exhausted <observation></observation>')).toBe('poisoned');
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
