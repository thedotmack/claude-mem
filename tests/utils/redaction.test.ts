import { describe, it, expect } from 'bun:test';
import { redactSensitive, redactJsonStrings, loadRedactionConfig, hasRedactionMarker, OVERSIZE_MARKER } from '../../src/utils/redaction.js';

describe('redactSensitive', () => {
  it('returns input unchanged when config.enabled is false', () => {
    const input = 'plain text AKIAIOSFODNN7EXAMPLE more text';
    const result = redactSensitive(input, { enabled: false });
    expect(result.redacted).toBe(input);
    expect(result.counts).toEqual({});
    expect(result.oversize).toBe(false);
  });

  it('returns empty string and empty counts for empty input', () => {
    const result = redactSensitive('', { enabled: true });
    expect(result.redacted).toBe('');
    expect(result.counts).toEqual({});
    expect(result.oversize).toBe(false);
  });
});

describe('redactSensitive built-in patterns', () => {
  const cfg = { enabled: true };

  it.each([
    ['aws_access_key',  'export X=AKIAIOSFODNN7EXAMPLE done',                                          "<redacted type='aws_access_key'/>"],
    ['aws_access_key',  'export AWS_ACCESS_KEY_ID=ASIAIOSFODNN7EXAMPLE done',                          "<redacted type='aws_access_key'/>"],
    ['github_pat',      'token: ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789 trailing',                  "<redacted type='github_pat'/>"],
    ['github_pat',      'oauth: gho_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789 tail',                      "<redacted type='github_pat'/>"],
    ['github_pat',      'refresh: ghr_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789 tail',                    "<redacted type='github_pat'/>"],
    ['github_pat',      'app user: ghu_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789 tail',                   "<redacted type='github_pat'/>"],
    ['openai_key',      'Authorization: Bearer sk-ABCDEFGHIJ1234567890abcdef',                        "<redacted type='openai_key'/>"],
    ['anthropic_key',   'key=sk-ant-api03-abcdef1234567890ABCDEF',                                    "<redacted type='anthropic_key'/>"],
    // Split string literals here and below so GitHub's secret-push-protection
    // scanner doesn't flag these fake test fixtures as real secrets.
    ['slack_token',     'Slack: ' + 'xox' + 'b-1234567890-0987654321-abcdefghijklmnop',             "<redacted type='slack_token'/>"],
    ['jwt',             'auth: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.AbCdEf0123456789',               "<redacted type='jwt'/>"],
    ['stripe_key',      'Stripe ' + 'sk' + '_live_abcdefghijklmnopqrstuvwx',                         "<redacted type='stripe_key'/>"],
    ['google_api_key',  'key=AIzaSyA-0123456789abcdefghijklmnopqrstu',                                "<redacted type='google_api_key'/>"],
  ])('redacts %s', (name, input, marker) => {
    const result = redactSensitive(input, cfg);
    expect(result.redacted).toContain(marker);
    expect(Object.keys(result.counts)).toEqual([name]);
  });

  // A closing `\b` after a trailing `-` needs a word character to follow, so
  // these keys were missed entirely (Google) or kept their final `-`.
  it.each([
    ['google_api_key', 'key=AIzaSyA-0123456789abcdefghijklmnopqrst- tail', "<redacted type='google_api_key'/>"],
    ['google_api_key', '"AIzaSyA-0123456789abcdefghijklmnopqrst-"', "<redacted type='google_api_key'/>"],
    ['openai_key', 'key=sk-ABCDEFGHIJ1234567890abcdef- tail', "<redacted type='openai_key'/>"],
    ['anthropic_key', 'key=sk-ant-api03-abcdef1234567890ABCDEF- tail', "<redacted type='anthropic_key'/>"],
    ['slack_token', 'Slack: ' + 'xox' + 'b-1234567890-0987654321-abcdefghijklmnop- tail', "<redacted type='slack_token'/>"],
    ['jwt', 'auth: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.AbCdEf0123456789- tail', "<redacted type='jwt'/>"],
  ])('redacts a %s whose last character is a dash', (name, input, marker) => {
    const result = redactSensitive(input, cfg);
    expect(result.redacted).toContain(marker);
    expect(result.redacted).not.toContain('-' + ' tail');
    expect(result.redacted).not.toMatch(/'\/>-/);
    expect(Object.keys(result.counts)).toEqual([name]);
  });

  it('still requires a Google key to end after its 35 characters', () => {
    const result = redactSensitive('AIzaSyA-0123456789abcdefghijklmnopqrstuv', cfg);
    expect(result.counts.google_api_key).toBeUndefined();
  });

  it('redacts a full PEM private key block', () => {
    const input = `text before
-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEAxxxx
yyyy
-----END RSA PRIVATE KEY-----
text after`;
    const result = redactSensitive(input, cfg);
    expect(result.redacted).toContain("<redacted type='private_key_pem'/>");
    expect(result.redacted).toContain('text before');
    expect(result.redacted).toContain('text after');
    expect(result.counts.private_key_pem).toBe(1);
  });

  it('redacts a PGP private key block and an encrypted PKCS#8 key', () => {
    const pgp = '-----BEGIN PGP PRIVATE KEY BLOCK-----\n\nlQOYBF8wP0sBCADH\n=abcd\n-----END PGP PRIVATE KEY BLOCK-----';
    const pkcs8 = '-----BEGIN ENCRYPTED PRIVATE KEY-----\nMIIFHDBOBgkqhkiG\n-----END ENCRYPTED PRIVATE KEY-----';
    for (const block of [pgp, pkcs8]) {
      const result = redactSensitive(`text before\n${block}\ntext after`, cfg);
      expect(result.redacted).toBe("text before\n<redacted type='private_key_pem'/>\ntext after");
      expect(result.counts.private_key_pem).toBe(1);
    }
  });

  it('redacts aws_secret_key only when anchored to AWS_SECRET_ACCESS_KEY', () => {
    const anchored = 'AWS_SECRET_ACCESS_KEY=abcdefghijklmnopqrstuvwxyz0123456789ABCD';
    const r1 = redactSensitive(anchored, cfg);
    expect(r1.counts.aws_secret_key).toBe(1);

    const standalone = 'random base64 abcdefghijklmnopqrstuvwxyz0123456789ABCD here';
    const r2 = redactSensitive(standalone, cfg);
    expect(r2.counts.aws_secret_key).toBeUndefined();
  });

  it('redacts aws_secret_key under the lowercase key of the AWS credentials file', () => {
    const credentials = '[default]\naws_access_key_id = AKIAIOSFODNN7EXAMPLE\naws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\n';
    const result = redactSensitive(credentials, cfg);
    expect(result.redacted).toBe("[default]\naws_access_key_id = <redacted type='aws_access_key'/>\naws_secret_access_key = <redacted type='aws_secret_key'/>\n");

    const sdkArgument = "boto3.client('s3', aws_secret_access_key='wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY')";
    expect(redactSensitive(sdkArgument, cfg).counts.aws_secret_key).toBe(1);
  });

  it('redacts the SecretAccessKey of aws sts JSON output', () => {
    const marker = "<redacted type='aws_secret_key'/>";
    const stsJson = '{"Credentials": {"AccessKeyId": "ASIAIOSFODNN7EXAMPLE", "SecretAccessKey": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "Expiration": "2026-10-26T00:00:00Z"}}';
    const result = redactSensitive(stsJson, cfg);
    expect(result.redacted).toBe(`{"Credentials": {"AccessKeyId": "<redacted type='aws_access_key'/>", "SecretAccessKey": "${marker}", "Expiration": "2026-10-26T00:00:00Z"}}`);
    expect(result.counts.aws_secret_key).toBe(1);

    // JSON-escaped, as the worker scans JSON.stringify(toolInput), and the
    // env-style key written as a JSON property.
    expect(redactSensitive(JSON.stringify(stsJson), cfg).counts.aws_secret_key).toBe(1);
    expect(redactSensitive('{"AWS_SECRET_ACCESS_KEY": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"}', cfg).redacted)
      .toBe(`{"AWS_SECRET_ACCESS_KEY": "${marker}"}`);
  });

  it('redacts a SecretAccessKey value stored apart from its key', () => {
    const secret = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
    const marker = "<redacted type='aws_secret_key'/>";
    expect(redactJsonStrings({ Credentials: { SecretAccessKey: secret } }, cfg)).toEqual({ Credentials: { SecretAccessKey: marker } });
    expect(redactJsonStrings({ env: { AWS_SECRET_ACCESS_KEY: secret } }, cfg)).toEqual({ env: { AWS_SECRET_ACCESS_KEY: marker } });
    expect(redactJsonStrings({ SecretAccessKey: 'changeme' }, cfg)).toEqual({ SecretAccessKey: 'changeme' });
    const disabled = { enabled: true, disabledBuiltinPatterns: ['aws_secret_key'] };
    expect(redactJsonStrings({ SecretAccessKey: secret }, disabled)).toEqual({ SecretAccessKey: secret });
  });

  it('redacts the AWS session token of temporary credentials', () => {
    const token = 'IQoJb3JpZ2luX2VjEJr//////////wEaCXVzLWVhc3QtMSJHMEUCIQDexample+sessiontokenvalue0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij==';
    const marker = "<redacted type='aws_session_token'/>";

    const env = `export AWS_SESSION_TOKEN=${token}\n`;
    expect(redactSensitive(env, cfg).redacted).toBe(`export AWS_SESSION_TOKEN=${marker}\n`);

    const credentials = `[default]\naws_session_token = ${token}\n`;
    expect(redactSensitive(credentials, cfg).redacted).toBe(`[default]\naws_session_token = ${marker}\n`);

    const stsJson = `{"Credentials": {"SessionToken": "${token}", "Expiration": "2026-10-26T00:00:00Z"}}`;
    const result = redactSensitive(stsJson, cfg);
    expect(result.redacted).toBe(`{"Credentials": {"SessionToken": "${marker}", "Expiration": "2026-10-26T00:00:00Z"}}`);
    expect(result.counts.aws_session_token).toBe(1);

    // JSON-escaped, as the worker scans JSON.stringify(toolInput).
    expect(redactSensitive(JSON.stringify(stsJson), cfg).counts.aws_session_token).toBe(1);

    // Short placeholders and unanchored base64 stay as written.
    expect(redactSensitive('AWS_SESSION_TOKEN=changeme', cfg).counts.aws_session_token).toBeUndefined();
    expect(redactSensitive(`random ${token} here`, cfg).counts.aws_session_token).toBeUndefined();
  });

  describe('AWS session token in structured payloads (generic patterns off)', () => {
    const token = 'IQoJb3JpZ2luX2VjEJr//////////wEaCXVzLWVhc3QtMSJHMEUCIQDexample+sessiontokenvalue0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij==';
    const marker = "<redacted type='aws_session_token'/>";

    it('redacts a nested SessionToken value stored apart from its key', () => {
      const event = { Credentials: { AccessKeyId: 'not-a-key', SessionToken: token, Expiration: '2026-10-26T00:00:00Z' } };
      expect(redactJsonStrings(event, cfg)).toEqual({
        Credentials: { AccessKeyId: 'not-a-key', SessionToken: marker, Expiration: '2026-10-26T00:00:00Z' },
      });
    });

    it('redacts aws_session_token and AWS_SESSION_TOKEN keys', () => {
      expect(redactJsonStrings({ profile: { aws_session_token: token } }, cfg)).toEqual({ profile: { aws_session_token: marker } });
      expect(redactJsonStrings({ env: { AWS_SESSION_TOKEN: token } }, cfg)).toEqual({ env: { AWS_SESSION_TOKEN: marker } });
    });

    it('keeps a short value under the same key as written', () => {
      expect(redactJsonStrings({ SessionToken: 'changeme' }, cfg)).toEqual({ SessionToken: 'changeme' });
    });

    it('keeps the value as written when aws_session_token is a disabled built-in', () => {
      const disabled = { enabled: true, disabledBuiltinPatterns: ['aws_session_token'] };
      expect(redactJsonStrings({ SessionToken: token }, disabled)).toEqual({ SessionToken: token });
    });
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

// Issue #4745: the vendor-shaped built-ins missed generic credentials such as
// `password=…`, `*_TOKEN=…` / `*_SECRET=…` / `*_API_KEY=…` and
// `Authorization: Bearer …`. The generic built-ins run AFTER every vendor
// pattern, so a vendor-shaped value keeps its specific marker (pinned by the
// `Authorization: Bearer sk-…` case above).
describe('redactSensitive generic built-in patterns', () => {
  const cfg = { enabled: true, genericEnabled: true };

  it.each([
    ['shell assignment',      'login password=Hunter22Example done',        'Hunter22Example'],
    ['yaml value',            'db_password: hunter22Example',               'hunter22Example'],
    ['json style',            '{"password": "hunter22Example"}',            'hunter22Example'],
    ['quoted shell value',    "set DB_PASSWD='hunter22Example' here",       'hunter22Example'],
    ['uppercase key',         'DB_PASSWORD=Sup3rSecretValue',               'Sup3rSecretValue'],
  ])('generic_password redacts a %s', (_style, input, secret) => {
    const result = redactSensitive(input, cfg);
    expect(result.counts.generic_password).toBe(1);
    expect(result.redacted).not.toContain(secret);
  });

  it.each([
    ['json style',   '{"client_secret": "GOCSPXabc12345"}',   'GOCSPXabc12345'],
    ['shell export', 'export AUTH_TOKEN=abc12345defghi',      'abc12345defghi'],
    ['yaml value',   'MY_API_KEY: uvwxyz123456',              'uvwxyz123456'],
  ])('generic_token redacts a %s', (_style, input, secret) => {
    const result = redactSensitive(input, cfg);
    expect(result.counts.generic_token).toBe(1);
    expect(result.redacted).not.toContain(secret);
  });

  it.each([
    ['in a curl header', 'curl -H "Authorization: Bearer abc12345defghi" https://x', 'abc12345defghi'],
    ['lowercase header', 'authorization: bearer ABCDEFGH123456',                     'ABCDEFGH123456'],
  ])('bearer_token redacts a %s', (_style, input, secret) => {
    const result = redactSensitive(input, cfg);
    expect(result.counts.bearer_token).toBe(1);
    expect(result.redacted).not.toContain(secret);
  });

  it('does NOT redact numeric, short or non-secret lookalikes', () => {
    const inputs = [
      'password=12345678',        // purely numeric
      'password=abc',             // under the 8-char minimum
      'max_tokens=4096',          // `_TOKENS`, not `*_TOKEN`
      'max_password_length=32',   // the key merely contains "password"
      'Bearer 12345678',          // numeric, and not anchored to Authorization
      'AUTH_TOKEN=short',         // under the minimum
      'PWD=/Users/x/project',     // the working directory, not a password
      'OLDPWD=/tmp/a',
      'declare -x PWD="/home/someone/projects/app"',
    ];
    for (const input of inputs) {
      const result = redactSensitive(input, cfg);
      expect(result.redacted).toBe(input);
      expect(Object.keys(result.counts)).toHaveLength(0);
    }
  });

  it('still redacts a vendor-shaped value with only its specific marker', () => {
    const result = redactSensitive('Authorization: Bearer sk-ABCDEFGHIJ1234567890abcdef', cfg);
    expect(Object.keys(result.counts)).toEqual(['openai_key']);
  });

  it('lets a generic built-in be disabled by name while vendor patterns stay on', () => {
    const result = redactSensitive('password=Hunter22Example AKIAIOSFODNN7EXAMPLE', {
      enabled: true,
      genericEnabled: true,
      disabledBuiltinPatterns: ['generic_password'],
    });
    expect(result.redacted).toContain('Hunter22Example');
    expect(result.counts.generic_password).toBeUndefined();
    expect(result.counts.aws_access_key).toBe(1);
  });

  it('is idempotent on its own markers', () => {
    const r1 = redactSensitive('echo password=Hunter22Example', cfg);
    expect(r1.counts.generic_password).toBe(1);
    const r2 = redactSensitive(r1.redacted, cfg);
    expect(r2.redacted).toBe(r1.redacted);
    expect(r2.counts).toEqual({});
  });

  it('redacts generic credentials flowing through redactJsonStrings', () => {
    const payload = { tool_input: { command: 'echo password=Hunter22Example' } };
    const result = redactJsonStrings(payload, cfg);
    expect(JSON.stringify(result)).not.toContain('Hunter22Example');
  });

  it('redacts DB_PWD-style keys', () => {
    const result = redactSensitive('MYSQL_PWD=Hunter22Example mysql -u root', cfg);
    expect(result.counts.generic_password).toBe(1);
    expect(result.redacted).not.toContain('Hunter22Example');
  });

  // The worker scans stripMemoryTags(JSON.stringify(toolInput)), so quotes
  // inside a command arrive backslash-escaped.
  it.each([
    ['escaped shell quotes', { command: 'echo DB_PASSWORD="Sup3rSecretValue"' }, 'Sup3rSecretValue', 'generic_password'],
    ['escaped JSON body',    { command: `curl -d '{"password":"Hunter22Example"}'` }, 'Hunter22Example', 'generic_password'],
    ['escaped JSON token',   { command: `curl -d '{"client_secret": "GOCSPXabc12345"}'` }, 'GOCSPXabc12345', 'generic_token'],
    ['escaped bearer',       { headers: { Authorization: 'Bearer abc12345defghi' } }, 'abc12345defghi', 'bearer_token'],
  ])('redacts inside a JSON-stringified payload: %s', (_style, payload, secret, name) => {
    const serialized = JSON.stringify(payload);
    const result = redactSensitive(serialized, cfg);
    expect(result.counts[name]).toBe(1);
    expect(result.redacted).not.toContain(secret);
    expect(() => JSON.parse(result.redacted)).not.toThrow();
  });

  it('is off unless genericEnabled is set, while the vendor patterns stay on', () => {
    const input = 'password=Hunter22Example AUTH_TOKEN=abc12345defghi AKIAIOSFODNN7EXAMPLE';
    const result = redactSensitive(input, { enabled: true });
    expect(result.redacted).toContain('Hunter22Example');
    expect(result.redacted).toContain('abc12345defghi');
    expect(Object.keys(result.counts)).toEqual(['aws_access_key']);
    expect(JSON.stringify(redactJsonStrings({ client_secret: 'GOCSPXabc12345' }, { enabled: true })))
      .toContain('GOCSPXabc12345');
  });

  it('redacts a credential-named key whose value sits apart from it (structured events)', () => {
    const event = { client_secret: 'GOCSPXabc12345', nested: [{ db_password: 'Hunter22Example' }], token: 'abc12345defghi' };
    const result = redactJsonStrings(event, cfg) as typeof event;
    expect(result.client_secret).toBe("<redacted type='generic_token'/>");
    expect(result.nested[0].db_password).toBe("<redacted type='generic_password'/>");
    expect(result.token).toBe("<redacted type='generic_token'/>");
  });

  it('leaves non-secret values under credential-named keys alone', () => {
    const event = { max_tokens: 'abcdefghij', password: '12345678', session_token: 'short', api_key: 'sk-ABCDEFGHIJ1234567890abcdef' };
    const result = redactJsonStrings(event, cfg) as typeof event;
    expect(result.max_tokens).toBe('abcdefghij');
    expect(result.password).toBe('12345678');
    expect(result.session_token).toBe('short');
    expect(result.api_key).toBe("<redacted type='openai_key'/>");
    const disabled = redactJsonStrings({ client_secret: 'GOCSPXabc12345' }, { ...cfg, disabledBuiltinPatterns: ['generic_token'] });
    expect(disabled.client_secret).toBe('GOCSPXabc12345');
  });

  it('stays linear on long whitespace runs (no quadratic lookbehind)', () => {
    const padded = `password=${' '.repeat(200_000)}AWS_SECRET_ACCESS_KEY${' '.repeat(200_000)}=x`;
    const started = performance.now();
    redactSensitive(padded, cfg);
    expect(performance.now() - started).toBeLessThan(1000);
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
    expect(result.redacted).toContain("<redacted type='company_token'/>");
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
    expect(result.redacted).toContain("<redacted type='my_aws'/>");
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
    expect(result.redacted).toContain("<redacted type='ok'/>");
    expect(result.redacted).toContain("<redacted type='aws_access_key'/>");
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
    expect(result.redacted).toContain("<redacted type='aws_access_key'/>");
    expect(result.redacted).toContain('foo'); // unredacted because pattern was skipped
  });
});

describe('redactSensitive robustness', () => {
  it('fails closed on an input over the 1M-char cap: the whole field becomes an oversize marker', () => {
    const huge = 'a'.repeat(1024 * 1024 + 1);
    const result = redactSensitive(huge + ' AKIAIOSFODNN7EXAMPLE', { enabled: true });
    expect(result.redacted).toBe(OVERSIZE_MARKER);
    expect(result.redacted).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(result.oversize).toBe(true);
    expect(result.counts).toEqual({ oversize: 1 });
  });

  it('redacts every match, with no cap that would let the tail through', () => {
    const oneKey = 'AKIAIOSFODNN7EXAMPLE ';
    const input = oneKey.repeat(500);
    const result = redactSensitive(input, { enabled: true });
    const placeholderCount = (result.redacted.match(/<redacted type='aws_access_key'\/>/g) ?? []).length;
    expect(placeholderCount).toBe(500);
    expect(result.redacted).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(result.counts.aws_access_key).toBe(500);
  });

  it("redacts claude-mem's own server and Pro keys", () => {
    const serverKey = 'cmem_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v';
    const input = `CLAUDE_MEM_SERVER_API_KEY=${serverKey} pro=cm_pro_abcDEF123456xyz`;
    const result = redactSensitive(input, { enabled: true });
    expect(result.redacted).toBe(
      "CLAUDE_MEM_SERVER_API_KEY=<redacted type='claude_mem_key'/> pro=<redacted type='claude_mem_key'/>",
    );
  });

  it('detects raw and XML-escaped markers so prompts explain them only when present', () => {
    expect(hasRedactionMarker("key <redacted type='jwt'/> here")).toBe(true);
    expect(hasRedactionMarker('key &lt;redacted type=&apos;jwt&apos;/&gt; here')).toBe(true);
    expect(hasRedactionMarker('nothing redacted')).toBe(false);
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

  it('keeps the generic group off by default and on with CLAUDE_MEM_REDACT_GENERIC_ENABLED=true', () => {
    expect(loadRedactionConfig(settingsFrom({ CLAUDE_MEM_REDACT_ENABLED: 'true' })).genericEnabled).toBe(false);
    expect(loadRedactionConfig(settingsFrom({ CLAUDE_MEM_REDACT_GENERIC_ENABLED: 'true' })).genericEnabled).toBe(true);
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
