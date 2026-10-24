import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { rmSync } from 'fs';
import { join } from 'path';
import { WIRE_GATEWAY_DIR } from '../../src/shared/paths.js';
import { findSecretSpans } from '../../src/utils/redaction.js';
import { collectJsonStrings } from '../../src/services/wire-gateway/json/string-walker.js';
import { OutboundRedactionPlaceholders } from '../../src/services/wire-gateway/privacy/outbound-redaction.js';
import { PlaceholderRestoringResponse } from '../../src/services/wire-gateway/privacy/placeholder-restoring-response.js';
import { scrubWireText } from '../../src/services/wire-gateway/privacy/secret-scrub.js';

// What a hostile or merely huge text must not do to the gateway: the
// detectors, the JSON walk and the reply restorer stay linear and bounded.
// Each case is 1 MiB; the budget is generous so a slow CI box still passes,
// while the quadratic versions these guard against took 15 s and more.

const MEBIBYTE = 1024 * 1024;
const LINEAR_BUDGET_MS = 2_000;

const testRoot = join(WIRE_GATEWAY_DIR, 'privacy-hardening-test');
let placeholders: OutboundRedactionPlaceholders;

beforeEach(() => {
  rmSync(testRoot, { recursive: true, force: true });
  placeholders = new OutboundRedactionPlaceholders({ keyFilePath: join(testRoot, 'redact.key') });
});
afterEach(() => rmSync(testRoot, { recursive: true, force: true }));

function repeatedTo(unit: string, length: number): string {
  return unit.repeat(Math.ceil(length / unit.length)).slice(0, length);
}

function elapsedMs(work: () => void): number {
  const started = performance.now();
  work();
  return performance.now() - started;
}

const hostileTexts: Record<string, string> = {
  'PEM BEGIN lines with no END': repeatedTo('-----BEGIN PRIVATE KEY-----\n', MEBIBYTE),
  'PEM BEGIN lines with only certificate ENDs': repeatedTo('-----BEGIN RSA PRIVATE KEY-----\n-----END CERTIFICATE-----\n', MEBIBYTE),
  'secret assignments chained into one value run': repeatedTo('password=x', MEBIBYTE),
  'one long run of secret words': repeatedTo('token', MEBIBYTE),
  'secret JSON fields with no value': repeatedTo('"api_key": "', MEBIBYTE),
  'URL schemes with user:password runs': repeatedTo('a://b:c', MEBIBYTE),
};

describe('secret detectors stay linear on 1 MiB hostile text', () => {
  for (const [name, text] of Object.entries(hostileTexts)) {
    it(name, () => {
      expect(elapsedMs(() => findSecretSpans(text))).toBeLessThan(LINEAR_BUDGET_MS);
      expect(elapsedMs(() => scrubWireText(text))).toBeLessThan(LINEAR_BUDGET_MS);
      expect(elapsedMs(() => placeholders.maskText(text))).toBeLessThan(LINEAR_BUDGET_MS);
    });
  }

  it('still finds each PEM private key, from its BEGIN line to the first END after it', () => {
    const first = '-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----';
    const second = '-----BEGIN OPENSSH PRIVATE KEY-----x-----END OPENSSH PRIVATE KEY-----';
    const text = `a ${first} b ${second}`;
    expect(findSecretSpans(text).filter(span => span.kind === 'PRIVATE_KEY').map(span => text.slice(span.start, span.end))).toEqual([first, second]);
    // RE2's `[\s\S]+?`: at least one character between the lines.
    expect(findSecretSpans('-----BEGIN PRIVATE KEY----------END PRIVATE KEY-----')).toEqual([]);
  });

  it('still finds a secret assignment after a long secret-word name, and not past 256 name characters', () => {
    expect(findSecretSpans(`DB_PASSWORD=hunter2abc9 and api_key: "zzzzzzzz9"`).map(span => span.kind)).toEqual(['SECRET', 'SECRET']);
    expect(findSecretSpans(`token${'_'.repeat(300)}=abcdefgh12`)).toEqual([]);
    expect(findSecretSpans(`token${'_'.repeat(200)}=abcdefgh12`).map(span => span.kind)).toEqual(['SECRET']);
  });
});

