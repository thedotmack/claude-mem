import { describe, expect, it } from 'bun:test';
import { JsonScanError, arrayElements, getSpan, scanDocument, type JsonSpan } from '../../src/services/wire-gateway/json/scanner.js';
import {
  appendArrayItem,
  encodeJsonString,
  insertArrayItem,
  insertObjectMember,
  removeArrayItems,
  replaceSpan,
} from '../../src/services/wire-gateway/json/splice.js';

// Phase 10 task 2: splices keep every byte outside the edit, return the same
// buffer when nothing changes, and are idempotent.

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const bytesOf = (text: string) => encoder.encode(text);
const textOf = (bytes: Uint8Array) => decoder.decode(bytes);
const spanAt = (bytes: Uint8Array, ...path: Array<string | number>): JsonSpan => getSpan(bytes, path)!;

// magpie's odd-JSON body (upstream_bytes_test.go): whitespace, 1.50e2, 0.70, \/ and a control escape survive.
const oddBody = `{ "max_tokens" : 1024,"model":"m1",
 "system":[{"type":"text","text":"You are é \\/ \\"careful\\"\\n\\ttabs"}],
 "messages":[{"role":"user","content":"read it"} , {"role":"user","content":[{"type":"text","text":"line\\u0001one"}]}],
 "temperature":0.70, "n":1.50e2 }`;

describe('encodeJsonString', () => {
  it('never escapes HTML and round-trips through JSON.parse', () => {
    const text = '<b> & co "quoted" \\ é 😀  ';
    const encoded = encodeJsonString(text);
    expect(encoded).toContain('<b> & co');
    expect(JSON.parse(encoded)).toBe(text);
  });
});

describe('replaceSpan', () => {
  it('changes only the value and returns a new buffer', () => {
    const body = bytesOf(oddBody);
    const changed = replaceSpan(body, spanAt(body, 'model'), '"m2"');
    expect(changed).not.toBe(body);
    expect(textOf(changed)).toBe(oddBody.replace('"model":"m1"', '"model":"m2"'));
    expect(textOf(body)).toBe(oddBody); // the input is never mutated
  });

  it('returns the same buffer when the bytes are already the replacement (idempotent)', () => {
    const body = bytesOf(oddBody);
    const once = replaceSpan(body, spanAt(body, 'model'), '"m2"');
    expect(replaceSpan(once, spanAt(once, 'model'), '"m2"')).toBe(once);
    expect(replaceSpan(body, spanAt(body, 'temperature'), '0.70')).toBe(body);
  });

  it('refuses a replacement that is not one JSON value (fail fast)', () => {
    const body = bytesOf(oddBody);
    expect(() => replaceSpan(body, spanAt(body, 'model'), '"unterminated')).toThrow(JsonScanError);
    expect(() => replaceSpan(body, spanAt(body, 'model'), '1 2')).toThrow(JsonScanError);
  });
});

