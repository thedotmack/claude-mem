import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { providerNeedsAccount } from '../../src/npx-cli/commands/install.js';

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

describe('install help text (#4131)', () => {
  const help = readFileSync(join(__dirname, '..', '..', 'src', 'npx-cli', 'index.ts'), 'utf-8');
  const providerLine = help.split('\n').find((line) => line.includes('install --provider'));

  // A headless `--runtime server --provider openrouter` install blocked on a
  // browser login the help never mentioned.
  it('says which providers need a cmem.ai sign-in, matching providerNeedsAccount', () => {
    expect(providerLine).toBeDefined();
    expect(providerLine).toContain('codex, gemini and openrouter need a cmem.ai sign-in');
    expect(providerLine).toContain('claude and host need no claude-mem account');
  });
});
