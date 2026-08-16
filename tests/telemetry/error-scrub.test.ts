import { describe, it, expect } from 'bun:test';
import os from 'os';
import {
  redactHomeDir,
  redactAbsolutePaths,
  redactUrlQueryStrings,
  redactSecrets,
  collapseWhitespace,
  redactText,
  scrubMessage,
  scrubStack,
  scrubError,
  extractErrorType,
  messageTemplate,
  REDACTED,
  MESSAGE_MAX_CHARS,
  STACK_MAX_CHARS,
  STACK_MAX_FRAMES,
} from '../../src/services/telemetry/error-scrub';

describe('error-scrub: redactHomeDir', () => {
  it('replaces the home directory with ~', () => {
    const home = os.homedir();
    const input = `Failed to read ${home}/projects/secret/file.ts`;
    const out = redactHomeDir(input);
    expect(out).not.toContain(home);
    expect(out).toContain('~');
  });

  it('is a no-op when home is not present', () => {
    expect(redactHomeDir('plain message')).toBe('plain message');
  });
});

describe('error-scrub: redactAbsolutePaths', () => {
  it('collapses POSIX absolute paths to basename', () => {
    const out = redactAbsolutePaths('cannot open /var/lib/private/data/config.json now');
    expect(out).toContain('config.json');
    expect(out).not.toContain('/var/lib/private');
  });

  it('collapses Windows drive paths to basename', () => {
    const out = redactAbsolutePaths('open C:\\Users\\bob\\secret\\app.log failed');
    expect(out).toContain('app.log');
    expect(out).not.toContain('C:\\Users\\bob');
  });

  it('leaves relative paths and basenames untouched', () => {
    expect(redactAbsolutePaths('error in config.json')).toBe('error in config.json');
  });
});

describe('error-scrub: redactUrlQueryStrings', () => {
  it('strips query strings (keeps host + path)', () => {
    const out = redactUrlQueryStrings('GET https://api.example.com/v1/data?token=secret123&x=1 failed');
    expect(out).toContain('https://api.example.com/v1/data');
    expect(out).not.toContain('token=secret123');
    expect(out).not.toContain('x=1');
  });

  it('strips fragments too', () => {
    const out = redactUrlQueryStrings('see http://host/path#sessionid=abc');
    expect(out).not.toContain('sessionid=abc');
  });

  it('strips http userinfo (username AND password)', () => {
    const out = redactUrlQueryStrings('GET https://alice:s3cr3t@10.0.0.5/path failed');
    expect(out).not.toContain('alice');
    expect(out).not.toContain('s3cr3t');
    expect(out).toContain(REDACTED);
    expect(out).toContain('@10.0.0.5/path');
  });

  it('redacts postgres connection-string credentials + query', () => {
    const out = redactUrlQueryStrings('ECONNREFUSED postgres://u:p@host:5432/db?sslmode=require');
    expect(out).not.toContain('u:p');
    expect(out).not.toContain('sslmode=require');
    expect(out).toContain('@host:5432/db');
  });

  it('redacts redis:// credentials', () => {
    const out = redactUrlQueryStrings('redis://admin:hunter2@cache:6379 down');
    expect(out).not.toContain('admin');
    expect(out).not.toContain('hunter2');
    expect(out).toContain('@cache:6379');
  });

  it('redacts mongodb+srv:// credentials', () => {
    const out = redactUrlQueryStrings('mongodb+srv://user:pass@cluster0.mongodb.net/db retrying');
    expect(out).not.toContain('user:pass');
    expect(out).toContain('@cluster0.mongodb.net/db');
  });

  it('redacts mysql:// credentials', () => {
    const out = redactUrlQueryStrings('mysql://root:toor@db.internal:3306/app failed');
    expect(out).not.toContain('root:toor');
    expect(out).toContain('@db.internal:3306/app');
  });

  it('redacts amqp:// credentials', () => {
    const out = redactUrlQueryStrings('amqp://guest:guest@broker:5672 unreachable');
    expect(out).not.toContain('guest:guest');
    expect(out).toContain('@broker:5672');
  });
});

