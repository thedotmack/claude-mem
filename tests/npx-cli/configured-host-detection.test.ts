import { expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectInstalledIDEs, initialIDESelection } from '../../src/npx-cli/commands/ide-detection.js';

it('detects installed hosts at their configured homes without requiring a CLI on PATH', () => {
  const root = mkdtempSync(join(tmpdir(), 'cmem-host-config-'));
  const homes = { CODEX_HOME: 'codex-cli', KIMI_CODE_HOME: 'kimi', OPENCODE_CONFIG_DIR: 'opencode' };
  const previous = Object.fromEntries([...Object.keys(homes), 'HOME', 'USERPROFILE', 'PATH'].map(key => [key, process.env[key]]));
  try {
    const emptyHome = join(root, 'home');
    mkdirSync(emptyHome);
    process.env.HOME = emptyHome;
    process.env.USERPROFILE = emptyHome;
    process.env.PATH = emptyHome;
    for (const [key, id] of Object.entries(homes)) {
      process.env[key] = join(root, id);
      mkdirSync(process.env[key]!);
    }
    const selected = initialIDESelection(detectInstalledIDEs());
    for (const id of Object.values(homes)) expect(selected).toContain(id);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
