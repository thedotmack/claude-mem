import { afterAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { WIRE_GATEWAY_DIR } from '../../src/shared/paths.js';
import { applyConfigFileEdit } from '../../src/services/wire-gateway/edit/config-file.js';
import { deleteEnvFileKeys, patchEnvDocument, readEnvValue } from '../../src/services/wire-gateway/edit/env-editor.js';
import { MAX_WILDCARD_EXPANSIONS, patchJsoncDocument, resolveJsoncKeyPath, type JsoncPatch } from '../../src/services/wire-gateway/edit/jsonc-editor.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
const ONE_MEGABYTE = 1 << 20;
const HOSTILE_INPUT_BUDGET_MS = 2_000;

function patchJsonc(text: string, patch: JsoncPatch): string {
  return decoder.decode(patchJsoncDocument(encoder.encode(text), patch));
}

function expectSetThenDeleteGivesBackOriginal(original: string, keyPath: string, value: unknown, deleteKeyPath = keyPath): string {
  const withValue = patchJsonc(original, { set: [{ keyPath, value }] });
  expect(withValue).not.toBe(original);
  expect(patchJsonc(withValue, { delete: [deleteKeyPath] })).toBe(original);
  return withValue;
}

function expectWithinBudget(label: string, run: () => unknown): void {
  const startedAt = performance.now();
  try {
    run();
  } catch {
    // Refusing hostile input is fine; taking long is not.
  }
  const elapsedMs = performance.now() - startedAt;
  if (elapsedMs > HOSTILE_INPUT_BUDGET_MS) throw new Error(`${label} took ${Math.round(elapsedMs)} ms`);
}

describe('JSONC editor: byte-exact set → delete round trips', () => {
  const settings = '{\n  // schema\n  "$schema": "https://opencode.ai/config.json", /* x */\n  "env": {\n    "A": "1",\n    "B": "2"\n  },\n  "model": "a/b"\n}\n';

  it('round-trips a new top-level key, a key in a nested object and a new nested object', () => {
    expect(expectSetThenDeleteGivesBackOriginal(settings, 'small_model', 'anthropic/claude-haiku-4-5'))
      .toBe('{\n  "small_model": "anthropic/claude-haiku-4-5",\n  // schema\n  "$schema": "https://opencode.ai/config.json", /* x */\n  "env": {\n    "A": "1",\n    "B": "2"\n  },\n  "model": "a/b"\n}\n');
    expectSetThenDeleteGivesBackOriginal(settings, 'env.CLAUDE_CODE_GATEWAY_HINT_HEADERS', '1');
    expectSetThenDeleteGivesBackOriginal(settings, 'provider.claude-mem', { options: { baseURL: 'http://127.0.0.1:37677/r/opencode' } }, 'provider');
  });

  it('keeps CRLF only when every line break was CRLF', () => {
    const crlf = '{\r\n  "env": {\r\n    "A": "1"\r\n  },\r\n  "m": 1\r\n}\r\n';
    const withValue = expectSetThenDeleteGivesBackOriginal(crlf, 'env.B', '2');
    expect(withValue).toBe('{\r\n  "env": {\r\n    "B": "2",\r\n    "A": "1"\r\n  },\r\n  "m": 1\r\n}\r\n');
    expectSetThenDeleteGivesBackOriginal(crlf, 'z', 2);
    const mixed = '{\r\n  "a": 1\n}\n';
    expect(patchJsonc(mixed, { set: [{ keyPath: 'b', value: 2 }] })).toBe('{\n  "b": 2,\r\n  "a": 1\n}\n');
  });

  it('keeps a byte order mark', () => {
    const withMark = '\uFEFF{\r\n  "model": "deepseek-chat",\r\n  "env": {\r\n    "ANTHROPIC_AUTH_TOKEN": "sk-user-own"\r\n  }\r\n}\r\n';
    const edited = expectSetThenDeleteGivesBackOriginal(withMark, 'env.MAGPIE', '1');
    expect(edited.startsWith('\uFEFF{')).toBe(true);
    expect(edited.slice(1).includes('\uFEFF')).toBe(false);
  });

  it('deletes a middle key keeping the layout, collapses an emptied object, and handles compact files', () => {
    let text = '{\n  "env": {\n    "A": "1",\n    "B": "2",\n    "C": "3"\n  },\n  "model": "m"\n}\n';
    text = patchJsonc(text, { delete: ['env.B'] });
    expect(text).toBe('{\n  "env": {\n    "A": "1",\n    "C": "3"\n  },\n  "model": "m"\n}\n');
    text = patchJsonc(text, { delete: ['env.C', 'nope.x'] });
    expect(text).toBe('{\n  "env": {\n    "A": "1"\n  },\n  "model": "m"\n}\n');
    text = patchJsonc(text, { delete: ['env.A'] });
    expect(text).toBe('{\n  "env": {},\n  "model": "m"\n}\n');
    expect(patchJsonc('{"a":1,"b":{"x":true},"c":3}', { delete: ['a', 'b.x'] })).toBe('{"b":{},"c":3}');
    expect(patchJsonc('{"a":1}', { set: [{ keyPath: 'model', value: 'm' }] })).toBe('{"model":"m","a":1}');
    expect(patchJsonc('{\n  // keep me\n  "a": 1, // trailing\n  "b": 2\n}\n', { delete: ['b'] })).toBe('{\n  // keep me\n  "a": 1 // trailing\n}\n');
  });

  it('round-trips a key inserted before a comment on the opening brace line', () => {
    expectSetThenDeleteGivesBackOriginal('{ // top\n  "a": 1\n}\n', 'k', true);
  });

  it('supports \\. escapes and * wildcards; resolve returns every match', () => {
    expect(patchJsonc('{"chat.defaultModel": 1}', { set: [{ keyPath: 'chat\\.defaultModel', value: 2 }] })).toBe('{"chat.defaultModel": 2}');
    const providers = '{\n  "provider": {\n    "openai": { "options": { "baseURL": "https://api.openai.com/v1" } },\n    "local": {\n      "options": {}\n    }\n  }\n}\n';
    expect(resolveJsoncKeyPath(encoder.encode(providers), 'provider.*.options.baseURL')).toEqual([
      { keys: ['provider', 'openai', 'options', 'baseURL'], value: 'https://api.openai.com/v1' },
    ]);
    const wired = patchJsonc(providers, { set: [{ keyPath: 'provider.*.options.baseURL', value: 'http://127.0.0.1:37677/r/x' }] });
    expect(resolveJsoncKeyPath(encoder.encode(wired), 'provider.*.options.baseURL').map((match) => match.value)).toEqual([
      'http://127.0.0.1:37677/r/x',
      'http://127.0.0.1:37677/r/x',
    ]);
  });

  it('refuses invalid JSON, a non-object top level and duplicated keys, unchanged', () => {
    const refusals: Array<[string, JsoncPatch]> = [];
    for (const input of ['{"model":"old", "keep":', '{"model":"old" "keep":true}', '{"model":"old"} {"keep":true}', '[1]', '{/* open']) {
      refusals.push([input, { set: [{ keyPath: 'model', value: 'new' }] }], [input, { delete: ['model'] }], [input, { delete: ['missing'] }]);
    }
    refusals.push(['{"a":1,"a":2}', { set: [{ keyPath: 'a', value: 3 }] }], ['{"a":1,"a":2}', { delete: ['a'] }]);
    for (const [input, patch] of refusals) {
      const bytes = encoder.encode(input);
      expect(() => patchJsoncDocument(bytes, patch)).toThrow();
      expect(decoder.decode(bytes)).toBe(input);
    }
  });

  it('refuses a file edit of invalid JSON without touching the file', () => {
    const dir = join(WIRE_GATEWAY_DIR, 'tmp', `edit-jsonc-${process.pid}`);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'settings.json');
    writeFileSync(path, '{"model":"old" "keep":true}');
    expect(() => applyConfigFileEdit(path, (bytes) => patchJsoncDocument(bytes, { set: [{ keyPath: 'model', value: 'n' }] }))).toThrow('invalid JSON');
    expect(readFileSync(path, 'utf-8')).toBe('{"model":"old" "keep":true}');
    rmSync(dir, { recursive: true, force: true });
  });

  it('stays linear on hostile 1 MB inputs', () => {
    expectWithinBudget('unterminated block comment', () => patchJsonc(`{/*${'a'.repeat(ONE_MEGABYTE)}`, { set: [{ keyPath: 'a', value: 1 }] }));
    expectWithinBudget('slashes', () => patchJsonc(`{${'/'.repeat(ONE_MEGABYTE)}}`, { set: [{ keyPath: 'a', value: 1 }] }));
    expectWithinBudget('deep nesting', () => patchJsonc(`{"a":${'['.repeat(ONE_MEGABYTE / 2)}${']'.repeat(ONE_MEGABYTE / 2)}}`, { set: [{ keyPath: 'a.b', value: 1 }] }));
    expectWithinBudget('escaped quotes', () => patchJsonc(`{"${'\\"'.repeat(ONE_MEGABYTE / 2)}":1}`, { set: [{ keyPath: 'a', value: 1 }] }));
    expectWithinBudget('whitespace', () => patchJsonc(`{${' '.repeat(ONE_MEGABYTE)}}`, { set: [{ keyPath: 'a', value: 1 }] }));
    expectWithinBudget('commas', () => patchJsonc(`{"a":[${','.repeat(ONE_MEGABYTE)}]}`, { set: [{ keyPath: 'a', value: 1 }] }));
    const manyMembers = `{\n${Array.from({ length: 60_000 }, (_, index) => `  "k${index}": ${index},\n`).join('')}  "z": 0\n}\n`;
    expectWithinBudget('many members', () => patchJsonc(manyMembers, { set: [{ keyPath: 'new', value: 1 }], delete: ['k5'] }));
    const manyObjects = `{"p":{${Array.from({ length: MAX_WILDCARD_EXPANSIONS + 1 }, (_, index) => `"k${index}":{}`).join(',')}}}`;
    expect(() => patchJsonc(manyObjects, { set: [{ keyPath: 'p.*.x', value: 1 }] })).toThrow('edit the file by hand');
  });
});

