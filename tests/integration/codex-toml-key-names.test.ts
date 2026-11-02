import { expect, it } from 'bun:test';
import { setTomlFeatureEnabled, setTomlPluginEnabled } from '../../src/services/integrations/CodexCliInstaller.js';

for (const spelling of ['"enabled"', "'enabled'", String.raw`"\u0065nabled"`, String.raw`"\U00000065nabled"`]) {
  it(`updates the existing plugin boolean spelled ${spelling}`, () => {
    const input = `[plugins."claude-mem@thedotmack"] # operator config\n${spelling} = false\nother = "keep"\n`;
    expect(Bun.TOML.parse(input)).toEqual({ plugins: { 'claude-mem@thedotmack': { enabled: false, other: 'keep' } } });
    const output = setTomlPluginEnabled(input, 'claude-mem@thedotmack', true);
    expect(Bun.TOML.parse(output)).toEqual({ plugins: { 'claude-mem@thedotmack': { enabled: true, other: 'keep' } } });
    expect(setTomlPluginEnabled(output, 'claude-mem@thedotmack', true)).toBe(output);
  });
}

for (const header of ['["features"]', "['features']", '[ features ]', String.raw`["\u0066eatures"]`]) {
  it(`updates the existing hooks table spelled ${header}`, () => {
    const input = `${header} # existing\n'hooks' = false\nother = true\n`;
    expect(Bun.TOML.parse(input)).toEqual({ features: { hooks: false, other: true } });
    const output = setTomlFeatureEnabled(input, 'hooks', true);
    expect(Bun.TOML.parse(output)).toEqual({ features: { hooks: true, other: true } });
    expect(setTomlFeatureEnabled(output, 'hooks', true)).toBe(output);
  });
}

it('matches quoted plugin path components without touching a dotted sibling', () => {
  const input = '[plugins.fixture.dot]\nenabled = false\n[ "plugins" . \'fixture.dot\' ] # selected\n"enabled" = false\n';
  const output = setTomlPluginEnabled(input, 'fixture.dot', true);
  expect(Bun.TOML.parse(output)).toEqual({ plugins: { fixture: { dot: { enabled: false } }, 'fixture.dot': { enabled: true } } });
});

it('keeps whitespace and hashes inside literal plugin names significant', () => {
  const input = "[plugins.'fixture #one']\nenabled = false\n[plugins.'fixture#one']\nenabled = false\n";
  const output = setTomlPluginEnabled(input, 'fixture #one', true);
  expect(Bun.TOML.parse(output)).toEqual({ plugins: { 'fixture #one': { enabled: true }, 'fixture#one': { enabled: false } } });
});

it('recognizes literal backslashes without interpreting them as basic-string escapes', () => {
  const input = String.raw`[plugins.'fixture\plugin']
'enabled' = false
`;
  expect(Bun.TOML.parse(setTomlPluginEnabled(input, String.raw`fixture\plugin`, true))).toEqual({ plugins: { [String.raw`fixture\plugin`]: { enabled: true } } });
});

for (const delimiter of ['"""', "'''"]) {
  it(`preserves quoted-key examples in ${delimiter} instructions`, () => {
    const example = '["features"]\n"hooks" = false';
    const input = `developer_instructions = ${delimiter}\n${example}\n${delimiter}\n[features] # real\n"hooks" = false\nother = true\n`;
    const output = setTomlFeatureEnabled(input, 'hooks', true);
    const parsed = Bun.TOML.parse(output) as any;
    expect(parsed.developer_instructions.replace(/^\n/, '')).toBe(example + '\n');
    expect(parsed.features).toEqual({ hooks: true, other: true });
  });
}
