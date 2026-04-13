import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const configSource = readFileSync(
  join(__dirname, '..', 'src', 'services', 'transcripts', 'config.ts'),
  'utf-8',
);
const installerSource = readFileSync(
  join(__dirname, '..', 'src', 'services', 'integrations', 'CodexCliInstaller.ts'),
  'utf-8',
);

describe('Codex workspace-local context', () => {
  it('does not hardcode ~/.codex/AGENTS.md in the sample transcript watch config', () => {
    expect(configSource).not.toContain("path: '~/.codex/AGENTS.md'");
  });

  it('documents workspace-local AGENTS.md injection for Codex', () => {
    expect(installerSource).toContain('workspace-local AGENTS.md');
    expect(installerSource).toContain('Context files: <workspace>/AGENTS.md');
  });

  it('cleans legacy global Codex context during install', () => {
    expect(installerSource).toContain('cleanupLegacyCodexAgentsMdContext();');
    expect(installerSource).toContain('Removed legacy global context');
  });
});