describe('array splices', () => {
  it('appends after the last element, keeping the whitespace before the bracket', () => {
    const body = bytesOf('{"a":[1 , 2  ]}');
    const appended = appendArrayItem(body, spanAt(body, 'a'), '{"x":"<y>"}');
    expect(textOf(appended)).toBe('{"a":[1 , 2,{"x":"<y>"}  ]}');
    expect(appendArrayItem(appended, spanAt(appended, 'a'), '{"x":"<y>"}')).toBe(appended);
  });

  it('appends into an empty array', () => {
    const body = bytesOf('{"a":[ ]}');
    const appended = appendArrayItem(body, spanAt(body, 'a'), '7');
    expect(textOf(appended)).toBe('{"a":[7 ]}');
    expect(appendArrayItem(appended, spanAt(appended, 'a'), '7')).toBe(appended);
  });

  it('inserts at the front, the middle and the end', () => {
    const body = bytesOf('[1, 2, 3]');
    const root = scanDocument(body);
    expect(textOf(insertArrayItem(body, root, 0, '0'))).toBe('[0,1, 2, 3]');
    expect(textOf(insertArrayItem(body, root, 2, '9'))).toBe('[1, 2,9, 3]');
    expect(textOf(insertArrayItem(body, root, 3, '4'))).toBe('[1, 2, 3,4]');
    const inserted = insertArrayItem(body, root, 0, '0');
    expect(insertArrayItem(inserted, scanDocument(inserted), 0, '0')).toBe(inserted);
    expect(() => insertArrayItem(body, root, 4, '0')).toThrow(RangeError);
  });

  it('removes picked elements with their commas, idempotently', () => {
    const body = bytesOf('[ 1 , 2 , 3 , 4 ]');
    const isEven = (element: JsonSpan, _index: number, bytes = body) => Number(textOf(bytes.subarray(element.start, element.end))) % 2 === 0;
    const removedEven = removeArrayItems(body, scanDocument(body), element => isEven(element, 0));
    expect(textOf(removedEven)).toBe('[ 1 , 3 ]');
    expect(JSON.parse(textOf(removedEven))).toEqual([1, 3]);
    expect(removeArrayItems(removedEven, scanDocument(removedEven), element => isEven(element, 0, removedEven))).toBe(removedEven);

    const leading = removeArrayItems(body, scanDocument(body), (_element, index) => index < 2);
    expect(JSON.parse(textOf(leading))).toEqual([3, 4]);
    expect(textOf(leading)).toBe('[ 3 , 4 ]');
    const trailing = removeArrayItems(body, scanDocument(body), (_element, index) => index >= 2);
    expect(textOf(trailing)).toBe('[ 1 , 2 ]');
    const all = removeArrayItems(body, scanDocument(body), () => true);
    expect(textOf(all)).toBe('[]');
    expect(removeArrayItems(body, scanDocument(body), () => false)).toBe(body);
    // Every mix of picks gives valid JSON with the kept elements in order.
    for (let mask = 0; mask < 16; mask++) {
      const kept = removeArrayItems(body, scanDocument(body), (_element, index) => (mask & (1 << index)) !== 0);
      expect(JSON.parse(textOf(kept))).toEqual([1, 2, 3, 4].filter((_value, index) => (mask & (1 << index)) === 0));
    }
  });
});

describe('insertObjectMember', () => {
  it('appends a member after the last one, as magpie appends thinking:disabled', () => {
    const body = bytesOf(oddBody);
    const changed = insertObjectMember(body, scanDocument(body), 'thinking', '{"type":"disabled"}');
    expect(textOf(changed)).toBe(oddBody.replace('"n":1.50e2 }', '"n":1.50e2,"thinking":{"type":"disabled"} }'));
    expect(insertObjectMember(changed, scanDocument(changed), 'thinking', '{"type":"disabled"}')).toBe(changed);
  });

  it('replaces an existing member (the last duplicate) instead of adding a second', () => {
    const body = bytesOf('{"a":1,"b":2,"a":3}');
    const changed = insertObjectMember(body, scanDocument(body), 'a', '4');
    expect(textOf(changed)).toBe('{"a":1,"b":2,"a":4}');
  });

  it('fills an empty object and escapes the key', () => {
    const body = bytesOf('{ }');
    expect(textOf(insertObjectMember(body, scanDocument(body), 'k"<', 'true'))).toBe('{"k\\"<":true }');
  });
});

describe('cost', () => {
  it('edits a 1 MB body with deep nesting in linear time', () => {
    const depth = 50_000;
    const deep = `${'['.repeat(depth)}${']'.repeat(depth)}`;
    const filler = 'x'.repeat(1024 * 1024);
    const body = bytesOf(`{"deep":${deep},"filler":"${filler}","list":[${Array.from({ length: 2000 }, (_, index) => `{"i":${index},"deep":${'['.repeat(200)}${']'.repeat(200)}}`).join(',')}]}`);
    const startedAt = performance.now();
    const listSpan = spanAt(body, 'list');
    let edited = appendArrayItem(body, listSpan, '{"i":-1}');
    edited = removeArrayItems(edited, spanAt(edited, 'list'), (_element, index) => index % 2 === 0);
    edited = insertObjectMember(edited, scanDocument(edited), 'added', '"<x>"');
    edited = replaceSpan(edited, spanAt(edited, 'filler'), '"short"');
    const elapsedMs = performance.now() - startedAt;
    expect([...arrayElements(edited, spanAt(edited, 'list'))].length).toBe(1000);
    expect(elapsedMs).toBeLessThan(2_000);
  });
});
