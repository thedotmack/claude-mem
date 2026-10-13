import { describe, expect, it } from 'bun:test';
import { buildHardenedSdkOptions, OBSERVER_DISALLOWED_TOOLS } from '../../src/sdk/hardened-options.js';
import { existsSync } from 'fs';
import { OBSERVER_SESSIONS_DIR } from '../../src/shared/paths.js';

describe('buildHardenedSdkOptions thinking policy', () => {
  const build = (source: 'Observer' | 'KnowledgeAgent') =>
    buildHardenedSdkOptions({
      source,
      model: 'claude-haiku-4-5',
      env: {} as NodeJS.ProcessEnv,
      pathToClaudeCodeExecutable: '/usr/bin/claude',
    });

  it('disables thinking for Observer sessions', () => {
    const opts = build('Observer');
    expect(opts.thinking).toEqual({ type: 'disabled' });
    // `thinkingConfig` is the SDK's internal transport field; query() ignores it
    // when passed as an option, so setting it silently leaves thinking on.
    expect('thinkingConfig' in opts).toBe(false);
  });

  it('does not set thinking for KnowledgeAgent sessions', () => {
    const opts = build('KnowledgeAgent');
    expect('thinking' in opts).toBe(false);
    expect('thinkingConfig' in opts).toBe(false);
  });

  it('defaults cwd to OBSERVER_SESSIONS_DIR, creates it, and honors an explicit cwd', () => {
    expect(build('Observer').cwd).toBe(OBSERVER_SESSIONS_DIR);
    expect(existsSync(OBSERVER_SESSIONS_DIR)).toBe(true);
    const explicit = buildHardenedSdkOptions({
      source: 'Observer',
      model: 'claude-haiku-4-5',
      env: {} as NodeJS.ProcessEnv,
      pathToClaudeCodeExecutable: '/usr/bin/claude',
      cwd: '/tmp/explicit-cwd',
    });
    expect(explicit.cwd).toBe('/tmp/explicit-cwd');
  });

  it('keeps lockdown fields unchanged for both sources', () => {
    for (const source of ['Observer', 'KnowledgeAgent'] as const) {
      const opts = build(source);
      expect(opts.tools).toEqual([]);
      expect(opts.allowedTools).toEqual([]);
      expect(opts.disallowedTools).toEqual([...OBSERVER_DISALLOWED_TOOLS]);
      expect(opts.permissionMode).toBe('dontAsk');
      expect(opts.mcpServers).toEqual({});
      expect(opts.settingSources).toEqual([]);
      expect(opts.strictMcpConfig).toBe(true);
      expect(opts.additionalDirectories).toEqual([]);
    }
  });
});
