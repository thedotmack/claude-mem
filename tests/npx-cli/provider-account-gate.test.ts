import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const source = readFileSync(
  join(__dirname, '..', '..', 'src', 'npx-cli', 'commands', 'install.ts'),
  'utf-8',
);

describe('provider account gate', () => {
  it('exempts explicit claude and host installs from the account requirement', () => {
    expect(source).toContain("return provider !== 'claude' && provider !== 'host';");
  });

  it('still requires an account when no provider was named', () => {
    expect(source).toContain('if (providerNeedsAccount(options.provider)) {');
  });

  it('still treats openrouter and gemini as account-backed providers', () => {
    expect(source).toContain("if (options.provider !== 'gemini' && options.provider !== 'openrouter') return;");
  });
});

describe('install flow wiring', () => {
  it('gates the OAuth login call behind providerNeedsAccount', () => {
    expect(source).toMatch(
      /if \(providerNeedsAccount\(options\.provider\)\) \{\s*\n\s*oauthPairing = await requireInstallerOAuthLogin\(version\);/,
    );
  });

  it('never runs the blocking OAuth login for a persisted non-interactive provider', () => {
    // A non-TTY run that reused CLAUDE_MEM_PROVIDER=openrouter|gemini from
    // settings must not enter requireInstallerOAuthLogin: it would open a
    // browser in an agent shell and poll until the pairing expires.
    const gateStart = source.indexOf('let oauthPairing: InstallerOAuthPairing | null = null;');
    const gateEnd = source.indexOf('const selectedProvider = await promptProvider(options, oauthPairing, version);');
    expect(gateStart).toBeGreaterThan(-1);
    expect(gateEnd).toBeGreaterThan(gateStart);
    const gate = source.slice(gateStart, gateEnd);
    const persistedBranch = gate.indexOf("if (options.providerSource === 'persisted') {");
    const oauthCall = gate.indexOf('oauthPairing = await requireInstallerOAuthLogin(version);');
    expect(persistedBranch).toBeGreaterThan(-1);
    expect(persistedBranch).toBeLessThan(oauthCall);
    expect(gate.slice(persistedBranch, oauthCall)).toContain('} else if (providerNeedsAccount(options.provider)) {');
    expect(gate.slice(persistedBranch, gate.indexOf('} else if'))).not.toContain('requireInstallerOAuthLogin');
    expect(gate).toContain('keeping the existing account');
    // promptProvider must also short-circuit for the same source so nothing enrolls.
    expect(source).toContain("if (options.providerSource === 'persisted' && options.provider) {");
  });

  it('refuses CMEM Pro enrollment without a pairing', () => {
    expect(source).toContain("throw new Error('CMEM Pro requires a signed-in claude-mem account.');");
  });
});
