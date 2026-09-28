import { describe, expect, it } from 'bun:test';
import { ALLOWED_PROPERTY_KEYS, scrubProperties } from '../../src/services/telemetry/scrub';

describe('installer telemetry keys survive the scrubber', () => {
  it('allowlists phase and provider_source and drops everything else', () => {
    expect(ALLOWED_PROPERTY_KEYS.has('phase')).toBe(true);
    expect(ALLOWED_PROPERTY_KEYS.has('provider_source')).toBe(true);
    expect(scrubProperties({
      phase: 'login',
      provider_source: 'default',
      secret: 'x',
      authorization_url: 'https://cmem.ai/login',
      user_code: 'ABCD-2345',
    })).toEqual({ phase: 'login', provider_source: 'default' });
  });
});

describe('install_step keys', () => {
  it('passes the closed install_step values', () => {
    const props = {
      step_id: 'bun.ensure',
      outcome: 'error',
      duration_ms: 1234,
      error_category: 'bun-missing-after-install',
      fix_id: 'fix.bun.npm-package',
      fix_outcome: 'ok',
      attempt_n: 2,
      agent_context: 'claude-code',
      signin_arm: 'C',
      browser_open: 'skipped-no-desktop',
      bun_fail_reason: 'unzip-missing',
    };
    expect(scrubProperties(props)).toEqual(props);
    expect(scrubProperties({ step_id: 'ide.cursor' })).toEqual({ step_id: 'ide.cursor' });
  });

  it('drops free text riding on an enum key', () => {
    expect(scrubProperties({
      step_id: 'bun.ensure; rm -rf /',
      agent_context: 'my-laptop',
      signin_arm: 'D',
      browser_open: 'opened https://cmem.ai/login?next=x',
      bun_fail_reason: 'curl: (6) Could not resolve host: bun.sh',
      fix_id: '/home/someone/fix.sh',
      fix_outcome: 'maybe',
      stderr: 'error: unzip is required',
    })).toEqual({});
  });
});
