import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { canonicalIntegrationId } from '../../src/shared/integration-id.js';
import { readProjectAttribution, replaceOwnedFiles } from '../../src/shared/owned-file-install.js';
import { installDshTranscriptWatch, uninstallDshTranscriptWatch, dshWatchConfigPath } from '../../src/services/integrations/DeepSeekHarnessInstaller.js';

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

function runIsolatedPi(script: string, options: { missing?: string; beforeImport?: string } = {}): any {
  const checkout = join(dir, 'pi-checkout');
  const bundleDir = join(checkout, 'dist', 'pi-extension');
  mkdirSync(bundleDir, { recursive: true });
  mkdirSync(join(checkout, 'pi'), { recursive: true });
  for (const file of ['package.json', 'LICENSE', 'NOTICE', 'pi/THIRD-PARTY-LICENSE.txt', 'pi/TYPEBOX-LICENSE.txt', 'pi/TYPEBOX-PROVENANCE.json']) {
    writeFileSync(join(checkout, file), readFileSync(join(process.cwd(), file)));
  }
  const attribution = [
    ['LICENSE.txt', 'pi/THIRD-PARTY-LICENSE.txt'],
    ['CLAUDE-MEM-LICENSE.txt', 'LICENSE'],
    ['CLAUDE-MEM-NOTICE.txt', 'NOTICE'],
    ['TYPEBOX-LICENSE.txt', 'pi/TYPEBOX-LICENSE.txt'],
    ['TYPEBOX-PROVENANCE.json', 'pi/TYPEBOX-PROVENANCE.json'],
  ];
  for (const [name, source] of attribution) writeFileSync(join(bundleDir, name), readFileSync(join(checkout, source)));
  // This fixture tests file installation only; the bundle contract test builds the actual source.
  writeFileSync(join(bundleDir, 'index.js'), 'export default function fixtureExtension() {}');
  if (options.missing) rmSync(join(checkout, options.missing));
  const module = new URL('../../src/services/integrations/PiInstaller.ts', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--eval',
    (options.beforeImport || '') +
    'const pi = await import(' + JSON.stringify(module) + ');\n' +
    'const { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } = await import("node:fs");\n' +
    'const { join } = await import("node:path");\n' +
    'const owned = ["index.js", "package.json", "LICENSE.txt", "CLAUDE-MEM-LICENSE.txt", "CLAUDE-MEM-NOTICE.txt", "TYPEBOX-LICENSE.txt", "TYPEBOX-PROVENANCE.json"];\n' +
    'const folder = pi.piExtensionDirectory();\n' +
    'const snapshot = () => Object.fromEntries(owned.map(name => [name, readFileSync(join(folder, name), "utf8")]));\n' +
    script,
  ], {
    cwd: checkout, encoding: 'utf8', timeout: 15_000,
    env: { ...process.env, CLAUDE_CONFIG_DIR: join(dir, 'claude'), CLAUDE_MEM_DATA_DIR: join(dir, 'data') },
  });
  if (result.status !== 0) throw new Error(result.stderr || String(result.error));
  const output = result.stdout.split('\n').find(line => line.startsWith('PI_RESULT='));
  if (!output) throw new Error('Isolated Pi test produced no result: ' + result.stdout);
  return JSON.parse(output.slice('PI_RESULT='.length));
}

function runIsolatedDsh(script: string, missing?: string): any {
  // A fresh process resolves DATA_DIR before importing the installer. Neither
  // test depends on a prior build or can touch the user's profile marker.
  const checkout = join(dir, 'checkout');
  const fixture = join(checkout, 'dsh');
  mkdirSync(join(fixture, 'lib'), { recursive: true });
  for (const file of ['package.json', 'transcript-schema.json', 'LICENSE', 'NOTICE', 'THIRD-PARTY-LICENSES.txt']) {
    writeFileSync(join(fixture, file), readFileSync(join(process.cwd(), 'dsh', file)));
  }
  writeFileSync(join(fixture, 'lib', 'index.js'), 'export function apply() {}');
  if (missing) rmSync(join(fixture, missing));
  const module = new URL('../../src/services/integrations/DeepSeekHarnessInstaller.ts', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--eval',
    `const { installDeepSeekHarness, uninstallDeepSeekHarness } = await import(${JSON.stringify(module)});\n` +
    'const { readFileSync } = await import("node:fs");\n' +
    'const config = () => JSON.parse(readFileSync(process.env.CLAUDE_MEM_TRANSCRIPTS_CONFIG_PATH, "utf8"));\n' + script,
  ], {
    cwd: checkout, encoding: 'utf8', timeout: 15_000,
    env: { ...process.env, CLAUDE_CONFIG_DIR: join(dir, 'claude'), CLAUDE_MEM_DATA_DIR: join(dir, 'data'), CLAUDE_MEM_TRANSCRIPTS_ENABLED: 'true' },
  });
  if (result.status !== 0) throw new Error(result.stderr || String(result.error));
  const output = result.stdout.split('\n').find(line => line.startsWith('DSH_RESULT='));
  if (!output) throw new Error('Isolated DSH test produced no result: ' + result.stdout);
  return JSON.parse(output.slice('DSH_RESULT='.length));
}

