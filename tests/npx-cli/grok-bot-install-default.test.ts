import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { resolveInstallerProviderChoice } from '../../src/npx-cli/installer-provider-choice';

const repoRoot = join(__dirname, '..', '..');

describe('grok-bot install default provider', () => {
  it('uses saved/default credentials when grok-bot has no --provider', () => {
    expect(resolveInstallerProviderChoice({ ide: 'grok-bot' })).toBeUndefined();
  });

  it('keeps --provider host as an explicit grok-bot opt-in', () => {
    expect(resolveInstallerProviderChoice({ ide: 'grok-bot', provider: 'host' })).toBe('host');
  });

  it('does not invent a non-interactive default for other IDEs', () => {
    expect(resolveInstallerProviderChoice({ ide: 'cursor' })).toBeUndefined();
    expect(resolveInstallerProviderChoice({ ide: 'claude-code' })).toBeUndefined();
    expect(resolveInstallerProviderChoice({})).toBeUndefined();
  });

  it('documents installation from the fork without a cloud account', () => {
    const skill = readFileSync(join(repoRoot, 'claude-mem-grok-bot/skills/install/SKILL.md'), 'utf-8');
    expect(skill).toContain('bun dist/npx-cli/index.js install --ide grok-bot');
    expect(skill).toContain('No CMEM account or trial is required');
    expect(skill).toContain('--provider host');
    expect(skill).not.toContain('cmem-observer');
  });
});