describe('error-scrub: redactSecrets', () => {
  it('masks email addresses', () => {
    const out = redactSecrets('contact alice@example.com about this');
    expect(out).not.toContain('alice@example.com');
    expect(out).toContain(REDACTED);
  });

  it('masks sk- API keys', () => {
    const out = redactSecrets('auth failed for sk-ABCdef1234567890ghij');
    expect(out).not.toContain('sk-ABCdef1234567890ghij');
    expect(out).toContain(REDACTED);
  });

  it('masks phc_ PostHog keys', () => {
    const out = redactSecrets('key phc_ABCdef1234567890ghijKLMNOP invalid');
    expect(out).not.toContain('phc_ABCdef1234567890ghijKLMNOP');
    expect(out).toContain(REDACTED);
  });

  it('masks generic long tokens, hex blobs and JWTs', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N';
    const hex = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    const out = redactSecrets(`jwt=${jwt} hash=${hex}`);
    expect(out).not.toContain(jwt);
    expect(out).not.toContain(hex);
    expect(out).toContain(REDACTED);
  });

  it('masks AWS access key IDs', () => {
    const out = redactSecrets('creds AKIAIOSFODNN7EXAMPLE rejected');
    expect(out).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(out).toContain(REDACTED);
  });

  it('masks ASIA/AROA-prefixed AWS key IDs too', () => {
    const out = redactSecrets('temp key ASIAY34FZKBOKMUTVV7A here');
    expect(out).not.toContain('ASIAY34FZKBOKMUTVV7A');
    expect(out).toContain(REDACTED);
  });

  it('masks IPv4 addresses', () => {
    const out = redactSecrets('connect failed to 10.0.0.5:5432');
    expect(out).not.toContain('10.0.0.5');
    expect(out).toContain(REDACTED);
  });

  it('does NOT mask 3-part version numbers as IPs', () => {
    const out = redactSecrets('claude-mem 13.6.2 ready');
    expect(out).toContain('13.6.2');
  });

  it('still redacts real emails with the BOUNDED regex', () => {
    const out = redactSecrets('contact user+tag@sub.example.com please');
    expect(out).not.toContain('user+tag@sub.example.com');
    expect(out).toContain(REDACTED);
  });
});

describe('error-scrub: collapseWhitespace', () => {
  it('collapses runs of whitespace and trims', () => {
    expect(collapseWhitespace('  a    b\t\tc  ')).toBe('a b c');
  });
});

describe('error-scrub: scrubMessage caps length', () => {
  it('caps message at MESSAGE_MAX_CHARS', () => {
    const out = scrubMessage('x'.repeat(MESSAGE_MAX_CHARS + 200));
    expect(out.length).toBe(MESSAGE_MAX_CHARS);
  });

  it('applies the full pipeline in order', () => {
    const home = os.homedir();
    const out = scrubMessage(
      `boom at ${home}/p/file.ts calling https://h/x?k=sk-ABCdef1234567890ghij mail bob@h.com`
    );
    expect(out).not.toContain(home);
    expect(out).not.toContain('k=sk-');
    expect(out).not.toContain('bob@h.com');
  });
});

describe('error-scrub: scrubStack', () => {
  it('keeps only the top N frames and caps total length', () => {
    const frames = Array.from({ length: 50 }, (_, i) => `    at fn${i} (/abs/path/file${i}.ts:${i}:1)`);
    const stack = ['Error: boom', ...frames].join('\n');
    const out = scrubStack(stack);
    const lineCount = out.split('\n').length;
    // header + at most STACK_MAX_FRAMES frame lines
    expect(lineCount).toBeLessThanOrEqual(STACK_MAX_FRAMES + 1);
    expect(out.length).toBeLessThanOrEqual(STACK_MAX_CHARS);
    expect(out).not.toContain('/abs/path');
  });

  it('returns empty string for non-string input', () => {
    expect(scrubStack(undefined)).toBe('');
    expect(scrubStack(null)).toBe('');
    expect(scrubStack(123 as unknown as string)).toBe('');
  });
});

describe('error-scrub: extractErrorType', () => {
  it('reads the error name/type', () => {
    expect(extractErrorType(new TypeError('x'))).toBe('TypeError');
    expect(extractErrorType(new Error('x'))).toBe('Error');
  });

  it('classifies non-Error throws', () => {
    expect(extractErrorType('boom')).toBe('StringError');
    expect(extractErrorType(null)).toBe('NullError');
    expect(extractErrorType(undefined)).toBe('UndefinedError');
    expect(extractErrorType(42)).toBe('numberError');
    // A plain object's constructor name ('Object') is preferred over the
    // generic fallback; a null-prototype object falls back to 'ObjectError'.
    expect(extractErrorType({})).toBe('Object');
    expect(extractErrorType(Object.create(null))).toBe('ObjectError');
  });
});

