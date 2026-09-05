import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { resolveInstallerProviderChoice } from '../../src/npx-cli/installer-provider-choice';

const repoRoot = join(__dirname, '..', '..');

describe('grok-bot install default provider', () => {
  it('defaults --ide grok-bot with no --provider to CMEM Pro', () => {
    expect(resolveInstallerProviderChoice({ ide: 'grok-bot' })).toBe('cmem');
  });

  it('keeps --provider host as an explicit grok-bot opt-in', () => {
    expect(resolveInstallerProviderChoice({ ide: 'grok-bot', provider: 'host' })).toBe('host');
  });

  it('does not invent a non-interactive default for other IDEs', () => {
    expect(resolveInstallerProviderChoice({ ide: 'cursor' })).toBeUndefined();
    expect(resolveInstallerProviderChoice({ ide: 'claude-code' })).toBeUndefined();
    expect(resolveInstallerProviderChoice({})).toBeUndefined();
  });

  it('documents CMEM Pro as the grok-bot plugin default and host as opt-in', () => {
    const skill = readFileSync(join(repoRoot, 'claude-mem-grok-bot/skills/install/SKILL.md'), 'utf-8');
    const readme = readFileSync(join(repoRoot, 'claude-mem-grok-bot/README.md'), 'utf-8');
    const defaultSection = skill.split('## Optional')[0];

    expect(defaultSection).toContain('npx claude-mem install --ide grok-bot');
    expect(defaultSection).not.toContain('npx claude-mem install --ide grok-bot --provider host');
    expect(defaultSection).toContain('https://cmem.ai/api/inference/v1');
    expect(defaultSection).toContain('cmem-observer');
    expect(defaultSection.toLowerCase()).not.toContain('host-login observer (default)');
    expect(skill).toContain('npx claude-mem install --ide grok-bot --provider host');
    expect(readme).toContain('npx claude-mem install --ide grok-bot');
    expect(readme).not.toContain('npx claude-mem install --ide grok-bot --provider host');
  });

  it('keeps installer provider-cutover and does not recycle a healthy worker from settings POST', () => {
    const source = readFileSync(join(repoRoot, 'src/npx-cli/commands/install.ts'), 'utf-8');
    expect(source).toContain("'provider-cutover'");
    expect(source).toContain('POST /api/settings still must not recycle a healthy worker');
  });

  it('applies the grok-bot CMEM Pro default at the CLI boundary for non-TTY installs', () => {
    const cli = readFileSync(join(repoRoot, 'src/npx-cli/index.ts'), 'utf-8');
    const install = readFileSync(join(repoRoot, 'src/npx-cli/commands/install.ts'), 'utf-8');
    const grokInstaller = readFileSync(join(repoRoot, 'src/services/integrations/GrokBotInstaller.ts'), 'utf-8');
    expect(cli).toContain("from './installer-provider-choice.js'");
    expect(cli).toContain('resolveInstallerProviderChoice');
    expect(cli).toContain('process.stdin.isTTY');
    expect(install).toContain("initialValues: ['cmem']");
    expect(grokInstaller).toContain('GROK_BOT_AGENT_DATA');
  });
});
