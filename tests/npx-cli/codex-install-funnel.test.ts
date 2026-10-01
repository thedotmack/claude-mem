// `--provider codex` is a bring-your-own option, like `--provider gemini`. It
// must not change the sign-in funnel: the interactive menu stays CMEM Pro
// (pre-selected) and Claude, and a Codex install signs in like any other
// bring-your-own provider. #4216 had exempted it from the sign-in (Wave 3 gate
// R4-4); the plan's verdict for that PR was "flag + viewer only".
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { providerNeedsAccount } from '../../src/npx-cli/commands/install.js';

const installSource = readFileSync(join(__dirname, '..', '..', 'src', 'npx-cli', 'commands', 'install.ts'), 'utf-8');

describe('Codex install keeps the sign-in funnel', () => {
  it('leaves the interactive provider menu at CMEM Pro (pre-selected) and Claude', () => {
    const start = installSource.indexOf('await p.multiselect<ProviderChoice>(');
    expect(start).toBeGreaterThan(-1);
    const menu = installSource.slice(start, installSource.indexOf('required: true', start));
    expect(menu).toContain("{ value: 'cmem'");
    expect(menu).toContain("{ value: 'claude'");
    expect(menu).toContain("initialValues: ['cmem']");
    expect(menu).not.toContain('codex');
  });

  it('runs the blocking sign-in for --provider codex, like the other bring-your-own providers', () => {
    expect(providerNeedsAccount('codex')).toBe(true);
    expect(providerNeedsAccount('gemini')).toBe(true);
    expect(providerNeedsAccount('openrouter')).toBe(true);
    // Only the local Anthropic plan and the host observer skip it.
    expect(providerNeedsAccount('claude')).toBe(false);
    expect(providerNeedsAccount('host')).toBe(false);
  });

  it('routes a --provider codex install to the sign-in, never to a skip', () => {
    const gateStart = installSource.indexOf('let oauthPairing: InstallerOAuthPairing | null = null;');
    const gateEnd = installSource.indexOf('const selectedProvider = await promptProvider(options, oauthPairing, version);');
    expect(gateStart).toBeGreaterThan(-1);
    expect(gateEnd).toBeGreaterThan(gateStart);
    const gate = installSource.slice(gateStart, gateEnd);
    expect(gate).toMatch(
      /\} else if \(providerNeedsAccount\(options\.provider\)\) \{\s*\n\s*oauthPairing = await requireInstallerOAuthLogin\(version\);/,
    );
    // The skip branch names only the providers that need no account.
    expect(gate.slice(gate.indexOf('const skipReason'))).not.toContain('codex');
  });

  it('keeps the deferred sign-in link for installs that skipped the sign-in, which a Codex install no longer does', () => {
    const start = installSource.indexOf('export async function offerDeferredLogin(');
    expect(start).toBeGreaterThan(-1);
    const helper = installSource.slice(start, installSource.indexOf('\n}\n', start));
    expect(helper).toContain('if (providerNeedsAccount(options.provider)) return;');
    expect(helper).not.toContain('codex');
  });
});
