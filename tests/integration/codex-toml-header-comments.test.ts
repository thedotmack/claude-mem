import { expect, it } from 'bun:test';
import { codexConfigAfterLibraryWrite } from '../helpers/codex-config-through-library.js';

// Codex's config.toml is edited by the Library through the Phase 7 TOML
// editor, which reads structure (comments, quoted keys, multi-line strings)
// rather than lines.

it('updates an existing commented features table without duplicating it', () => {
  const input = '[features] # existing operator config\nhooks = false\nother = true\n';
  const output = codexConfigAfterLibraryWrite(input);
  expect((Bun.TOML.parse(output) as any).features).toEqual({ hooks: true, other: true });
  expect(output).toContain('[features] # existing operator config');
});

it('updates an existing commented plugin table', () => {
  const input = '[plugins."claude-mem@claude-mem-local"] # configured seat\nenabled = false\n';
  const output = codexConfigAfterLibraryWrite(input);
  expect((Bun.TOML.parse(output) as any).plugins['claude-mem@claude-mem-local']).toEqual({ enabled: true });
  expect(output).toContain('# configured seat');
});

it('removes a commented legacy claude-mem server table', () => {
  const input = '[mcp_servers."mcp-search"] # installed legacy server\ncommand = "bun"\nargs = ["claude-mem/mcp-server.cjs"]\n[mcp_servers.other] # unrelated\ncommand = "other-server"\n';
  const output = codexConfigAfterLibraryWrite(input);
  expect((Bun.TOML.parse(output) as any).mcp_servers).toEqual({ other: { command: 'other-server' } });
});

// What Bun.TOML reads the instructions as (Bun 1.3.9 keeps the newline right
// after an opening delimiter, which TOML trims); the edit must leave it unchanged.
const instructionsAsParsed = (input: string) => (Bun.TOML.parse(input) as { developer_instructions?: string; features?: { developer_instructions?: string } });

// TOML trims a newline that immediately follows an opening multi-line delimiter.
// Bun.TOML.parse up to at least 1.3.9 keeps it, so normalize that one character
// to keep these assertions about the installer, not the local Bun parser version.
const multilineStringValue = (parsedValue: string) => parsedValue.replace(/^\n/, '');

for (const delimiter of ['"""', "'''"]) {
  it(`preserves feature and legacy-server examples inside ${delimiter} instructions`, () => {
    const instructions = '[features] # example\nhooks = false\n[mcp_servers."mcp-search"] # example\nargs = ["claude-mem/example"]';
    const input = `developer_instructions = ${delimiter}\n${instructions}\n${delimiter}\n[features] # real table\nhooks = false\n[mcp_servers."mcp-search"] # real legacy server\nargs = ["claude-mem/mcp-server.cjs"]\n[mcp_servers.other]\ncommand = "other-server"\n`;
    const parsed = Bun.TOML.parse(codexConfigAfterLibraryWrite(input)) as any;
    expect(parsed.developer_instructions).toBe(instructionsAsParsed(input).developer_instructions!);
    expect(parsed.developer_instructions).toContain(instructions);
    expect(parsed.features.hooks).toBe(true);
    expect(parsed.mcp_servers).toEqual({ other: { command: 'other-server' } });
  });

  it(`does not replace an example key or terminate the real table inside ${delimiter}`, () => {
    const instructions = 'hooks = false\n[features] # example';
    const input = `[features]\ndeveloper_instructions = ${delimiter}\n${instructions}\n${delimiter}\nother = true\n`;
    const parsed = Bun.TOML.parse(codexConfigAfterLibraryWrite(input)) as any;
    expect(parsed.features).toEqual({ hooks: true, other: true, developer_instructions: instructionsAsParsed(input).features!.developer_instructions! });
  });

  it(`adds a real feature table when only a ${delimiter} example exists`, () => {
    const instructions = '[features] # example\nhooks = false';
    const input = `developer_instructions = ${delimiter}\n${instructions}\n${delimiter}\n`;
    const output = codexConfigAfterLibraryWrite(input);
    const parsed = Bun.TOML.parse(output) as any;
    expect(parsed.developer_instructions).toBe(instructionsAsParsed(input).developer_instructions!);
    expect(parsed.features.hooks).toBe(true);
    expect(output.startsWith(input)).toBe(true);
  });
}
