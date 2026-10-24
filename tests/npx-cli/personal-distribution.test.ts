import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function isolated(script: string): void {
  const root = mkdtempSync(join(tmpdir(), 'mem-personal-distribution-'));
  try {
    const child = Bun.spawnSync([process.execPath, '--eval', `
      import assert from 'node:assert/strict';
      import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      import { CLAUDE_CONFIG_DIR, USER_SETTINGS_PATH } from './src/shared/paths.ts';
      import { registerMarketplace, enablePluginInClaudeSettings, promptProvider } from './src/npx-cli/commands/install.ts';
      mkdirSync(CLAUDE_CONFIG_DIR, { recursive: true });
      mkdirSync(join(CLAUDE_CONFIG_DIR, 'plugins'), { recursive: true });
      mkdirSync(process.env.CLAUDE_MEM_DATA_DIR, { recursive: true });
      ${script}
    `], {
      cwd: join(import.meta.dir, '../..'),
      env: { ...process.env, HOME: root, CLAUDE_CONFIG_DIR: join(root, '.claude'), CLAUDE_MEM_DATA_DIR: join(root, '.claude-mem'), CLAUDE_MEM_ENV_FILE: join(root, '.claude-mem/.env'), CLAUDE_MEM_TELEMETRY: '0' },
      stdout: 'pipe', stderr: 'pipe',
    });
    expect(child.exitCode, new TextDecoder().decode(child.stderr)).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

describe('personal distribution cutover', () => {
  it('registers only the fork with automatic updates off, preserving other marketplaces', () => isolated(`
    const path = join(CLAUDE_CONFIG_DIR, 'plugins/known_marketplaces.json');
    const upstream = { source: { source: 'github', repo: 'thedotmack/claude-mem' }, autoUpdate: true };
    writeFileSync(path, JSON.stringify({ thedotmack: upstream }));
    registerMarketplace();
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    assert.deepEqual(saved.thedotmack, upstream);
    assert.equal(saved['leoli-goat'].source.repo, 'LeoLi-Goat/claude-mem');
    assert.equal(saved['leoli-goat'].autoUpdate, false);
  `));

  it('enables one memory plugin while preserving working Claude Code gateway settings', () => isolated(`
    const path = join(CLAUDE_CONFIG_DIR, 'settings.json');
    const env = { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8080', ANTHROPIC_AUTH_TOKEN: 'test-only', ANTHROPIC_MODEL: 'custom-existing-model' };
    writeFileSync(path, JSON.stringify({ env, enabledPlugins: { 'claude-mem@thedotmack': true, 'other@vendor': true } }));
    enablePluginInClaudeSettings();
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { env, enabledPlugins: { 'claude-mem@thedotmack': false, 'other@vendor': true, 'claude-mem@leoli-goat': true } });
  `));

  it('explicitly choosing Claude retains gateway auth, custom model and the exact credential file', () => isolated(`
    const envPath = process.env.CLAUDE_MEM_ENV_FILE;
    const credentials = 'ANTHROPIC_BASE_URL=http://127.0.0.1:8080\\nANTHROPIC_AUTH_TOKEN=test-only\\n';
    writeFileSync(envPath, credentials);
    const settings = { CLAUDE_MEM_PROVIDER: 'claude', CLAUDE_MEM_CLAUDE_AUTH_METHOD: 'gateway', CLAUDE_MEM_MODEL: 'gateway-model-from-user', custom: 'keep' };
    writeFileSync(USER_SETTINGS_PATH, JSON.stringify(settings));
    assert.equal(await promptProvider({ provider: 'claude', providerSource: 'flag' }, null, 'test'), 'claude');
    assert.deepEqual(JSON.parse(readFileSync(USER_SETTINGS_PATH, 'utf8')), settings);
    assert.equal(readFileSync(envPath, 'utf8'), credentials);
  `));
});
