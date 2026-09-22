import { describe, it, expect } from 'bun:test';
import { redactSecrets, redactSecretsDeep } from '../../src/utils/redact-secrets.js';

// Every credential-shaped fixture below is built via string concatenation on
// purpose: a contiguous literal in this exact shape trips GitHub's secret
// scanner even though it is fake, so no full token ever appears as one token
// in the source.

describe('redactSecrets', () => {
  it('redacts a PEM private key block', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\n' + 'MIIBOwIBAAJBAKj34GkxFhD91' + '\n-----END RSA PRIVATE KEY-----';
    const out = redactSecrets(`key: ${pem}`);
    expect(out).toContain('[REDACTED:private_key]');
    expect(out).not.toContain('MIIBOwIBAAJBAKj34GkxFhD91');
  });

  it('redacts an AWS access key id', () => {
    const keyId = 'AKIA' + 'IOSFODNN7EXAMPLE';
    const out = redactSecrets(`id is ${keyId} done`);
    expect(out).toBe('id is [REDACTED:aws_access_key_id] done');
  });

  it('redacts aws_secret_access_key via the generic assignment rule', () => {
    const secret = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCY' + 'EXAMPLEKEY';
    const out = redactSecrets(`aws_secret_access_key=${secret}`);
    expect(out).toContain('aws_secret_access_key=[REDACTED:field:aws_secret_access_key]');
  });

  it('redacts GitHub tokens (ghp_/gho_/ghu_/ghs_/ghr_)', () => {
    const suffix = '1234567890123456789012345678901234AB';
    expect(redactSecrets(`token ghp_${suffix}`)).toContain('[REDACTED:github_token]');
    expect(redactSecrets(`token gho_${suffix}`)).toContain('[REDACTED:github_token]');
  });

  it('redacts a github_pat_ token', () => {
    const token = 'github_pat_' + '11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
    const out = redactSecrets(token);
    expect(out).toContain('[REDACTED:github_token]');
  });

  it('redacts an Anthropic key', () => {
    const key = 'sk-ant-api03-' + 'abcdefghijklmnopqrstuvwxyz0123456789';
    const out = redactSecrets(`ANTHROPIC_API_KEY=${key}`);
    expect(out).toContain('[REDACTED:anthropic_key]');
  });

  it('redacts an OpenAI key (legacy and sk-proj-)', () => {
    const suffix = 'abcdefghijklmnopqrstuvwx1234567890';
    expect(redactSecrets('sk-' + suffix)).toContain('[REDACTED:openai_key]');
    expect(redactSecrets('sk-proj-' + suffix)).toContain('[REDACTED:openai_key]');
  });

  it('redacts a Google API key', () => {
    const key = 'AIzaSyD-' + '1234567890abcdefghijklmnopqrstuv';
    const out = redactSecrets(key);
    expect(out).toContain('[REDACTED:google_api_key]');
  });

  it('redacts a Slack token', () => {
    const token = 'xoxb-' + '1234567890-1234567890123-abcdefghijklmnopqrstuvwx';
    const out = redactSecrets(token);
    expect(out).toContain('[REDACTED:slack_token]');
  });

  it('redacts a Stripe live key', () => {
    const skLive = 'sk_live_' + '1'.repeat(24);
    const rkLive = 'rk_live_' + '1'.repeat(24);
    expect(redactSecrets(skLive)).toContain('[REDACTED:stripe_key]');
    expect(redactSecrets(rkLive)).toContain('[REDACTED:stripe_key]');
  });

  it('redacts a JWT', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9' + '.' + 'eyJzdWIiOiIxMjM0NTY3ODkwIn0' + '.' + 'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    expect(redactSecrets(jwt)).toBe('[REDACTED:jwt]');
  });

  it('redacts an Authorization: Bearer header, keeping the scheme', () => {
    const out = redactSecrets('Authorization: Bearer abcdef123456');
    expect(out).toBe('Authorization: Bearer [REDACTED:auth_header]');
  });

  it('redacts URL-embedded credentials but keeps scheme/host', () => {
    const out = redactSecrets('connect to postgres://user:hunter2@db.internal:5432/app');
    expect(out).toBe('connect to postgres://[REDACTED:url_credentials]@db.internal:5432/app');
  });

  it('redacts a generic PASSWORD= assignment', () => {
    expect(redactSecrets('PASSWORD=hunter2secret')).toContain('PASSWORD=[REDACTED:field:password]');
  });

  it('redacts a quoted JSON-style "password" field', () => {
    const out = redactSecrets('{"password": "hunter2"}');
    expect(out).toContain('"password": "[REDACTED:field:password]"');
  });

  it('redacts a YAML-style token: value', () => {
    const out = redactSecrets('token: abcdef123456');
    expect(out).toContain('token: [REDACTED:field:token]');
  });

  it('redacts a --password CLI flag', () => {
    const out = redactSecrets('mysql --password supersecret123 -u root');
    expect(out).toContain('--password [REDACTED:field:password]');
  });

  it('redacts an XML credential element', () => {
    const out = redactSecrets('<soap:Body><Password>hunter2secret</Password></soap:Body>');
    expect(out).toContain('<Password>[REDACTED:field:password]</Password>');
  });

  it('redacts an <apiKey> XML element', () => {
    const out = redactSecrets('<apiKey>abcdef123456</apiKey>');
    expect(out).toContain('[REDACTED:field:apikey]');
  });

  // --- Negative cases: ordinary code must survive untouched ---

  it('leaves a TypeScript type annotation alone', () => {
    const src = 'function login(password: string, token: number) {}';
    expect(redactSecrets(src)).toBe(src);
  });

  it('leaves a property access / call alone', () => {
    const src = 'if (token.length > 0) { return getToken(); }';
    expect(redactSecrets(src)).toBe(src);
  });

  it('leaves ordinary prose mentioning "password" or "token" alone', () => {
    const src = 'Remind the user to reset their password after the token expires.';
    expect(redactSecrets(src)).toBe(src);
  });

  it('leaves an interface field declaration alone', () => {
    const src = 'interface Auth { secret: string; }';
    expect(redactSecrets(src)).toBe(src);
  });
});

describe('redactSecretsDeep', () => {
  it('redacts a string value whose key matches, recursively', () => {
    const input = { auth: { headers: { Authorization: 'ignored-by-key' }, password: 'hunter2' } };
    const out = redactSecretsDeep(input) as any;
    expect(out.auth.password).toBe('[REDACTED:field:password]');
  });

  it('applies pattern redaction to string leaves whose key does not match', () => {
    const input = { command: 'curl -H "Authorization: Bearer abcdef123456" https://api.example.com' };
    const out = redactSecretsDeep(input) as any;
    expect(out.command).toContain('[REDACTED:auth_header]');
  });

  it('recurses through arrays', () => {
    const input = { items: [{ token: 'abc123456' }, { file_path: '/tmp/a.ts' }] };
    const out = redactSecretsDeep(input) as any;
    expect(out.items[0].token).toBe('[REDACTED:field:token]');
    expect(out.items[1].file_path).toBe('/tmp/a.ts');
  });

  it('leaves non-sensitive keys and non-string values untouched', () => {
    const input = { file_path: '/tmp/a.ts', line: 42, ok: true };
    expect(redactSecretsDeep(input)).toEqual(input);
  });
});
