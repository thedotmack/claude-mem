import { describe, it, expect } from 'bun:test';
import { redactSensitive, loadRedactionConfig } from '../../src/utils/redaction.js';

describe('redactSensitive', () => {
  it('returns input unchanged when config.enabled is false', () => {
    const input = 'plain text AKIAIOSFODNN7EXAMPLE more text';
    const result = redactSensitive(input, { enabled: false });
    expect(result.redacted).toBe(input);
    expect(result.counts).toEqual({});
    expect(result.truncated).toBe(false);
  });

  it('returns empty string and empty counts for empty input', () => {
    const result = redactSensitive('', { enabled: true });
    expect(result.redacted).toBe('');
    expect(result.counts).toEqual({});
    expect(result.truncated).toBe(false);
  });
});

describe('redactSensitive built-in patterns', () => {
  const cfg = { enabled: true };

  it.each([
    ['aws_access_key',  'export X=AKIAIOSFODNN7EXAMPLE done',                                          '<redacted type="aws_access_key"/>'],
    ['github_pat',      'token: ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789 trailing',                  '<redacted type="github_pat"/>'],
    ['openai_key',      'Authorization: Bearer sk-ABCDEFGHIJ1234567890abcdef',                        '<redacted type="openai_key"/>'],
    ['anthropic_key',   'key=sk-ant-api03-abcdef1234567890ABCDEF',                                    '<redacted type="anthropic_key"/>'],
    // Split string literals here and below so GitHub's secret-push-protection
    // scanner doesn't flag these fake test fixtures as real secrets.
    ['slack_token',     'Slack: ' + 'xox' + 'b-1234567890-0987654321-abcdefghijklmnop',             '<redacted type="slack_token"/>'],
    ['jwt',             'auth: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.AbCdEf0123456789',               '<redacted type="jwt"/>'],
    ['stripe_key',      'Stripe ' + 'sk' + '_live_abcdefghijklmnopqrstuvwx',                         '<redacted type="stripe_key"/>'],
    ['google_api_key',  'key=AIzaSyA-0123456789abcdefghijklmnopqrstu',                                '<redacted type="google_api_key"/>'],
  ])('redacts %s', (name, input, marker) => {
    const result = redactSensitive(input, cfg);
    expect(result.redacted).toContain(marker);
    expect(Object.keys(result.counts)).toEqual([name]);
  });

  it('redacts a full PEM private key block', () => {
    const input = `text before
-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEAxxxx
yyyy
-----END RSA PRIVATE KEY-----
text after`;
    const result = redactSensitive(input, cfg);
    expect(result.redacted).toContain('<redacted type="private_key_pem"/>');
    expect(result.redacted).toContain('text before');
    expect(result.redacted).toContain('text after');
    expect(result.counts.private_key_pem).toBe(1);
  });

  it('redacts aws_secret_key only when anchored to AWS_SECRET_ACCESS_KEY', () => {
    const anchored = 'AWS_SECRET_ACCESS_KEY=abcdefghijklmnopqrstuvwxyz0123456789ABCD';
    const r1 = redactSensitive(anchored, cfg);
    expect(r1.counts.aws_secret_key).toBe(1);

    const standalone = 'random base64 abcdefghijklmnopqrstuvwxyz0123456789ABCD here';
    const r2 = redactSensitive(standalone, cfg);
    expect(r2.counts.aws_secret_key).toBeUndefined();
  });

  it('does NOT match near-miss strings', () => {
    const negatives = [
      'sk-short',                                  // openai_key too short
      'AKIA12345',                                 // aws_access_key too short
      'ghp_short',                                 // github_pat too short
      'eyJhbGciOiJIUzI1NiJ9 some text',            // jwt missing 2nd/3rd segment
      '-----BEGIN PUBLIC KEY-----\nfoo\n-----END PUBLIC KEY-----',  // PEM but not PRIVATE
    ];
    for (const input of negatives) {
      const result = redactSensitive(input, cfg);
      expect(Object.keys(result.counts)).toHaveLength(0);
    }
  });
});

