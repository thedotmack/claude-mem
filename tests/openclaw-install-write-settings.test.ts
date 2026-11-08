import { afterEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const INSTALL_SH = path.join(import.meta.dir, '..', 'openclaw', 'install.sh');

/** Runs install.sh's write_settings function alone, against a throwaway HOME. */
function runWriteSettings(home: string, provider: string): void {
  const script = readFileSync(INSTALL_SH, 'utf8');
  const match = script.match(/^write_settings\(\) \{\n[\s\S]*?\n\}\n/m);
  if (!match) throw new Error('write_settings() not found in openclaw/install.sh');
  const result = spawnSync('bash', ['-c', `set -euo pipefail\nsuccess() { :; }\n${match[0]}\nwrite_settings`], {
    env: { ...process.env, HOME: home, AI_PROVIDER: provider, AI_PROVIDER_API_KEY: '' },
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(`write_settings failed: ${result.stderr}`);
}

describe('openclaw install.sh write_settings', () => {
  const temps: string[] = [];
  afterEach(() => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  // A reinstall that dropped the TV token but kept a non-loopback bind would leave the worker open (#5141).
  it('keeps every existing key on reinstall, including ones the installer has no default for', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'openclaw-settings-'));
    temps.push(home);
    mkdirSync(path.join(home, '.claude-mem'));
    const settingsPath = path.join(home, '.claude-mem', 'settings.json');
    writeFileSync(settingsPath, JSON.stringify({
      CLAUDE_MEM_TV_TOKEN: 'keep-me',
      CLAUDE_MEM_WORKER_HOST: '0.0.0.0',
      CLAUDE_MEM_PROVIDER: 'gemini',
    }));

    runWriteSettings(home, 'claude');

    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(settings.CLAUDE_MEM_TV_TOKEN).toBe('keep-me');
    expect(settings.CLAUDE_MEM_WORKER_HOST).toBe('0.0.0.0');
    expect(settings.CLAUDE_MEM_PROVIDER).toBe('claude');
  });
});
