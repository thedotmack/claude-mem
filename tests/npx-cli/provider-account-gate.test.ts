import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { providerNeedsAccount } from '../../src/npx-cli/commands/install';

const source = readFileSync(
  join(__dirname, '..', '..', 'src', 'npx-cli', 'commands', 'install.ts'),
  'utf-8',
);

describe('provider account gate', () => {
  it('exempts explicit claude, codex and host installs from the account requirement', () => {
    for (const provider of ['claude', 'codex', 'host'] as const) {
      expect(providerNeedsAccount(provider)).toBe(false);
    }
  });

  it('still requires an account when no provider was named', () => {
    expect(providerNeedsAccount(undefined)).toBe(true);
    expect(source).toContain('if (providerNeedsAccount(options.provider)) {');
  });

  it('still treats openrouter and gemini as account-backed providers', () => {
    expect(providerNeedsAccount('openrouter')).toBe(true);
    expect(providerNeedsAccount('gemini')).toBe(true);
    expect(source).toContain("if (options.provider !== 'gemini' && options.provider !== 'openrouter') return;");
  });
});

describe('install flow wiring', () => {
  it('gates the OAuth login call behind providerNeedsAccount', () => {
    expect(source).toMatch(
      /if \(providerNeedsAccount\(options\.provider\)\) \{\s*\n\s*oauthPairing = await requireInstallerOAuthLogin\(version\);/,
    );
  });

  it('refuses CMEM Pro enrollment without a pairing', () => {
    expect(source).toContain("throw new Error('CMEM Pro requires a signed-in claude-mem account.');");
  });
});