describe('first-party harness installers', () => {
  it('accepts Pi/DeepSeek aliases', () => {
    expect(canonicalIntegrationId('pi-mono')).toBe('pi');
    expect(canonicalIntegrationId('deepseek-harness')).toBe('dsh');
  });

  it('installs complete Pi attribution twice and uninstalls only its seven owned files', () => {
    const result = runIsolatedPi(`
      const first = pi.installPiExtension();
      writeFileSync(join(folder, 'personal-note.txt'), 'keep');
      const second = pi.installPiExtension();
      const installed = snapshot();
      const extensionPath = pi.piExtensionPath();
      const removed = pi.uninstallPiExtension();
      console.log('PI_RESULT=' + JSON.stringify({ first, second, installed, extensionPath, removed,
        remaining: readdirSync(folder), note: readFileSync(join(folder, 'personal-note.txt'), 'utf8') }));
    `);
    expect(result.first).toBe(0);
    expect(result.second).toBe(0);
    expect(result.extensionPath.endsWith('/extensions/claude-mem/index.js')).toBe(true);
    expect(JSON.parse(result.installed['package.json']).type).toBe('module');
    expect(result.installed['LICENSE.txt']).toBe(readFileSync('pi/THIRD-PARTY-LICENSE.txt', 'utf8'));
    expect(result.installed['CLAUDE-MEM-LICENSE.txt']).toBe(readFileSync('LICENSE', 'utf8'));
    expect(result.installed['CLAUDE-MEM-NOTICE.txt']).toBe(readFileSync('NOTICE', 'utf8'));
    expect(result.installed['TYPEBOX-LICENSE.txt']).toBe(readFileSync('pi/TYPEBOX-LICENSE.txt', 'utf8'));
    expect(result.installed['TYPEBOX-PROVENANCE.json']).toBe(readFileSync('pi/TYPEBOX-PROVENANCE.json', 'utf8'));
    expect(result.removed).toBe(0);
    expect(result.remaining).toEqual(['personal-note.txt']);
    expect(result.note).toBe('keep');
  });

  it('reports file installation and status without claiming automatic Pi capture is verified', () => {
    const result = runIsolatedPi(`
      const log = console.log;
      const messages = [];
      console.log = (...values) => messages.push(values.map(String).join(' '));
      let installed, status, afterInstall, afterStatus;
      try {
        installed = pi.installPiExtension();
        afterInstall = snapshot();
        messages.push('STATUS_BOUNDARY');
        status = pi.piExtensionStatus();
        afterStatus = snapshot();
      } finally { console.log = log; }
      console.log('PI_RESULT=' + JSON.stringify({ installed, status, afterInstall, afterStatus, messages }));
    `);
    expect(result.installed).toBe(0);
    expect(result.status).toBe(0);
    expect(result.afterStatus).toEqual(result.afterInstall);
    const boundary = result.messages.indexOf('STATUS_BOUNDARY');
    expect(boundary).toBeGreaterThan(0);
    for (const messages of [result.messages.slice(0, boundary), result.messages.slice(boundary + 1)]) {
      const text = messages.join('\n');
      expect(text).toContain('extension files');
      expect(text).toContain('Automatic memory capture is not verified');
      expect(text).toContain('Pi 0.79.6 provides manual recall only');
      expect(text).toContain('Pi 1.0.2 and 1.0.4');
      expect(text).toContain('other or unknown versions need a compatibility check');
      expect(text).toContain('Check your Pi version and update Pi if needed');
      expect(text).toContain('docs/pi-native-capture.md');
    }
  });

  it('keeps a missing extension status nonzero and leaves its destination absent while giving Pi compatibility guidance', () => {
    const result = runIsolatedPi(`
      const log = console.log;
      const messages = [];
      console.log = (...values) => messages.push(values.map(String).join(' '));
      let status;
      try { status = pi.piExtensionStatus(); } finally { console.log = log; }
      console.log('PI_RESULT=' + JSON.stringify({ status, messages, exists: existsSync(folder) }));
    `);
    expect(result.status).toBe(1);
    expect(result.exists).toBe(false);
    const text = result.messages.join('\n');
    expect(text).toContain('Pi extension files: not installed');
    expect(text).toContain('Automatic memory capture is not verified');
    expect(text).toContain('Pi 0.79.6 provides manual recall only');
    expect(text).toContain('other or unknown versions need a compatibility check');
    expect(text).toContain('docs/pi-native-capture.md');
  });

  it.each(['LICENSE', 'NOTICE', 'pi/THIRD-PARTY-LICENSE.txt', 'pi/TYPEBOX-LICENSE.txt', 'pi/TYPEBOX-PROVENANCE.json', 'dist/pi-extension/TYPEBOX-LICENSE.txt'])
    ('refuses missing Pi input %s before creating a destination', (missing: string) => {
      const result = runIsolatedPi(`
        const status = pi.installPiExtension();
        console.log('PI_RESULT=' + JSON.stringify({ status, exists: existsSync(folder) }));
      `, { missing });
      expect(result.status).toBe(1);
      expect(result.exists).toBe(false);
    });

  it('preserves a working Pi set and unrelated files when a required notice is missing', () => {
    const result = runIsolatedPi(`
      mkdirSync(folder, { recursive: true });
      for (const name of owned) writeFileSync(join(folder, name), 'previous-' + name);
      writeFileSync(join(folder, 'personal-note.txt'), 'keep');
      const before = snapshot();
      const status = pi.installPiExtension();
      console.log('PI_RESULT=' + JSON.stringify({ status, before, after: snapshot(),
        note: readFileSync(join(folder, 'personal-note.txt'), 'utf8') }));
    `, { missing: 'NOTICE' });
    expect(result.status).toBe(1);
    expect(result.after).toEqual(result.before);
    expect(result.note).toBe('keep');
  });

  it('restores the working Pi set after a mid-replacement rename refuses', () => {
    const result = runIsolatedPi(`
      mkdirSync(folder, { recursive: true });
      for (const name of owned) writeFileSync(join(folder, name), 'previous-' + name);
      writeFileSync(join(folder, 'personal-note.txt'), 'keep');
      const before = snapshot();
      const status = pi.installPiExtension();
      console.log('PI_RESULT=' + JSON.stringify({ status, before, after: snapshot(),
        note: readFileSync(join(folder, 'personal-note.txt'), 'utf8') }));
    `, { beforeImport: `
      const fs = await import('node:fs');
      const rename = fs.renameSync;
      const { mock } = await import('bun:test');
      let refuse = true;
      mock.module('node:fs', () => ({ ...fs, renameSync(from, to) {
        if (refuse && String(from).includes('.claude-mem-files-') && String(to).endsWith('package.json')) {
          refuse = false;
          throw new Error('injected one-time rename refusal');
        }
        return rename(from, to);
      } }));
    ` });
    expect(result.status).toBe(1);
    expect(result.after).toEqual(result.before);
    expect(result.note).toBe('keep');
  });

  it('refreshes the complete marketplace license pair without changing an unrelated file', () => {
    const target = join(dir, 'marketplace');
    mkdirSync(target);
    writeFileSync(join(target, 'LICENSE'), 'old license');
    writeFileSync(join(target, 'NOTICE'), 'old notice');
    writeFileSync(join(target, 'personal-note.txt'), 'keep');
    replaceOwnedFiles(target, readProjectAttribution(process.cwd()));
    replaceOwnedFiles(target, readProjectAttribution(process.cwd()));
    expect(readFileSync(join(target, 'LICENSE'))).toEqual(readFileSync('LICENSE'));
    expect(readFileSync(join(target, 'NOTICE'))).toEqual(readFileSync('NOTICE'));
    expect(readFileSync(join(target, 'personal-note.txt'), 'utf8')).toBe('keep');
  });

  it('refuses a missing marketplace notice before changing either old license file', () => {
    const source = join(dir, 'package-source');
    const target = join(dir, 'marketplace');
    mkdirSync(source); mkdirSync(target);
    writeFileSync(join(source, 'LICENSE'), readFileSync('LICENSE'));
    writeFileSync(join(target, 'LICENSE'), 'old license');
    writeFileSync(join(target, 'NOTICE'), 'old notice');
    expect(() => replaceOwnedFiles(target, readProjectAttribution(source))).toThrow();
    expect(readFileSync(join(target, 'LICENSE'), 'utf8')).toBe('old license');
    expect(readFileSync(join(target, 'NOTICE'), 'utf8')).toBe('old notice');
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

  it.skipIf(process.platform === 'win32')('refuses a missing DSH notice before native add or ownership/config writes', () => {
    fakeDsh();
    const original = { version: 1, watches: [{ name: 'other', path: '/other', schema: 'custom' }] };
    writeConfig(original);
    const result = runIsolatedDsh(`
      const installed = await installDeepSeekHarness('review');
      console.log('DSH_RESULT=' + JSON.stringify({ installed }));
    `, 'NOTICE');
    expect(result.installed).toBe(1);
    expect(readConfig()).toEqual(original);
    expect(existsSync(process.env.DSH_TEST_LOG!)).toBe(false);
    expect(existsSync(join(dir, 'data', 'integrations', 'dsh.json'))).toBe(false);
  });

  it('keeps complete DSH project attribution and all bundled license texts in the local package', () => {
    const license = readFileSync('dsh/LICENSE', 'utf8');
    const notice = readFileSync('dsh/NOTICE', 'utf8');
    expect(license.startsWith(readFileSync('LICENSE', 'utf8'))).toBe(true);
    expect(license).toContain('Copyright 2026 Bleed00');
    expect(notice).toContain(readFileSync('NOTICE', 'utf8'));
    expect(notice).toContain('Derived from Bleed00/dsh-claude-mem');
    expect(readFileSync('dsh/THIRD-PARTY-LICENSES.txt', 'utf8')).toContain('Redistribution and use in source and binary forms');
    expect(createHash('sha256').update(readFileSync('dsh/THIRD-PARTY-LICENSES.txt')).digest('hex')).toBe('5a850b89b19926b4a19200f2caecd17acca490de05274b6496c39f10edac12a7');
    const files = JSON.parse(readFileSync('dsh/package.json', 'utf8')).files;
    expect(files).toEqual(expect.arrayContaining(['LICENSE', 'NOTICE', 'THIRD-PARTY-LICENSES.txt']));
  });

  it.skipIf(process.platform === 'win32')('uses the requested DSH profile for native add/remove and preserves unrelated watches', async () => {
    fakeDsh();
    const other = { name: 'other', path: '/other', schema: 'custom' };
    writeConfig({ version: 1, watches: [other], schemas: { custom: { name: 'custom', events: [] } } });
    const result = runIsolatedDsh(`
      const installed = await installDeepSeekHarness('review');
      const watches = config().watches;
      const removed = await uninstallDeepSeekHarness();
      console.log('DSH_RESULT=' + JSON.stringify({ installed, watches, removed }));
    `);
    expect(result.installed).toBe(0);
    expect(result.watches).toHaveLength(2);
    expect(result.removed).toBe(0);
    expect(readConfig().watches).toEqual([other]);
    const calls = readFileSync(process.env.DSH_TEST_LOG!, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(calls[0].slice(0,4)).toEqual(['plugin','--profile','review','add']);
    expect(calls[0][4]).toBe('--workspace-root');
    expect(calls[0][5]).toContain('dsh');
    expect(calls[1]).toEqual(['plugin','--profile','review','remove','--workspace-root','@claude-mem/dsh']);
  });

  it.skipIf(process.platform === 'win32')('does not add a watch on CLI failure or run invalid profiles', async () => {
    fakeDsh(); process.env.DSH_TEST_FAIL = '1';
    const original = { version: 1, watches: [] };
    writeConfig(original);
    const result = runIsolatedDsh(`
      const installed = await installDeepSeekHarness('review');
      const invalid = await installDeepSeekHarness('invalid;profile');
      console.log('DSH_RESULT=' + JSON.stringify({ installed, invalid }));
    `);
    expect(result.installed).toBe(1);
    expect(readConfig()).toEqual(original);
    expect(result.invalid).toBe(1);
    expect(readFileSync(process.env.DSH_TEST_LOG!, 'utf8').trim().split('\n')).toHaveLength(1);
  });
});