describe('the JSON walk stays linear however deep or wide', () => {
  it('walks 500,000 levels of nesting', () => {
    const depth = 500_000;
    const deep = new TextEncoder().encode(`${'['.repeat(depth)}"x"${']'.repeat(depth)}`);
    let found: string[] = [];
    expect(elapsedMs(() => { found = collectJsonStrings(deep, { rootContext: null }).map(site => site.value); })).toBeLessThan(LINEAR_BUDGET_MS);
    expect(found).toEqual(['x']);
    expect(elapsedMs(() => placeholders.maskRequestBody(deep))).toBeLessThan(LINEAR_BUDGET_MS);
  });

  it('masks an object of 80,000 members without reading the object once per member', () => {
    const wide = `{${Array.from({ length: 80_000 }, (_, index) => `"k${index}":"v"`).join(',')},"note":"sk-proj-abcdEFGH1234ijklMNOP5678qrst"}`;
    let maskedCount = 0;
    expect(elapsedMs(() => { maskedCount = placeholders.maskRequestBody(new TextEncoder().encode(wide)).maskedCount; })).toBeLessThan(LINEAR_BUDGET_MS);
    expect(maskedCount).toBe(1);
  });
});

describe('masking splices bytes, not characters', () => {
  it('keeps multi-byte text before, inside and after a masked string exactly', () => {
    const secret = 'sk-proj-abcdEFGH1234ijklMNOP5678qrst';
    const before = '{"a":"日本語 😀 \\u00e9","messages":[{"role":"user","content":"é😀 ';
    const after = ' ünï"}],"z":"Ω\\/"}';
    const body = `${before}${secret}${after}`;
    const masked = new TextDecoder().decode(placeholders.maskRequestBody(new TextEncoder().encode(body)).bytes);
    expect(masked.startsWith(before)).toBe(true);
    expect(masked.endsWith(after)).toBe(true);
    expect(masked.slice(before.length, masked.length - after.length)).toMatch(/^\{\{API_KEY_[a-z2-7]{8}\}\}$/);
  });
});

describe('a body that is not JSON keeps every byte outside its secrets', () => {
  it('masks a binary upload byte for byte (no UTF-8 round trip)', () => {
    const secret = 'sk-proj-abcdEFGH1234ijklMNOP5678qrst';
    const binaryHead = Uint8Array.from([0xff, 0xfe, 0x00, 0x80, 0xc3, 0x28, 0x20]);
    const binaryTail = Uint8Array.from([0x20, 0x9f, 0xff, 0x00]);
    const body = new Uint8Array([...binaryHead, ...new TextEncoder().encode(secret), ...binaryTail]);
    const masked = placeholders.maskRequestBody(body);
    expect(masked.changed).toBe(true);
    expect([...masked.bytes.subarray(0, binaryHead.length)]).toEqual([...binaryHead]);
    expect([...masked.bytes.subarray(masked.bytes.length - binaryTail.length)]).toEqual([...binaryTail]);
    const middle = Buffer.from(masked.bytes.subarray(binaryHead.length, masked.bytes.length - binaryTail.length)).toString('latin1');
    expect(middle).toMatch(/^\{\{API_KEY_[a-z2-7]{8}\}\}$/);
    expect(placeholders.restore(middle, false)).toBe(secret);
  });
});

describe('the reply restorer holds a bounded amount', () => {
  it('relays a whole reply past the bound as it came, every byte once', () => {
    const restorer = new PlaceholderRestoringResponse({ placeholders, contentType: 'application/json', contentEncoding: null, maxHeldBytes: 64 });
    const pieces = [repeatedTo('a', 40), repeatedTo('b', 40), repeatedTo('c', 40)].map(text => new TextEncoder().encode(text));
    const output: Uint8Array[] = [];
    for (const piece of pieces) output.push(...restorer.push(piece));
    output.push(...restorer.finish());
    expect(Buffer.concat(output).toString()).toBe(Buffer.concat(pieces).toString());
  });

  it('relays a stream event that never ends past the bound as it came', () => {
    const restorer = new PlaceholderRestoringResponse({ placeholders, contentType: 'text/event-stream', contentEncoding: null, maxHeldBytes: 64 });
    const whole = `data: {"type":"x"}\n\ndata: ${repeatedTo('z', 200)}`;
    const bytes = new TextEncoder().encode(whole);
    const output: Uint8Array[] = [];
    for (let index = 0; index < bytes.length; index += 7) output.push(...restorer.push(bytes.subarray(index, index + 7)));
    output.push(...restorer.finish());
    expect(Buffer.concat(output).toString()).toBe(whole);
  });
});