describe('error-scrub: scrubError never throws on hostile input', () => {
  it('handles null / undefined / primitives', () => {
    expect(() => scrubError(null)).not.toThrow();
    expect(() => scrubError(undefined)).not.toThrow();
    expect(() => scrubError(42)).not.toThrow();
    expect(() => scrubError('a string error')).not.toThrow();
    const r = scrubError('a string error');
    expect(r.type).toBe('StringError');
    expect(r.message).toBe('a string error');
  });

  it('handles objects with throwing getters', () => {
    const hostile: Record<string, unknown> = {};
    Object.defineProperty(hostile, 'message', {
      enumerable: true,
      get() {
        throw new Error('gotcha');
      },
    });
    Object.defineProperty(hostile, 'stack', {
      enumerable: true,
      get() {
        throw new Error('gotcha2');
      },
    });
    expect(() => scrubError(hostile)).not.toThrow();
    const r = scrubError(hostile);
    expect(typeof r.type).toBe('string');
    expect(typeof r.message).toBe('string');
    expect(typeof r.stack).toBe('string');
  });

  it('handles circular references', () => {
    const circular: Record<string, unknown> = { name: 'X' };
    circular.self = circular;
    expect(() => scrubError(circular)).not.toThrow();
  });

  it('redacts a real Error end to end', () => {
    const home = os.homedir();
    const err = new Error(`open ${home}/repo/secret.ts for user bob@h.com token sk-ABCdef1234567890ghij`);
    const out = scrubError(err);
    expect(out.type).toBe('Error');
    expect(out.message).not.toContain(home);
    expect(out.message).not.toContain('bob@h.com');
    expect(out.message).not.toContain('sk-ABCdef1234567890ghij');
  });
});

describe('error-scrub: messageTemplate collapses varying ids', () => {
  it('collapses numbers and quoted values to a stable template', () => {
    const a = messageTemplate('User 12 not found in "repo-alpha"');
    const b = messageTemplate('User 9999 not found in "repo-beta"');
    expect(a).toBe(b);
  });

  it('never throws on non-string', () => {
    expect(() => messageTemplate(null)).not.toThrow();
    expect(messageTemplate(null)).toBe('');
  });
});

describe('error-scrub: redactText handles non-strings', () => {
  it('returns empty for null/undefined', () => {
    expect(redactText(null)).toBe('');
    expect(redactText(undefined)).toBe('');
  });
});

describe('error-scrub: ReDoS / CPU-DoS bound (perf)', () => {
  // These inputs drove the email/JWT/generic-token regexes O(n²) before the
  // MAX_RAW_INPUT_CHARS cap + bounded quantifiers. Pre-fix, scrubbing a 200KB
  // hostile string took seconds (measured 200KB → ~32s). Post-fix it must be
  // well under 100ms because no regex ever sees more than ~8KB.
  const BUDGET_MS = 100;

  it('scrubs a 200KB email-local-part run (no @) well under 100ms', () => {
    const hostile = 'a.b-c_d%e+f'.repeat(20000); // ~220KB of local-part chars, no '@'
    const t0 = performance.now();
    const out = scrubMessage(hostile);
    const elapsed = performance.now() - t0;
    expect(typeof out).toBe('string');
    expect(out.length).toBeLessThanOrEqual(MESSAGE_MAX_CHARS);
    expect(elapsed).toBeLessThan(BUDGET_MS);
  });

  it('scrubs a 100KB base64 blob well under 100ms', () => {
    const blob = 'A1b2C3d4E5f6G7h8'.repeat(7000); // ~112KB base64url-ish, digit-laden
    const t0 = performance.now();
    const out = scrubMessage(blob);
    const elapsed = performance.now() - t0;
    expect(typeof out).toBe('string');
    expect(elapsed).toBeLessThan(BUDGET_MS);
  });

  it('scrubs a 200KB hostile stack well under 100ms', () => {
    const hostile = 'x.y-z_w%v+u'.repeat(20000);
    const t0 = performance.now();
    const out = scrubStack(`Error: boom\n    at fn (${hostile})`);
    const elapsed = performance.now() - t0;
    expect(typeof out).toBe('string');
    expect(out.length).toBeLessThanOrEqual(STACK_MAX_CHARS);
    expect(elapsed).toBeLessThan(BUDGET_MS);
  });

  it('scrubError end-to-end on a 200KB hostile message is bounded', () => {
    const hostile = 'a.b-c_d%e+f'.repeat(20000);
    const t0 = performance.now();
    const out = scrubError(new Error(hostile));
    const elapsed = performance.now() - t0;
    expect(out.message.length).toBeLessThanOrEqual(MESSAGE_MAX_CHARS);
    expect(elapsed).toBeLessThan(BUDGET_MS);
  });
});
