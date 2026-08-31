import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { providerNeedsAccount } from '../../src/npx-cli/commands/install.js';

describe('provider account gate', () => {
  it('exempts an explicit --provider claude from the account requirement', () => {
    // `claude` runs memory on the user's own Anthropic plan and never contacts
    // cmem.ai, so a cmem.ai outage must not fail this install.
    expect(providerNeedsAccount('claude')).toBe(false);
  });

  it('still requires an account when no provider was named', () => {
    // The provider screen can still offer CMEM Pro, so login has to come first.
    expect(providerNeedsAccount(undefined)).toBe(true);
  });

  it('still requires an account for openrouter', () => {
    // openrouter is the transport for the cmem gateway, so an explicit
    // openrouter install may still be reaching cmem.ai.
    expect(providerNeedsAccount('openrouter')).toBe(true);
  });

  it('still requires an account for gemini', () => {
    expect(providerNeedsAccount('gemini')).toBe(true);
  });
});

describe('install flow wiring', () => {
  const source = readFileSync(
    join(__dirname, '..', '..', 'src', 'npx-cli', 'commands', 'install.ts'),
    'utf-8',
  );

  it('gates the OAuth login call behind providerNeedsAccount', () => {
    // Pins the regression this fixes: the login call was previously
    // unconditional, so any cmem.ai outage hard-blocked every install.
    expect(source).toContain('if (providerNeedsAccount(options.provider)) {');
    expect(source).toMatch(
      /if \(providerNeedsAccount\(options\.provider\)\) \{\s*\n\s*oauthPairing = await requireInstallerOAuthLogin\(version\);/,
    );
  });

  it('refuses CMEM Pro enrollment without a pairing', () => {
    expect(source).toContain("throw new Error('CMEM Pro requires a signed-in claude-mem account.');");
  });
});
