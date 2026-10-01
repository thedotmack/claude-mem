// `--provider codex` is a bring-your-own option, like `--provider claude`. It
// must not change the sign-in funnel: the interactive menu stays CMEM Pro
// (pre-selected) and Claude, and a non-interactive Codex install still ends
// with the deferred sign-in link.
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

  it('skips the blocking sign-in for --provider codex, like --provider claude', () => {
    expect(providerNeedsAccount('codex')).toBe(false);
    expect(providerNeedsAccount('claude')).toBe(false);
    expect(providerNeedsAccount(undefined)).toBe(true);
  });

  it('still offers the deferred sign-in link at the end of a non-interactive --provider codex install', () => {
    const start = installSource.indexOf('export async function offerDeferredLogin(');
    expect(start).toBeGreaterThan(-1);
    const helper = installSource.slice(start, installSource.indexOf('\n}\n', start));
    // The offer is skipped only for an install that already signed in, and
    // providerNeedsAccount('codex') is false, so a Codex install reaches it.
    expect(helper).toContain('if (providerNeedsAccount(options.provider)) return;');
    expect(helper).not.toContain('codex');
    expect(installSource).toContain('await offerDeferredLogin(options, version)');
  });
});
