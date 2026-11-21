import { expect, it } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectInstalledIDEs, initialIDESelection } from '../../src/npx-cli/commands/ide-detection.js';
import { discoverGrokBotAgentDataRoot } from '../../src/services/integrations/GrokBotInstaller.js';

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

/** Runs `check` in an empty temp home: nothing on PATH, no XDG data home, no GROK_BOT_AGENT_DATA. */
function withEmptyHome(check: (home: string, root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'cmem-host-detect-'));
  const previous = Object.fromEntries(['HOME', 'USERPROFILE', 'PATH', 'XDG_DATA_HOME', 'GROK_BOT_AGENT_DATA'].map(key => [key, process.env[key]]));
  try {
    const home = join(root, 'home');
    mkdirSync(home);
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.PATH = home;
    delete process.env.XDG_DATA_HOME;
    delete process.env.GROK_BOT_AGENT_DATA;
    check(home, root);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
}

const grokBotDetected = () => detectInstalledIDEs().find(ide => ide.id === 'grok-bot')?.detected;

// /home/box is one of the well-known agent data folders, and on a Grok Bot host it holds real agent data.
const boxHasAgentData = existsSync('/home/box/agents') && existsSync('/home/box/agent-transcripts');

it('does not detect or preselect Grok Bot for the ~/.cursor folder that Cursor creates', () => {
  withEmptyHome((home, root) => {
    mkdirSync(join(home, '.cursor'));
    // homedir() is fixed when a process starts, so detection runs in a child whose HOME is this home.
    const detection = join(import.meta.dir, '..', '..', 'src', 'npx-cli', 'commands', 'ide-detection.ts');
    const script = [
      `const { detectInstalledIDEs, initialIDESelection } = await import(${JSON.stringify(detection)});`,
      'const detected = detectInstalledIDEs();',
      'const isDetected = id => detected.find(ide => ide.id === id)?.detected;',
      "console.log(JSON.stringify({ cursor: isDetected('cursor'), grokBot: isDetected('grok-bot'), selected: initialIDESelection(detected) }));",
    ].join('\n');
    const child = Bun.spawnSync([process.execPath, '-e', script], {
      // A GROK_BOT_AGENT_DATA folder that never exists keeps agent data elsewhere on this machine out of the check.
      env: { ...process.env, GROK_BOT_AGENT_DATA: join(root, 'no-agent-data') },
    });
    expect(child.exitCode).toBe(0);
    const result = JSON.parse(child.stdout.toString());
    expect(result.cursor).toBe(true);
    expect(result.grokBot).toBe(false);
    expect(result.selected).not.toContain('grok-bot');
  });
}, 30_000);

it.skipIf(boxHasAgentData)('detects Grok Bot where its installer finds agent data, on a machine without Cursor', () => {
  withEmptyHome((home, root) => {
    const agentData = join(home, '.grok-bot');
    mkdirSync(agentData);
    expect(discoverGrokBotAgentDataRoot(process.env, root)).toBe(root);
    expect(grokBotDetected()).toBe(false);
    mkdirSync(join(agentData, 'agents'));
    mkdirSync(join(agentData, 'agent-transcripts'));
    expect(discoverGrokBotAgentDataRoot(process.env, root)).toBe(agentData);
    expect(grokBotDetected()).toBe(true);
  });
});

it('detects Grok Bot at the agent data folder GROK_BOT_AGENT_DATA names', () => {
  withEmptyHome((_home, root) => {
    process.env.GROK_BOT_AGENT_DATA = join(root, 'agent-data');
    mkdirSync(process.env.GROK_BOT_AGENT_DATA);
    expect(grokBotDetected()).toBe(true);
  });
});
