import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { providerNeedsAccount } from '../../src/npx-cli/commands/install.js';

const source = readFileSync(
  join(__dirname, '..', '..', 'src', 'npx-cli', 'commands', 'install.ts'),
  'utf-8',
);

describe('provider account gate', () => {
  it('exempts the local Anthropic plan and host installs from the account requirement', () => {
    expect(providerNeedsAccount('claude')).toBe(false);
    expect(providerNeedsAccount('host')).toBe(false);
  });

  it('still requires an account when no provider was named', () => {
    expect(providerNeedsAccount(undefined)).toBe(true);
  });

  it('still treats openrouter, gemini and codex as account-backed providers', () => {
    expect(providerNeedsAccount('openrouter')).toBe(true);
    expect(providerNeedsAccount('gemini')).toBe(true);
    expect(providerNeedsAccount('codex')).toBe(true);
  });
});

describe('install flow wiring', () => {
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
    // And the summary must not claim a login that never ran.
    const summaryStart = source.indexOf('const accountStatus = ');
    const summaryEnd = source.indexOf(';', summaryStart);
    const summary = source.slice(summaryStart, summaryEnd);
    expect(summary).toContain('const accountStatus = oauthPairing');
    // Order matters: the pairing decides first, then a provider that needs no
    // account reports "not required" before the persisted branch can call a
    // local claude/host config a kept account.
    const pairingIdx = summary.indexOf('oauthPairing');
    const noAccountIdx = summary.indexOf('!providerNeedsAccount(options.provider)');
    const persistedIdx = summary.indexOf("options.providerSource === 'persisted'");
    expect(pairingIdx).toBeGreaterThan(-1);
    expect(noAccountIdx).toBeGreaterThan(pairingIdx);
    expect(persistedIdx).toBeGreaterThan(noAccountIdx);
    expect(summary.slice(noAccountIdx, persistedIdx)).toContain("'Not required (local provider)'");
    expect(summary.slice(persistedIdx)).toContain("'Kept existing account (no login this run)'");
  });
});

describe('install help text (#4131)', () => {
  const help = readFileSync(join(__dirname, '..', '..', 'src', 'npx-cli', 'index.ts'), 'utf-8');
  const providerLine = help.split('\n').find((line) => line.includes('install --provider'));

  // A headless `--runtime server --provider openrouter` install blocked on a
  // browser login the help never mentioned.
  it('says which providers need a cmem.ai sign-in, matching providerNeedsAccount', () => {
    expect(providerLine).toBeDefined();
    for (const provider of ['codex', 'gemini', 'openrouter'] as const) {
      expect(providerNeedsAccount(provider)).toBe(true);
    }
    expect(providerLine).toContain('codex, gemini and openrouter need a cmem.ai sign-in');
    expect(providerLine).toContain('claude and host need no claude-mem account');
  });
});
