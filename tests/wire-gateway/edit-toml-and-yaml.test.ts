import { describe, expect, it } from 'bun:test';
import { patchTomlDocument, readTomlValueAtKeyPath, type TomlPatch } from '../../src/services/wire-gateway/edit/toml-editor.js';
import { patchYamlDocument, readYamlValueAtKeyPath, type YamlPatch } from '../../src/services/wire-gateway/edit/yaml-editor.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
const ONE_MEGABYTE = 1 << 20;
const HOSTILE_INPUT_BUDGET_MS = 2_000;

function patchToml(text: string, patch: TomlPatch): string {
  return decoder.decode(patchTomlDocument(encoder.encode(text), patch));
}

function patchYaml(text: string, patch: YamlPatch): string {
  return decoder.decode(patchYamlDocument(encoder.encode(text), patch));
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

function expectRefusedUnchanged(patchDocument: (bytes: Uint8Array, patch: { set?: Array<{ keyPath: string; value: unknown }>; delete?: string[] }) => Uint8Array, input: string, patch: { set?: Array<{ keyPath: string; value: unknown }>; delete?: string[] }, message: string): void {
  const bytes = encoder.encode(input);
  expect(() => patchDocument(bytes, patch)).toThrow(message);
  expect(decoder.decode(bytes)).toBe(input);
}

const codexConfig = [
  '# Codex config',
  'model = "gpt-5" # pinned',
  '',
  '[model_providers.mine]',
  'name = "Mine"',
  'base_url = "https://example.com/v1"',
  '',
  '# notifications',
  '[tui]',
  'notifications = true',
  '',
].join('\n');

describe('TOML editor: byte-exact set → delete round trips', () => {
  function expectRoundTrip(original: string, keyPath: string, value: unknown, deleteKeyPath = keyPath): string {
    const withValue = patchToml(original, { set: [{ keyPath, value }] });
    expect(withValue).not.toBe(original);
    expect(readTomlValueAtKeyPath(encoder.encode(withValue), keyPath)).toEqual(value);
    expect(patchToml(withValue, { delete: [deleteKeyPath] })).toBe(original);
    return withValue;
  }

  it('top-level key, key in a middle table, key in the last table, new table', () => {
    expect(expectRoundTrip(codexConfig, 'model_provider', 'claude-mem')).toBe(codexConfig.replace('# pinned\n', '# pinned\nmodel_provider = "claude-mem"\n'));
    expect(expectRoundTrip(codexConfig, 'model_providers.mine.wire_api', 'responses')).toContain('base_url = "https://example.com/v1"\nwire_api = "responses"\n');
    expectRoundTrip(codexConfig, 'tui.animations', false);
    expect(expectRoundTrip(codexConfig, 'model_providers.claude-mem.base_url', 'http://127.0.0.1:37677/r/codex', 'model_providers.claude-mem'))
      .toBe(`${codexConfig}\n[model_providers.claude-mem]\nbase_url = "http://127.0.0.1:37677/r/codex"\n`);
  });

  it('strings, numbers, arrays and inline tables', () => {
    expectRoundTrip(codexConfig, 'retries', 3);
    expectRoundTrip(codexConfig, 'ratio', 1.5);
    expectRoundTrip(codexConfig, 'args', ['--flag', 'two words', 'quote"d']);
    expectRoundTrip(codexConfig, 'mcp_servers.claude-mem', { command: 'bun', args: ['/a b/mcp.cjs'], env: { CLAUDE_MEM_X: '1' } }, 'mcp_servers');
    expectRoundTrip(codexConfig, 'unicode', '日本 é\t"\\');
  });

  it('keeps CRLF, a byte order mark, a missing final line break and multi-line values', () => {
    expectRoundTrip(codexConfig.replaceAll('\n', '\r\n'), 'model_providers.claude-mem.base_url', 'u', 'model_providers.claude-mem');
    expectRoundTrip(`\uFEFF${codexConfig.replaceAll('\n', '\r\n')}`, 'model_provider', 'claude-mem');
    expectRoundTrip('a = 1', 'b', 2);
    expectRoundTrip('[t]\na = 1', 't.b', 2);
    expectRoundTrip('', 'a.b.c', 'x', 'a.b');
    const multiline = 'raw = """\n[another]\nmodel_provider = x\n"""\nlist = [\n  "[x]", # c\n  2,\n]\nmodel = "m"\n\n[t]\nx = 1\n';
    expectRoundTrip(multiline, 'model_provider', 'p');
    expectRoundTrip(multiline, 't.y', 'z');
  });

  it('replaces a value in place, keeping its comment', () => {
    expect(patchToml(codexConfig, { set: [{ keyPath: 'model', value: 'gpt-5.1' }] })).toBe(codexConfig.replace('"gpt-5"', '"gpt-5.1"'));
    expect(patchToml('list = [\n  1,\n  2,\n]\n[s]\n', { set: [{ keyPath: 'list', value: [3] }] })).toBe('list = [3]\n[s]\n');
  });

  it('deletes a table with the comment right above it, keeping the next table\'s comment', () => {
    expect(patchToml(codexConfig, { delete: ['model_providers.mine'] })).toBe('# Codex config\nmodel = "gpt-5" # pinned\n\n# notifications\n[tui]\nnotifications = true\n');
    expect(patchToml(codexConfig, { delete: ['tui'] })).toBe('# Codex config\nmodel = "gpt-5" # pinned\n\n[model_providers.mine]\nname = "Mine"\nbase_url = "https://example.com/v1"\n');
  });

  it('addresses array table elements by index and dotted-key tables in place', () => {
    const hooks = '[[hooks]]\nevent = "A"\n\n[[hooks]]\nevent = "B"\n';
    expectRoundTrip(hooks, 'hooks.1.matcher', 'Read');
    expect(patchToml(hooks, { set: [{ keyPath: 'hooks.0.event', value: 'Z' }] })).toBe(hooks.replace('"A"', '"Z"'));
    expect(patchToml(hooks, { delete: ['hooks.1'] })).toBe('[[hooks]]\nevent = "A"\n');
    expectRoundTrip('a.b = 1\n', 'a.c', 2);
    expect(patchToml('[a."b.c"]\nx = 1\n', { set: [{ keyPath: 'a.b\\.c.y', value: 2 }] })).toBe('[a."b.c"]\nx = 1\ny = 2\n');
  });

  it('sub-tables of an array table element belong to that element: deleting the element removes them', () => {
    const hooks = '[[hooks]]\nevent = "A"\n[hooks.post]\nx = 1\n\n[[hooks]]\nevent = "B"\n[hooks.post]\nx = 2\n';
    expect(readTomlValueAtKeyPath(encoder.encode(hooks), 'hooks.1.post.x')).toBe(2);
    expect(patchToml(hooks, { delete: ['hooks.1'] })).toBe('[[hooks]]\nevent = "A"\n[hooks.post]\nx = 1\n');
    expect(patchToml('[[hooks]]\nevent = "A"\n\n[[hooks]]\nevent = "B"\n[hooks.post]\nx = 2\n', { delete: ['hooks.1'] })).toBe('[[hooks]]\nevent = "A"\n');
    expect(expectRoundTrip(hooks, 'hooks.1.post.y', 3)).toBe(`${hooks}y = 3\n`);
    expect(expectRoundTrip(hooks, 'hooks.0.post.y', 3)).toBe(hooks.replace('x = 1\n', 'x = 1\ny = 3\n'));
    expectRefusedUnchanged(patchTomlDocument, '[[h]]\n[h.p]\n[h.p]\n', { set: [{ keyPath: 'y', value: 1 }] }, 'defined twice');
  });

  it('duplicate keys and tables are refused by the editor itself, whatever Bun\'s parser lets through', () => {
    // Bun 1.3.9's TOML parser accepts a repeated table, a header reopening a dotted-key table and a header
    // extending an inline table; Bun 1.4.3 refuses them. The editor checks all of them, so both refuse alike.
    expectRefusedUnchanged(patchTomlDocument, 'a = 1\na = 2\n', { set: [{ keyPath: 'y', value: 1 }] }, 'defined twice');
    expectRefusedUnchanged(patchTomlDocument, '[t]\na = 1\na = 2\n', { set: [{ keyPath: 'y', value: 1 }] }, 'defined twice');
    expectRefusedUnchanged(patchTomlDocument, '[x]\na = 1\n[x]\nb = 2\n', { set: [{ keyPath: 'y', value: 1 }] }, 'defined twice');
    expectRefusedUnchanged(patchTomlDocument, 'a.b = 1\n[a]\nc = 2\n', { set: [{ keyPath: 'y', value: 1 }] }, 'dotted keys');
    expectRefusedUnchanged(patchTomlDocument, 'a = {b = 1}\n[a.c]\nd = 2\n', { delete: ['y'] }, 'already defines');
    // An edit that would itself define a table twice is refused before it is written.
    expectRefusedUnchanged(patchTomlDocument, 'a = {b = 1}\n', { set: [{ keyPath: 'a.c', value: 1 }] }, 'edit the file by hand');
    expect(() => readTomlValueAtKeyPath(encoder.encode('[x]\na = 1\n[x]\nb = 2\n'), 'x.a')).toThrow('defined twice');
  });

  it('refuses invalid input and edits it cannot make, unchanged', () => {
    expectRefusedUnchanged(patchTomlDocument, 'a = [\n', { set: [{ keyPath: 'y', value: 1 }] }, 'invalid TOML');
    expectRefusedUnchanged(patchTomlDocument, codexConfig, { set: [{ keyPath: 'tui', value: 1 }] }, 'is a table');
    expectRefusedUnchanged(patchTomlDocument, codexConfig, { set: [{ keyPath: 'nothing', value: null }] }, 'TOML has no null');
    expectRefusedUnchanged(patchTomlDocument, codexConfig, { set: [{ keyPath: 'p.*.x', value: 1 }] }, 'JSON/JSONC only');
    // Bun 1.3.9 refuses TOML datetimes and \u0001-style escapes; Bun 1.4.3 reads datetimes as plain strings.
    // The editor refuses both itself, so every Bun version gives the same answer.
    for (const datetimeFile of ['d = 1979-05-27T07:32:00Z\n', 'd = 1979-05-27\n', 'd = 07:32:00\n', 'd = 1979-05-27 07:32:00\n', 'd = [1, 1979-05-27]\n', 'd = { at = 07:32:00 }\n']) {
      expectRefusedUnchanged(patchTomlDocument, datetimeFile, { set: [{ keyPath: 'y', value: 1 }] }, 'datetime');
    }
    expect(patchToml('d = "1979-05-27"\nn = -1_000\nf = 6.02e+23\nh = 0x1F\n', { set: [{ keyPath: 'y', value: 1 }] })).toBe('d = "1979-05-27"\nn = -1_000\nf = 6.02e+23\nh = 0x1F\ny = 1\n');
    expectRefusedUnchanged(patchTomlDocument, 'a = 1\n', { set: [{ keyPath: 'b', value: 'x\u0001' }] }, 'control character');
    expectRefusedUnchanged(patchTomlDocument, 'a = 1\n', { set: [{ keyPath: 'b', value: 'x\u007F' }] }, 'control character');
  });

  it('reads a date-shaped bare key inside an inline table as a key, not a datetime', () => {
    // `2023-04-01` is a valid bare key; only a value position holds a datetime. Bun 1.3.9 silently
    // reads `{ 2023-04-01 = "x" }` as `{ 2023 = 4, 01 = "x" }`, so the bare key is refused as a key
    // (not as a datetime) on every Bun version, and the quoted key is accepted.
    for (const dateShapedKeyFile of ['d = { 2023-04-01 = "x" }\n', 'd = { a = 1, 1979-05-27 = "x" }\n']) {
      expectRefusedUnchanged(patchTomlDocument, dateShapedKeyFile, { set: [{ keyPath: 'y', value: 1 }] }, 'date-shaped bare key');
    }
    expect(patchToml('d = { "2023-04-01" = "x" }\n', { set: [{ keyPath: 'y', value: 1 }] })).toBe('d = { "2023-04-01" = "x" }\ny = 1\n');
    expect(readTomlValueAtKeyPath(encoder.encode('d = { "2023-04-01" = "x", a = [1, 2] }\n'), 'd')).toEqual({ '2023-04-01': 'x', a: [1, 2] });
    // A datetime value inside an inline table, nested in an array, or on its own line in an array is still refused as a datetime.
    for (const datetimeFile of ['d = { "2023-04-01" = 1979-05-27 }\n', 'd = [{ k = 1 }, 1979-05-27]\n', 'd = { a = [1979-05-27] }\n', 'd = [\n  1979-05-27,\n]\n']) {
      expectRefusedUnchanged(patchTomlDocument, datetimeFile, { set: [{ keyPath: 'y', value: 1 }] }, 'datetime at offset');
    }
  });

  it('stays linear on hostile 1 MB inputs', () => {
    expectWithinBudget('brackets', () => patchToml('['.repeat(ONE_MEGABYTE), { set: [{ keyPath: 'a', value: 1 }] }));
    expectWithinBudget('unterminated multi-line string', () => patchToml(`a = """${'x'.repeat(ONE_MEGABYTE)}`, { set: [{ keyPath: 'a', value: 1 }] }));
    expectWithinBudget('quotes', () => patchToml('"'.repeat(ONE_MEGABYTE), { set: [{ keyPath: 'a', value: 1 }] }));
    expectWithinBudget('long multi-line string', () => patchToml(`a = """${'x\n'.repeat(ONE_MEGABYTE / 2)}"""\n[t]\n`, { set: [{ keyPath: 't.b', value: 1 }], delete: ['t'] }));
    expectWithinBudget('spaces in a key line', () => patchToml(`a${' '.repeat(ONE_MEGABYTE)}= 1\n`, { set: [{ keyPath: 'b', value: 1 }] }));
    expectWithinBudget('comment lines above a header', () => patchToml(`a = 1\n${'#\n'.repeat(ONE_MEGABYTE / 4)}[t]\nb = 1\n${'#\n'.repeat(ONE_MEGABYTE / 4)}[u]\n`, { delete: ['t'] }));
    expectWithinBudget('array with comments', () => patchToml(`a = [${'"#", # ]\n'.repeat(ONE_MEGABYTE / 10)}]\n`, { set: [{ keyPath: 'b', value: 1 }] }));
    // Bun.TOML.parse itself is quadratic in key count (about 0.5 s at 20,000 keys), so many-key files stay small here.
    // Bun 1.3.9's TOML parser segfaults (kills the process) on a dotted key of ~10,000 parts.
    expectRefusedUnchanged(patchTomlDocument, `a${'.a'.repeat(ONE_MEGABYTE / 2)} = 1\n`, { set: [{ keyPath: 'b', value: 1 }] }, 'dotted parts');
    expectRefusedUnchanged(patchTomlDocument, `[a${'.a'.repeat(20_000)}]\n`, { set: [{ keyPath: 'b', value: 1 }] }, 'dotted parts');
    expectRefusedUnchanged(patchTomlDocument, `x = {${'b.'.repeat(20_000)}b = 1}\n`, { set: [{ keyPath: 'b', value: 1 }] }, 'dotted parts');
    expect(patchToml('a = [1.5, 2.5, "x.y.z"] # a.b.c\n', { set: [{ keyPath: 'b', value: 1 }] })).toBe('a = [1.5, 2.5, "x.y.z"] # a.b.c\nb = 1\n');
    expectWithinBudget('5,000 tables', () => patchToml(Array.from({ length: 5_000 }, (_, index) => `[t${index}]\nk = ${index}\n\n`).join(''), { set: [{ keyPath: 't5.x', value: 1 }], delete: ['t7'] }));
  });
});

const gooseConfig = [
  '# goose',
  'GOOSE_PROVIDER: openai # provider',
  'OPENAI_HOST: https://api.openai.com',
  'extensions:',
  '  developer:',
  '    enabled: true',
  '    type: builtin',
  '',
  '  memory:',
  '    enabled: false',
  '# trailing',
  '',
].join('\n');

describe('YAML editor: byte-exact set → delete round trips', () => {
  function expectRoundTrip(original: string, keyPath: string, value: unknown, deleteKeyPath = keyPath): string {
    const withValue = patchYaml(original, { set: [{ keyPath, value }] });
    expect(withValue).not.toBe(original);
    expect(readYamlValueAtKeyPath(encoder.encode(withValue), keyPath)).toEqual(value);
    expect(patchYaml(withValue, { delete: [deleteKeyPath] })).toBe(original);
    return withValue;
  }

  it('top-level key, key in a nested mapping, new nested block mapping', () => {
    expect(expectRoundTrip(gooseConfig, 'OPENAI_BASE_PATH', 'v1/chat/completions')).toBe(gooseConfig.replace('    enabled: false\n', '    enabled: false\nOPENAI_BASE_PATH: v1/chat/completions\n'));
    expectRoundTrip(gooseConfig, 'extensions.memory.type', 'builtin');
    expect(expectRoundTrip(gooseConfig, 'extensions.claude-mem', { enabled: true, cmd: '/usr/bin/node', args: ['/a b/mcp.cjs'], timeout: 300 }))
      .toContain('    enabled: false\n  claude-mem:\n    enabled: true\n    cmd: /usr/bin/node\n    args: ["/a b/mcp.cjs"]\n    timeout: 300\n# trailing\n');
    expectRoundTrip(gooseConfig, 'mcp.servers.claude-mem.url', 'http://127.0.0.1:37677/mcp', 'mcp');
  });

  it('keeps CRLF, a byte order mark, a missing final line break, 4-space indents and a leading ---', () => {
    expectRoundTrip(gooseConfig.replaceAll('\n', '\r\n'), 'extensions.memory.type', 'builtin');
    expectRoundTrip(`\uFEFF${gooseConfig.replaceAll('\n', '\r\n')}`, 'x', 1);
    expectRoundTrip('a: 1', 'b', 2);
    expectRoundTrip('a:\n  b: 1', 'a.c', 2);
    expectRoundTrip('', 'a.b', 'c', 'a');
    expectRoundTrip('# only a comment\n', 'a', true);
    expect(expectRoundTrip('a:\n    b: 1\n', 'a.c.d', 2, 'a.c')).toBe('a:\n    b: 1\n    c:\n        d: 2\n');
    expectRoundTrip('---\na: 1\n', 'b', 2);
  });

  it('replaces values in place: a trailing comment stays; scalars, mappings, flow and block scalars swap', () => {
    expect(patchYaml(gooseConfig, { set: [{ keyPath: 'GOOSE_PROVIDER', value: 'anthropic' }] })).toBe(gooseConfig.replace('openai # provider', 'anthropic # provider'));
    expect(patchYaml(gooseConfig, { set: [{ keyPath: 'OPENAI_HOST', value: 'http://127.0.0.1:37677/r/goose' }] })).toBe(gooseConfig.replace('https://api.openai.com', 'http://127.0.0.1:37677/r/goose'));
    expect(patchYaml('a:\n  b: 1\n  c: 2\nd: 3\n', { set: [{ keyPath: 'a', value: 'x' }] })).toBe('a: x\nd: 3\n');
    expect(patchYaml('a: 1\nd: 3\n', { set: [{ keyPath: 'a.b', value: 'x' }] })).toBe('a:\n  b: x\nd: 3\n');
    expect(patchYaml('a: {b: 1}\n', { set: [{ keyPath: 'a', value: { c: 2 } }] })).toBe('a:\n  c: 2\n');
    expect(patchYaml('a: [1, 2]\n', { set: [{ keyPath: 'a', value: [3] }] })).toBe('a: [3]\n');
    expect(patchYaml('a: |\n  hi\n  # text, not a comment\nb: 1\n', { delete: ['a'] })).toBe('b: 1\n');
    expect(patchYaml('a:\n- 1\n- 2\nb: 3\n', { delete: ['a'] })).toBe('b: 3\n');
    expect(patchYaml("a: it's fine # c\n", { set: [{ keyPath: 'a', value: 'x' }] })).toBe('a: x # c\n');
  });

  it('quotes a string only when YAML would read it as something else', () => {
    expect(patchYaml('a: 1\n', { set: [{ keyPath: 'b', value: 'yes' }, { keyPath: 'c', value: '123' }, { keyPath: 'd', value: 'x: y' }, { keyPath: 'e', value: 'true' }, { keyPath: 'f', value: 'two words' }] }))
      .toBe('a: 1\nb: "yes"\nc: "123"\nd: "x: y"\ne: "true"\nf: "two words"\n');
  });

  it('quotes what a YAML 1.1 reader (PyYAML, yaml.v2) would read as a boolean or a number', () => {
    expect(patchYaml('a: 1\n', { set: [{ keyPath: 'on', value: 'off' }, { keyPath: 'b', value: '1:20' }, { keyPath: 'c', value: 'N' }, { keyPath: 'd', value: 'gpt-5' }] }))
      .toBe('a: 1\n"on": "off"\nb: "1:20"\nc: "N"\nd: gpt-5\n');
  });

  it('deleting a nested mapping\'s last key leaves it an empty mapping, which a later set fills again', () => {
    const emptied = patchYaml('a: 1\nextensions:\n  claude-mem:\n    cmd: x\n', { delete: ['extensions.claude-mem'] });
    expect(emptied).toBe('a: 1\nextensions: {}\n');
    expect(readYamlValueAtKeyPath(encoder.encode(emptied), 'extensions')).toEqual({});
    expect(patchYaml(emptied, { set: [{ keyPath: 'extensions.claude-mem.cmd', value: 'x' }] })).toBe('a: 1\nextensions:\n  claude-mem:\n    cmd: x\n');
  });

  it('blank lines at the end of a block scalar belong to it: a new key goes after them', () => {
    const keep = 'a: |+\n  hello\n\n';
    const withKey = expectRoundTrip(keep, 'b', 1);
    expect(withKey).toBe('a: |+\n  hello\n\nb: 1\n');
    expect(readYamlValueAtKeyPath(encoder.encode(withKey), 'a')).toBe('hello\n\n');
    const nested = 'x:\n  a: |+\n    hi\n\n\ny: 1\n';
    const withNestedKey = expectRoundTrip(nested, 'x.b', 1);
    expect(withNestedKey).toBe('x:\n  a: |+\n    hi\n\n\n  b: 1\ny: 1\n');
    expect(readYamlValueAtKeyPath(encoder.encode(withNestedKey), 'x.a')).toBe('hi\n\n\n');
    expect(patchYaml('a: >-\n  folded\n\nb: 1\n', { delete: ['a'] })).toBe('b: 1\n');
    // A value replacing a block scalar leaves its trailing blank lines in place, as separators.
    expect(patchYaml('a: |\n  hi\n\nb: 1\n', { set: [{ keyPath: 'a', value: 'x' }] })).toBe('a: x\n\nb: 1\n');
    expect(patchYaml('p:\n  a: |\n    hi\n\nb: 1\n', { delete: ['p.a'] })).toBe('p: {}\n\nb: 1\n');
  });

  it('refuses anchors, aliases, several documents, flow-mapping parents and other unsafe edits, unchanged', () => {
    expectRefusedUnchanged(patchYamlDocument, 'model:\n  default: &chosen old\nother: *chosen\n', { set: [{ keyPath: 'model.default', value: 'n' }] }, 'anchor');
    expectRefusedUnchanged(patchYamlDocument, 'a: &x 1\nb: *x\n', { delete: ['b'] }, 'anchor');
    expectRefusedUnchanged(patchYamlDocument, 'base: &b {x: 1}\nc:\n  <<: *b\n', { set: [{ keyPath: 'd', value: 1 }] }, 'edit the file by hand');
    expectRefusedUnchanged(patchYamlDocument, 'a: 1\n---\nb: 2\n', { set: [{ keyPath: 'c', value: 1 }] }, 'second YAML document');
    expectRefusedUnchanged(patchYamlDocument, 'a: 1\n...\n', { set: [{ keyPath: 'c', value: 1 }] }, 'ends a YAML document');
    expectRefusedUnchanged(patchYamlDocument, '%YAML 1.2\n---\na: 1\n', { set: [{ keyPath: 'c', value: 1 }] }, 'directive');
    expectRefusedUnchanged(patchYamlDocument, 'a: {b: 1}\n', { set: [{ keyPath: 'a.c', value: 1 }] }, 'flow mapping');
    expectRefusedUnchanged(patchYamlDocument, 'a: {b: 1}\n', { delete: ['a.b'] }, 'flow mapping');
    expectRefusedUnchanged(patchYamlDocument, 'a:\n  - b: 1\n', { set: [{ keyPath: 'a.c', value: 1 }] }, 'is a list');
    expectRefusedUnchanged(patchYamlDocument, 'a: 1\na: 2\n', { set: [{ keyPath: 'b', value: 1 }] }, 'written twice');
    expectRefusedUnchanged(patchYamlDocument, '- a\n- b\n', { set: [{ keyPath: 'b', value: 1 }] }, 'not a mapping');
    expectRefusedUnchanged(patchYamlDocument, 'a: [\n', { set: [{ keyPath: 'b', value: 1 }] }, 'invalid YAML');
    // Bun 1.3.9 reads a tab-indented line; Bun 1.4.3 refuses it. The editor refuses it itself, first.
    expectRefusedUnchanged(patchYamlDocument, 'a:\n\tb: 1\n', { set: [{ keyPath: 'b', value: 1 }] }, 'a tab indents line 2');
  });

  it('stays linear on hostile 1 MB inputs', () => {
    expectWithinBudget('spaces in a value', () => patchYaml(`a: ${' '.repeat(ONE_MEGABYTE)}b\n`, { set: [{ keyPath: 'c', value: 1 }] }));
    expectWithinBudget('hashes', () => patchYaml(`a: ${'#'.repeat(ONE_MEGABYTE)}\n`, { set: [{ keyPath: 'c', value: 1 }] }));
    expectWithinBudget('apostrophes', () => patchYaml(`a: x${" '".repeat(ONE_MEGABYTE / 2)}\n`, { set: [{ keyPath: 'c', value: 1 }] }));
    expectWithinBudget('colons in a key', () => patchYaml(`a${':a'.repeat(ONE_MEGABYTE / 2)}: 1\n`, { set: [{ keyPath: 'c', value: 1 }] }));
    expectWithinBudget('block scalar of comment-like lines', () => patchYaml(`a: |\n${'  # x\n'.repeat(ONE_MEGABYTE / 6)}b: 1\n`, { set: [{ keyPath: 'c', value: 1 }] }));
    expectWithinBudget('blank lines of spaces', () => patchYaml(`${'          \n'.repeat(ONE_MEGABYTE / 11)}a: 1\n`, { set: [{ keyPath: 'c', value: 1 }] }));
    expectWithinBudget('60,000 keys', () => patchYaml(`m:\n${Array.from({ length: 60_000 }, (_, index) => `  k${index}: ${index}\n`).join('')}`, { set: [{ keyPath: 'm.zz', value: 1 }], delete: ['m.k5'] }));
    expectWithinBudget('deep nesting', () => patchYaml(`${Array.from({ length: 2_000 }, (_, index) => `${' '.repeat(index)}k${index}:\n`).join('')}${' '.repeat(2_000)}v: 1\n`, { set: [{ keyPath: 'k0.x', value: 1 }] }));
  });
});
