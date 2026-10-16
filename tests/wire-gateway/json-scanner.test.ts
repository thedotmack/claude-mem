import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import {
  JsonScanError,
  arrayElements,
  decodeString,
  decodeValue,
  getSpan,
  objectMemberMap,
  objectMembers,
  rawText,
  scanDocument,
  type JsonSpan,
} from '../../src/services/wire-gateway/json/scanner.js';

const encoder = new TextEncoder();
const bytesOf = (text: string) => encoder.encode(text);

function jsonFixtureFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) files.push(...jsonFixtureFiles(path));
    else if (entry.endsWith('.json')) files.push(path);
  }
  return files;
}

/** Rebuild a value from the scanner's own spans (not JSON.parse of the whole), so the walk itself is tested. */
function valueFromSpans(bytes: Uint8Array, span: JsonSpan): unknown {
  switch (span.type) {
    case 'object': {
      const value: Record<string, unknown> = {};
      for (const member of objectMembers(bytes, span)) value[member.key] = valueFromSpans(bytes, member.value);
      return value;
    }
    case 'array':
      return [...arrayElements(bytes, span)].map(element => valueFromSpans(bytes, element));
    case 'string':
      return decodeString(bytes, span);
    case 'number':
      return Number(rawText(bytes, span));
    case 'true':
      return true;
    case 'false':
      return false;
    case 'null':
      return null;
  }
}

function isValidJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

describe('wire gateway JSON scanner', () => {
  it('finds value spans by path, counting multi-byte UTF-8 in bytes', () => {
    const document = '{"a":"é漢😀","messages":[{"role":"user"},{"role":"assistant","content":[1,[2,3],{"x":null}]}]}';
    const bytes = bytesOf(document);
    const roleSpan = getSpan(bytes, ['messages', 1, 'role'])!;
    expect(roleSpan.type).toBe('string');
    expect(decodeString(bytes, roleSpan)).toBe('assistant');
    expect(decodeString(bytes, getSpan(bytes, ['a'])!)).toBe('é漢😀');
    const nestedSpan = getSpan(bytes, ['messages', 1, 'content', 1])!;
    expect(nestedSpan.type).toBe('array');
    expect(rawText(bytes, nestedSpan)).toBe('[2,3]');
    expect(getSpan(bytes, ['messages', 1, 'content', 2, 'x'])!.type).toBe('null');
    expect(getSpan(bytes, ['messages', 5])).toBeNull();
    expect(getSpan(bytes, ['messages', 'role'])).toBeNull();
    expect([...arrayElements(bytes, getSpan(bytes, ['messages', 1, 'content'])!)].map(span => span.type)).toEqual(['number', 'array', 'object']);
  });

  it('decodes escapes exactly as JSON.parse, lone surrogates included', () => {
    const document = '{"s":"q\\"b\\\\s\\/n\\n\\t\\b\\f\\r \\u00e9 \\ud83d\\ude00 lone:\\ud800 end"}';
    const bytes = bytesOf(document);
    expect(decodeString(bytes, getSpan(bytes, ['s'])!)).toBe(JSON.parse(document).s);
  });

  it('reads the last duplicate key, as JSON.parse does, while listing every member', () => {
    const bytes = bytesOf('{"k":1,"other":true,"k":2}');
    expect(rawText(bytes, getSpan(bytes, ['k'])!)).toBe('2');
    expect(rawText(bytes, objectMemberMap(bytes, scanDocument(bytes)).get('k')!)).toBe('2');
    expect([...objectMembers(bytes, scanDocument(bytes))].map(member => member.key)).toEqual(['k', 'other', 'k']);
    expect(valueFromSpans(bytes, scanDocument(bytes))).toEqual(JSON.parse('{"k":1,"other":true,"k":2}'));
    expect(decodeValue(bytes, getSpan(bytes, ['other'])!)).toBe(true);
  });

  it('refuses what is not strict JSON', () => {
    for (const invalid of ['{"a":1,}', '[1,]', '01', '{"a" 1}', '"tab\there"', '{"a":1} x', '{a:1}', '-', '1.', '1e', 'nul', '{"a":1', '"\\x"', '"\\u12"', '"\\u12G4"', '"abc\\']) {
      expect(() => scanDocument(bytesOf(invalid)), invalid).toThrow(JsonScanError);
    }
  });

  it('cut at every byte: a prefix scans exactly when JSON.parse accepts it, to the same value', () => {
    const document = '{"model":"m","messages":[{"role":"user","content":[{"type":"text","text":"héllo \\u00e9 😀"}]},{"n":-1.5e3,"b":[true,false,null]}]}';
    const bytes = bytesOf(document);
    for (let cut = 0; cut <= bytes.length; cut++) {
      const prefix = bytes.subarray(0, cut);
      const prefixText = new TextDecoder().decode(prefix);
      if (isValidJson(prefixText)) {
        expect(valueFromSpans(prefix, scanDocument(prefix))).toEqual(JSON.parse(prefixText));
      } else {
        expect(() => scanDocument(prefix)).toThrow(JsonScanError);
      }
    }
  });

  it('reads every fixture to the same value JSON.parse gives', () => {
    const files = jsonFixtureFiles(join(import.meta.dir, '../fixtures/wire-gateway'));
    expect(files.length).toBeGreaterThanOrEqual(10);
    for (const file of files) {
      const bytes = new Uint8Array(readFileSync(file));
      expect(valueFromSpans(bytes, scanDocument(bytes))).toEqual(JSON.parse(readFileSync(file, 'utf-8')));
    }
  });

  it('walks deep nesting without recursion', () => {
    const depth = 100_000;
    const bytes = bytesOf('['.repeat(depth) + ']'.repeat(depth));
    expect(scanDocument(bytes).end).toBe(depth * 2);
  });
});
