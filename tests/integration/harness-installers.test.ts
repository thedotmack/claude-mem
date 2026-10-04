import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { canonicalIntegrationId } from '../../src/shared/integration-id.js';
import { installPiExtension, piExtensionPath, uninstallPiExtension } from '../../src/services/integrations/PiInstaller.js';
import { installDshTranscriptWatch, uninstallDshTranscriptWatch, dshWatchConfigPath, installDeepSeekHarness, uninstallDeepSeekHarness } from '../../src/services/integrations/DeepSeekHarnessInstaller.js';

let dir: string;
let previous: Record<string, string | undefined>;
const keys = ['PI_CODING_AGENT_DIR', 'DSH_HOME', 'CLAUDE_MEM_DEV_HOOK_SOURCE', 'CLAUDE_MEM_TRANSCRIPTS_CONFIG_PATH', 'PATH', 'DSH_TEST_LOG', 'DSH_TEST_FAIL'];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cmem-harness-install-'));
  previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.PI_CODING_AGENT_DIR = join(dir, 'pi');
  process.env.DSH_HOME = join(dir, 'dsh-home');
  process.env.CLAUDE_MEM_DEV_HOOK_SOURCE = '1';
  process.env.CLAUDE_MEM_TRANSCRIPTS_CONFIG_PATH = join(dir, 'custom', 'watch.json');
});
afterEach(() => {
  for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
  rmSync(dir, { recursive: true, force: true });
});
function writeConfig(value: any): void {
  mkdirSync(join(dir, 'custom'), { recursive: true });
  writeFileSync(dshWatchConfigPath(), JSON.stringify(value));
}
const readConfig = () => JSON.parse(readFileSync(dshWatchConfigPath(), 'utf8'));
function fakeDsh(): void {
  const bin = join(dir, 'bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'dsh'), '#!/usr/bin/env node\n' +
    'const fs=require("node:fs");fs.appendFileSync(process.env.DSH_TEST_LOG,JSON.stringify(process.argv.slice(2))+"\\n");process.exit(process.env.DSH_TEST_FAIL==="1"?1:0);\n', { mode: 0o755 });
  process.env.PATH = bin + ':' + process.env.PATH;
  process.env.DSH_TEST_LOG = join(dir, 'dsh-calls.jsonl');
}

describe('first-party harness installers', () => {
  it('accepts Pi/DeepSeek aliases', () => {
    expect(canonicalIntegrationId('pi-mono')).toBe('pi');
    expect(canonicalIntegrationId('deepseek-harness')).toBe('dsh');
  });

  it('installs the Pi discovery folder with its license and removes only managed files', () => {
    // The release build supplies dist/pi-extension/index.js. The explicit dev
    // flag permits this checkout; normal installs only trust the marketplace.
    expect(installPiExtension()).toBe(0);
    const extensionPath = piExtensionPath();
    expect(extensionPath.endsWith('/extensions/claude-mem/index.js')).toBe(true);
    const folder = join(process.env.PI_CODING_AGENT_DIR!, 'extensions', 'claude-mem');
    expect(JSON.parse(readFileSync(join(folder, 'package.json'), 'utf8')).type).toBe('module');
    expect(readFileSync(join(folder, 'LICENSE.txt'), 'utf8')).toContain('Husni Adil Makmur');
    writeFileSync(join(folder, 'personal-note.txt'), 'keep');
    expect(uninstallPiExtension()).toBe(0);
    expect(existsSync(extensionPath)).toBe(false);
    expect(readFileSync(join(folder, 'personal-note.txt'), 'utf8')).toBe('keep');
  });

  it('adds DSH capture once at the configured path and preserves unrelated watches', () => {
    writeConfig({ version: 1, watches: [{ name: 'other', path: '/other', schema: 'custom' }], schemas: { custom: { name: 'custom', events: [] } } });
    installDshTranscriptWatch(join(process.cwd(), 'dsh'));
    installDshTranscriptWatch(join(process.cwd(), 'dsh'));
    const config = readConfig();
    expect(config.watches).toHaveLength(2);
    expect(config.watches[1]).toMatchObject({ name: 'dsh', path: join(dir, 'dsh-home', 'sessions'), schema: 'dsh', startAtEnd: true });
    expect(config.schemas.custom).toEqual({ name: 'custom', events: [] });
    expect(config.schemas.dsh.events.length).toBeGreaterThan(0);
    uninstallDshTranscriptWatch();
    expect(readConfig().watches).toEqual([{ name: 'other', path: '/other', schema: 'custom' }]);
  });

  it('leaves a user-managed DSH watch authoritative during install and uninstall', () => {
    const watches = [{ name: 'my-harness', path: '/custom', schema: 'dsh', startAtEnd: false }];
    writeConfig({ version: 1, watches });
    installDshTranscriptWatch(join(process.cwd(), 'dsh'));
    expect(readConfig().watches).toEqual(watches);
    uninstallDshTranscriptWatch();
    expect(readConfig().watches).toEqual(watches);
  });

  it('fails before replacing malformed configuration', () => {
    mkdirSync(join(dir, 'custom'), { recursive: true });
    const original = '{broken JSON';
    writeFileSync(dshWatchConfigPath(), original);
    expect(() => installDshTranscriptWatch(join(process.cwd(), 'dsh'))).toThrow();
    expect(readFileSync(dshWatchConfigPath(), 'utf8')).toBe(original);
  });

  it.skipIf(process.platform === 'win32')('uses the requested DSH profile for native add/remove and preserves unrelated watches', async () => {
    fakeDsh();
    const other = { name: 'other', path: '/other', schema: 'custom' };
    writeConfig({ version: 1, watches: [other], schemas: { custom: { name: 'custom', events: [] } } });
    expect(await installDeepSeekHarness('review')).toBe(0);
    expect(readConfig().watches).toHaveLength(2);
    expect(await uninstallDeepSeekHarness()).toBe(0);
    expect(readConfig().watches).toEqual([other]);
    const calls = readFileSync(process.env.DSH_TEST_LOG!, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(calls[0].slice(0,4)).toEqual(['plugin','--profile','review','add']);
    expect(calls[0][4]).toContain('dsh');
    expect(calls[1]).toEqual(['plugin','--profile','review','remove','@claude-mem/dsh']);
  });

  it.skipIf(process.platform === 'win32')('does not add a watch on CLI failure or run invalid profiles', async () => {
    fakeDsh(); process.env.DSH_TEST_FAIL = '1';
    const original = { version: 1, watches: [] };
    writeConfig(original);
    expect(await installDeepSeekHarness('review')).toBe(1);
    expect(readConfig()).toEqual(original);
    expect(await installDeepSeekHarness('invalid;profile')).toBe(1);
    expect(readFileSync(process.env.DSH_TEST_LOG!, 'utf8').trim().split('\n')).toHaveLength(1);
  });
});
