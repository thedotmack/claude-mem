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
    // `undefined` means the choice is still open and can still land on CMEM Pro,
    // so this flag alone cannot exempt the install. It does NOT mean login runs
    // first: the interactive path resolves the choice before any login, and only
    // the CMEM branch reaches OAuth.
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

  it('gates the OAuth login call behind the resolved provider choice', () => {
    // Pins two regressions. The login call was once unconditional, so any
    // cmem.ai outage hard-blocked every install. It was then made conditional
    // but ran BEFORE the provider prompt, so every interactive user paid for a
    // browser round trip regardless of what they went on to pick. The gate now
    // reads the already-resolved choice: the flag path still defers to
    // providerNeedsAccount, and the prompt path narrows to the CMEM branch.
    expect(source).toContain('const providerChoice = await promptProviderChoice(options);');
    expect(source).toMatch(
      /const choiceNeedsAccount = options\.provider\s*\n\s*\? providerNeedsAccount\(options\.provider\)\s*\n\s*: providerChoice === 'cmem';/,
    );
    expect(source).toMatch(
      /if \(choiceNeedsAccount\) \{\s*\n\s*oauthPairing = await requireInstallerOAuthLogin\(version\);/,
    );
    // The choice step itself must stay free of the pairing entirely.
    expect(source).toContain('async function promptProviderChoice(options: InstallOptions): Promise<ProviderChoice>');
  });

  it('refuses CMEM Pro enrollment without a pairing', () => {
    expect(source).toContain("throw new Error('CMEM Pro requires a signed-in claude-mem account.');");
  });
});