describe('.env editor', () => {
  function patchEnv(text: string, patch: Parameters<typeof patchEnvDocument>[1]): string {
    return decoder.decode(patchEnvDocument(encoder.encode(text), patch));
  }

  it('sets in place, appends after the last assignment, and deletes every line for a key', () => {
    const original = '# comment\nFOO=bar\nexport BAZ="q x"\n';
    expect(readEnvValue(encoder.encode(original), 'BAZ')).toBe('q x');
    const edited = patchEnv(original, { set: [{ key: 'FOO', value: 'new' }, { key: 'KEY', value: 'sk-1' }] });
    expect(edited).toBe('# comment\nFOO=new\nexport BAZ="q x"\nKEY=sk-1\n');
    expect(patchEnv(edited, { delete: ['FOO', 'KEY'] })).toBe('# comment\nexport BAZ="q x"\n');
    expect(patchEnv('', { set: [{ key: 'A', value: '1' }] })).toBe('A=1\n');
  });

  it('round-trips byte-exact: comments, CRLF, BOM, no final line break, middle keys', () => {
    for (const original of ['# c\nA=1\n\n# d\nB=2 # two\n', 'A=1\r\nB=2\r\n', '\uFEFFOPENAI_API_KEY=sk-own\r\nOTHER=1\r\n', 'A=1', '', '\n']) {
      const withValue = patchEnv(original, { set: [{ key: 'GOOGLE_GEMINI_BASE_URL', value: 'http://127.0.0.1:37677/r/gemini' }] });
      expect(patchEnv(withValue, { delete: ['GOOGLE_GEMINI_BASE_URL'] })).toBe(original);
    }
  });

  it('a duplicated key: the last line wins on read, and a set rewrites only that line', () => {
    const original = 'A=1\nB=x\nA=2\n';
    expect(readEnvValue(encoder.encode(original), 'A')).toBe('2');
    expect(patchEnv(original, { set: [{ key: 'A', value: '3' }] })).toBe('A=1\nB=x\nA=3\n');
  });

  it('quotes values that need it and refuses line breaks', () => {
    expect(patchEnv('', { set: [{ key: 'A', value: 'a b' }, { key: 'B', value: "it's" }, { key: 'C', value: 'C:\\x y' }] })).toBe("A='a b'\nB=\"it's\"\nC='C:\\x y'\n");
    expect(() => patchEnv('', { set: [{ key: 'A', value: 'a\nb' }] })).toThrow('line break');
  });

  it('removes the file only when claude-mem created it', () => {
    const dir = join(WIRE_GATEWAY_DIR, 'tmp', `edit-env-${process.pid}`);
    mkdirSync(dir, { recursive: true });
    const ours = join(dir, 'ours.env');
    const theirs = join(dir, 'theirs.env');
    writeFileSync(ours, 'GEMINI_API_KEY=x\nGOOGLE_GEMINI_BASE_URL=http://127.0.0.1:37677/r/gemini\n');
    writeFileSync(theirs, 'GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:37677/r/gemini\n');
    deleteEnvFileKeys(ours, ['GEMINI_API_KEY', 'GOOGLE_GEMINI_BASE_URL'], { fileWasCreatedByClaudeMem: true });
    deleteEnvFileKeys(theirs, ['GOOGLE_GEMINI_BASE_URL'], { fileWasCreatedByClaudeMem: false });
    expect(existsSync(ours)).toBe(false);
    expect(readFileSync(theirs, 'utf-8')).toBe('');
    rmSync(dir, { recursive: true, force: true });
  });

  it('stays linear on hostile 1 MB lines (magpie\'s `(.*?)\\s*$` tail backtracked quadratically)', () => {
    expectWithinBudget('export then spaces', () => patchEnv(`export${' '.repeat(ONE_MEGABYTE)}x`, { set: [{ key: 'A', value: '1' }] }));
    expectWithinBudget('spaces inside a value', () => patchEnv(`A=a${' '.repeat(ONE_MEGABYTE / 2)}b${' '.repeat(ONE_MEGABYTE / 2)}c`, { set: [{ key: 'B', value: '1' }] }));
    expectWithinBudget('word then spaces', () => patchEnv(`${'A'.repeat(ONE_MEGABYTE / 2)}${' '.repeat(ONE_MEGABYTE / 2)}x`, { set: [{ key: 'B', value: '1' }] }));
    expectWithinBudget('unterminated quote', () => readEnvValue(encoder.encode(`A="${'x'.repeat(ONE_MEGABYTE)}`), 'A'));
    expectWithinBudget('many lines', () => patchEnv(Array.from({ length: 100_000 }, (_, index) => `K${index}=v\n`).join(''), { set: [{ key: 'B', value: '1' }], delete: ['K5'] }));
  });
});
