import { describe, it, expect } from 'bun:test';
import {
  classifyObserverOutput,
  isAuthFailureObserverOutput,
  isQuotaLimitedObserverOutput,
  previewOutput,
} from '../../src/sdk/output-classifier.js';

describe('classifyObserverOutput (observer batch-safety contract)', () => {
  it('classifies valid <observation> XML as valid', () => {
    const xml = `<observation>
      <type>discovery</type>
      <title>A real finding</title>
    </observation>`;
    expect(classifyObserverOutput(xml)).toBe('valid');
  });

  it('classifies <summary> XML as valid', () => {
    expect(classifyObserverOutput('<summary><request>do x</request></summary>')).toBe('valid');
  });

  it('classifies both explicit skip sentinels as skip', () => {
    expect(classifyObserverOutput('<skip_summary reason="nothing to do"/>')).toBe('skip');
    expect(classifyObserverOutput('<skip_observation reason="nothing durable"/>')).toBe('skip');
  });

  it('does not accept a skip sentinel embedded in prose', () => {
    expect(classifyObserverOutput('Skipping because <skip_observation/>')).toBe('xml_drift');
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

  it('classifies recoverable failure text into closed failure classes', () => {
    expect(classifyObserverOutput('Connection closed mid-response.')).toBe('transport');
    expect(classifyObserverOutput('Error: prompt is too long for this model.')).toBe('overflow');
    expect(classifyObserverOutput('I hit the context window, so there is no XML.')).toBe('overflow');
    expect(classifyObserverOutput("There's an issue with the selected model.")).toBe('model_error');
  });

  it('includes auth and quota in the same closed classification', () => {
    expect(classifyObserverOutput('Failed to authenticate. API Error: 401')).toBe('auth');
    expect(classifyObserverOutput('Claude usage limit reached. Your weekly limit will reset soon.')).toBe('quota');
  });

  it('distinguishes schema drift from valid XML', () => {
    expect(classifyObserverOutput(
      '<observation><kind>discovery</kind><detail>wrong schema</detail></observation>',
    )).toBe('xml_drift');
  });

  it('does not let error-looking memory content override valid XML', () => {
    expect(classifyObserverOutput(
      '<observation><type>discovery</type><title>Prompt is too long error</title></observation>',
    )).toBe('valid');
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