describe('redactSensitive custom patterns', () => {
  it('applies a valid custom pattern', () => {
    const result = redactSensitive(
      'reference: INTERNAL-ABCDEFGHIJKLMNOPQRSTUVWXYZ123456 done',
      {
        enabled: true,
        customPatterns: [
          { name: 'company_token', regex: 'INTERNAL-[A-Z0-9]{32}' },
        ],
      },
    );
    expect(result.redacted).toContain('<redacted type="company_token"/>');
    expect(result.counts.company_token).toBe(1);
  });

  it('runs custom patterns BEFORE built-ins (custom wins on overlap)', () => {
    // Custom pattern shadows the AKIA prefix
    const result = redactSensitive(
      'override AKIAIOSFODNN7EXAMPLE end',
      {
        enabled: true,
        customPatterns: [{ name: 'my_aws', regex: 'AKIA[0-9A-Z]{16}' }],
      },
    );
    expect(result.redacted).toContain('<redacted type="my_aws"/>');
    expect(result.counts.my_aws).toBe(1);
    expect(result.counts.aws_access_key).toBeUndefined();
  });

  it('skips a custom pattern with an invalid regex without throwing', () => {
    const result = redactSensitive(
      'AKIAIOSFODNN7EXAMPLE here',
      {
        enabled: true,
        customPatterns: [
          { name: 'broken', regex: '(unclosed[group' },
          { name: 'ok',     regex: 'here' },
        ],
      },
    );
    expect(result.redacted).toContain('<redacted type="ok"/>');
    expect(result.redacted).toContain('<redacted type="aws_access_key"/>');
    expect(result.counts.broken).toBeUndefined();
  });

  it('skips a custom pattern with empty/missing name', () => {
    const result = redactSensitive(
      'AKIAIOSFODNN7EXAMPLE foo',
      {
        enabled: true,
        customPatterns: [{ name: '', regex: 'foo' }],
      },
    );
    expect(result.redacted).toContain('<redacted type="aws_access_key"/>');
    expect(result.redacted).toContain('foo'); // unredacted because pattern was skipped
  });
});

describe('redactSensitive robustness', () => {
  it('short-circuits with truncated=true when input exceeds 1 MB', () => {
    const huge = 'a'.repeat(1024 * 1024 + 1);
    const result = redactSensitive(huge + ' AKIAIOSFODNN7EXAMPLE', { enabled: true });
    expect(result.redacted).toContain('AKIAIOSFODNN7EXAMPLE');
    expect(result.truncated).toBe(true);
    expect(result.counts).toEqual({});
  });

  it('sets truncated=true when total matches exceed 200 (200 redacted, 1 leftover)', () => {
    const oneKey = 'AKIAIOSFODNN7EXAMPLE ';
    const input = oneKey.repeat(201);
    const result = redactSensitive(input, { enabled: true });
    expect(result.truncated).toBe(true);
    const placeholderCount = (result.redacted.match(/<redacted type="aws_access_key"\/>/g) ?? []).length;
    const leftoverCount = (result.redacted.match(/AKIAIOSFODNN7EXAMPLE/g) ?? []).length;
    expect(placeholderCount).toBe(200);
    expect(leftoverCount).toBe(1);
    expect(result.counts.aws_access_key).toBe(200);
  });

  it('is idempotent: running twice produces the same output', () => {
    const input = 'a AKIAIOSFODNN7EXAMPLE b ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789 c';
    const r1 = redactSensitive(input, { enabled: true });
    const r2 = redactSensitive(r1.redacted, { enabled: true });
    expect(r2.redacted).toBe(r1.redacted);
    expect(r2.counts).toEqual({});
  });
});

describe('loadRedactionConfig', () => {
  function settingsFrom(overrides: Record<string, string>): any {
    return {
      CLAUDE_MEM_REDACT_ENABLED: 'false',
      CLAUDE_MEM_REDACT_DISABLED_BUILTINS: '',
      CLAUDE_MEM_REDACT_CUSTOM_PATTERNS: '[]',
      CLAUDE_MEM_REDACT_LOG_MATCHES: 'false',
      ...overrides,
    };
  }

  it('parses enabled and logMatches as booleans', () => {
    const cfg = loadRedactionConfig(settingsFrom({
      CLAUDE_MEM_REDACT_ENABLED: 'true',
      CLAUDE_MEM_REDACT_LOG_MATCHES: 'true',
    }));
    expect(cfg.enabled).toBe(true);
    expect(cfg.logMatches).toBe(true);
  });

  it('splits CSV of disabled built-ins', () => {
    const cfg = loadRedactionConfig(settingsFrom({
      CLAUDE_MEM_REDACT_DISABLED_BUILTINS: 'jwt, slack_token ,  ',
    }));
    expect(cfg.disabledBuiltinPatterns).toEqual(['jwt', 'slack_token']);
  });

  it('parses customPatterns as JSON', () => {
    const cfg = loadRedactionConfig(settingsFrom({
      CLAUDE_MEM_REDACT_CUSTOM_PATTERNS: '[{"name":"foo","regex":"bar"}]',
    }));
    expect(cfg.customPatterns).toEqual([{ name: 'foo', regex: 'bar' }]);
  });

  it('falls back to empty list on malformed customPatterns JSON', () => {
    const cfg = loadRedactionConfig(settingsFrom({
      CLAUDE_MEM_REDACT_CUSTOM_PATTERNS: '{not valid json',
    }));
    expect(cfg.customPatterns).toEqual([]);
  });
});
