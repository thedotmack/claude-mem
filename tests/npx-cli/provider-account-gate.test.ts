import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { providerNeedsAccount } from '../../src/npx-cli/commands/install.js';

const source = readFileSync(
  join(__dirname, '..', '..', 'src', 'npx-cli', 'commands', 'install.ts'),
  'utf-8',
);

describe('provider account gate', () => {
  it('exempts local subscription and host installs from the account requirement', () => {
    expect(providerNeedsAccount('claude')).toBe(false);
    expect(providerNeedsAccount('codex')).toBe(false);
    expect(providerNeedsAccount('host')).toBe(false);
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
