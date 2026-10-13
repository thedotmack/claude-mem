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
