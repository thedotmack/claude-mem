// The eve provider (integrations/eve/provider/src/index.ts) keeps its own copy
// of the Cowork shim's secret redaction (cowork/scripts/cmem-hook.mjs), because
// it cannot import the worker's src/utils/redaction.ts (see the comment there).
// cmem-hook-redaction-parity.test.ts holds Cowork to the worker; this test
// holds the eve copy to Cowork, so a pattern added to one and not the other
// fails here instead of letting that key shape reach cmem.ai from eve. The
// same holds for its copy of Cowork's <private> and system tag stripping.
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '../..');
const COWORK = join(ROOT, 'cowork/scripts/cmem-hook.mjs');
const EVE = join(ROOT, 'integrations/eve/provider/src/index.ts');

interface Redaction {
  REDACTED: string;
  SECRET_PATTERNS: RegExp[];
  KEYVALUE_RE: RegExp;
  COOKIE_RE: RegExp;
  URI_RE: RegExp;
  redactSecrets: (text: string) => string;
}

// Each copy's redaction block runs from `const REDACTED` through the end of
// `function redactSecrets`. Types are stripped, then the block is evaluated so
// the comparison is of the real RegExp values, not of comments or formatting.
function loadRedaction(file: string): Redaction {
  const source = readFileSync(file, 'utf8');
  const start = source.indexOf('const REDACTED =');
  const fnStart = source.indexOf('function redactSecrets(', start);
  const end = source.indexOf('\n}\n', fnStart);
  if (start === -1 || fnStart === -1 || end === -1) throw new Error(`redaction block not found in ${file}`);
  const block = new Bun.Transpiler({ loader: 'ts' }).transformSync(source.slice(start, end + 2));
  return new Function(`${block}\nreturn { REDACTED, SECRET_PATTERNS, KEYVALUE_RE, COOKIE_RE, URI_RE, redactSecrets };`)() as Redaction;
}

const shape = (pattern: RegExp) => ({ source: pattern.source, flags: pattern.flags });

const rep = (char: string, count: number) => char.repeat(count);
// One input per redaction step: secret patterns, URI credentials, cookie and
// authorization headers, key=value assignments, and webhook URLs.
const SAMPLES = [
  'printed: sk_live_' + rep('S', 24),
  'printed:\\nghp_' + rep('G', 36),
  '-----BEGIN RSA PRIVATE KEY-----\nMIIEbody\n-----END RSA PRIVATE KEY-----',
  'DATABASE_URL=postgres://app:hunter2@db.internal:5432/prod',
  'Cookie: sessionid=abc123def456ghi789',
  'curl -H "Authorization: Bearer ' + rep('t', 24) + '" https://api.example.com',
  'api_key=zq81-not-a-vendor-shape; password: two words',
  'https://hooks.slack.com/services/T0000000/B0000000/' + rep('K', 24),
  'https://discord.com/api/webhooks/12345678901234567/' + rep('C', 60),
  'cmem_' + rep('M', 32) + ' and cm_pro_' + rep('m', 16),
  'plain text with src/a.ts and ssh://git@github.com stays as it is',
];

describe('eve provider redaction matches the Cowork shim', () => {
  const cowork = loadRedaction(COWORK);
  const eve = loadRedaction(EVE);

  it('uses the same marker', () => {
    expect(eve.REDACTED).toBe(cowork.REDACTED);
  });

  it('has the same secret patterns, in the same order', () => {
    expect(eve.SECRET_PATTERNS.length).toBeGreaterThan(30);
    expect(eve.SECRET_PATTERNS.map(shape)).toEqual(cowork.SECRET_PATTERNS.map(shape));
  });

  it('has the same key=value, header and URI credential patterns', () => {
    expect(shape(eve.KEYVALUE_RE)).toEqual(shape(cowork.KEYVALUE_RE));
    expect(shape(eve.COOKIE_RE)).toEqual(shape(cowork.COOKIE_RE));
    expect(shape(eve.URI_RE)).toEqual(shape(cowork.URI_RE));
  });

  for (const sample of SAMPLES) {
    it(`redacts the same way: ${sample.slice(0, 40)}`, () => {
      expect(eve.redactSecrets(sample)).toBe(cowork.redactSecrets(sample));
    });
  }
});

interface PrivacyStripping {
  STRIP_TAGS_RE: RegExp;
  stripPrivacyRegions: (text: string) => string;
}

// Each copy's tag stripping runs from `const STRIP_TAGS_RE` through the end of
// `function stripPrivacyRegions`, evaluated the same way as the redaction block.
function loadPrivacyStripping(file: string): PrivacyStripping {
  const source = readFileSync(file, 'utf8');
  const start = source.indexOf('const STRIP_TAGS_RE =');
  const fnStart = source.indexOf('function stripPrivacyRegions(', start);
  const end = source.indexOf('\n}\n', fnStart);
  if (start === -1 || fnStart === -1 || end === -1) throw new Error(`privacy stripping block not found in ${file}`);
  const block = new Bun.Transpiler({ loader: 'ts' }).transformSync(source.slice(start, end + 2));
  return new Function(`${block}\nreturn { STRIP_TAGS_RE, stripPrivacyRegions };`)() as PrivacyStripping;
}

// One input per stripped form: each tag in the list, attributes, multiline
// regions, the HTML-escaped <private> form, an unclosed region (left for the
// server, in both copies), and plain text.
const PRIVACY_SAMPLES = [
  'keep <private>drop this</private> keep',
  'keep <private reason="x">drop\nacross lines</private> keep',
  '<claude-mem-context source="cmem.ai">old memory</claude-mem-context>after',
  'a<system_instruction>x</system_instruction>b<system-instruction>y</system-instruction>c',
  'a<persisted-output>x</persisted-output>b<system-reminder>y</system-reminder>c',
  'escaped &lt;private&gt;drop&lt;/private&gt; and &LT;PRIVATE&GT;drop too&LT;/PRIVATE&GT; kept',
  '{"note":"<private>in json</private>","path":"a.ts"}',
  'an unclosed <private> region stays for the server',
  'plain text with <b>html</b> and src/a.ts stays as it is',
];

describe('eve provider privacy tag stripping matches the Cowork shim', () => {
  const cowork = loadPrivacyStripping(COWORK);
  const eve = loadPrivacyStripping(EVE);

  it('has the same tag pattern', () => {
    expect(shape(eve.STRIP_TAGS_RE)).toEqual(shape(cowork.STRIP_TAGS_RE));
  });

  for (const sample of PRIVACY_SAMPLES) {
    it(`strips the same way: ${sample.slice(0, 40)}`, () => {
      expect(eve.stripPrivacyRegions(sample)).toBe(cowork.stripPrivacyRegions(sample));
    });
  }

  it('strips the function body identically, not just on these samples', () => {
    const body = (file: string) => {
      const source = readFileSync(file, 'utf8');
      const fnStart = source.indexOf('function stripPrivacyRegions(');
      return source
        .slice(source.indexOf('{', fnStart), source.indexOf('\n}\n', fnStart))
        .replace(/\s+/g, ' ')
        .replaceAll('"', "'");
    };
    expect(body(EVE)).toBe(body(COWORK));
  });
});
