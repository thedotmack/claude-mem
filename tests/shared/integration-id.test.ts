import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { canonicalIntegrationId } from '../../src/shared/integration-id.js';
import { getPlatformAdapter } from '../../src/cli/adapters/index.js';
import { claudeCodeAdapter } from '../../src/cli/adapters/claude-code.js';
import { detectInstalledIDEs } from '../../src/npx-cli/commands/ide-detection.js';

describe("'claude' is an alias for Claude Code (#2835)", () => {
  it('canonicalizes claude and leaves every other id alone', () => {
    expect(canonicalIntegrationId('claude')).toBe('claude-code');
    expect(canonicalIntegrationId('claude-code')).toBe('claude-code');
    expect(canonicalIntegrationId('cursor')).toBe('cursor');
  });

  it('names an IDE the installer knows, so --ide claude is not an unknown IDE', () => {
    const ids = detectInstalledIDEs().map((ide) => ide.id);
    expect(ids).not.toContain('claude');
    expect(ids).toContain(canonicalIntegrationId('claude'));
  });

  it('validates --ide against the canonical id', () => {
    const installSource = readFileSync(
      join(import.meta.dir, '..', '..', 'src', 'npx-cli', 'commands', 'install.ts'),
      'utf-8',
    );
    expect(installSource).toContain('const ideId = canonicalIntegrationId(options.ide);');
    expect(installSource).toContain('allIDEs.find((i) => i.id === ideId)');
  });

  it('uses the Claude Code adapter for hook claude', () => {
    expect(getPlatformAdapter('claude')).toBe(claudeCodeAdapter);
  });
});
