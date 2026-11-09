import { expect, it } from 'bun:test';
import { patchTomlDocument } from '../../src/services/wire-gateway/edit/toml-editor.js';
import { codexConfigAfterLibraryWrite } from '../helpers/codex-config-through-library.js';

// Codex's config.toml settings are written through the Library's TOML editor
// (CodexCliInstaller writeCodexPluginConfig). An existing key spelled with
// quotes or escapes is the same key, so it is updated in place (#5212).

/** One boolean set through the TOML editor the Library uses; `keys` are literal (dots and backslashes are escaped). */
function setTomlBoolean(input: string, keys: string[], value: boolean): string {
  const keyPath = keys.map((key) => key.replace(/[\\.]/g, (character) => `\\${character}`)).join('.');
  return new TextDecoder().decode(patchTomlDocument(new TextEncoder().encode(input), { set: [{ keyPath, value }] }));
}

for (const spelling of ['"enabled"', "'enabled'", String.raw`"\u0065nabled"`, String.raw`"\U00000065nabled"`]) {
  it(`updates the existing plugin boolean spelled ${spelling}`, () => {
    const input = `[plugins."claude-mem@thedotmack"] # operator config\n${spelling} = false\nother = "keep"\n`;
    expect(Bun.TOML.parse(input)).toEqual({ plugins: { 'claude-mem@thedotmack': { enabled: false, other: 'keep' } } });
    const output = setTomlBoolean(input, ['plugins', 'claude-mem@thedotmack', 'enabled'], true);
    expect(Bun.TOML.parse(output)).toEqual({ plugins: { 'claude-mem@thedotmack': { enabled: true, other: 'keep' } } });
    expect(setTomlBoolean(output, ['plugins', 'claude-mem@thedotmack', 'enabled'], true)).toBe(output);
  });
}

for (const header of ['["features"]', "['features']", '[ features ]', String.raw`["\u0066eatures"]`]) {
  it(`updates the existing hooks table spelled ${header}`, () => {
    const input = `${header} # existing\n'hooks' = false\nother = true\n`;
    expect(Bun.TOML.parse(input)).toEqual({ features: { hooks: false, other: true } });
    const output = setTomlBoolean(input, ['features', 'hooks'], true);
    expect(Bun.TOML.parse(output)).toEqual({ features: { hooks: true, other: true } });
    expect(setTomlBoolean(output, ['features', 'hooks'], true)).toBe(output);
  });
}

it('the Codex installer turns on the hooks feature spelled with a quoted table and key', () => {
  const output = codexConfigAfterLibraryWrite(`["features"] # existing\n'hooks' = false\nother = true\n`);
  expect((Bun.TOML.parse(output) as any).features).toEqual({ hooks: true, other: true });
});

it('matches quoted plugin path components without touching a dotted sibling', () => {
  const input = '[plugins.fixture.dot]\nenabled = false\n[ "plugins" . \'fixture.dot\' ] # selected\n"enabled" = false\n';
  const output = setTomlBoolean(input, ['plugins', 'fixture.dot', 'enabled'], true);
  expect(Bun.TOML.parse(output)).toEqual({ plugins: { fixture: { dot: { enabled: false } }, 'fixture.dot': { enabled: true } } });
});

it('keeps whitespace and hashes inside literal plugin names significant', () => {
  const input = "[plugins.'fixture #one']\nenabled = false\n[plugins.'fixture#one']\nenabled = false\n";
  const output = setTomlBoolean(input, ['plugins', 'fixture #one', 'enabled'], true);
  expect(Bun.TOML.parse(output)).toEqual({ plugins: { 'fixture #one': { enabled: true }, 'fixture#one': { enabled: false } } });
});

it('recognizes literal backslashes without interpreting them as basic-string escapes', () => {
  const input = String.raw`[plugins.'fixture\plugin']
'enabled' = false
`;
  expect(Bun.TOML.parse(setTomlBoolean(input, ['plugins', String.raw`fixture\plugin`, 'enabled'], true))).toEqual({ plugins: { [String.raw`fixture\plugin`]: { enabled: true } } });
});

for (const delimiter of ['"""', "'''"]) {
  it(`preserves quoted-key examples in ${delimiter} instructions`, () => {
    const example = '["features"]\n"hooks" = false';
    const input = `developer_instructions = ${delimiter}\n${example}\n${delimiter}\n[features] # real\n"hooks" = false\nother = true\n`;
    const output = setTomlBoolean(input, ['features', 'hooks'], true);
    const parsed = Bun.TOML.parse(output) as any;
    expect(parsed.developer_instructions.replace(/^\n/, '')).toBe(example + '\n');
    expect(parsed.features).toEqual({ hooks: true, other: true });
  });
}
