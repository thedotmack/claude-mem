import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import type { SpawnSyncReturns } from 'child_process';
import {
  buildCodexUserHookGroups,
  mergeCodexUserHooks,
  registerCodexUserHooks,
  removeCodexUserHooks,
} from '../../src/services/integrations/codex-user-hooks.js';
import { disableCodexPluginForHome, installCodexPluginForHome } from '../../src/services/integrations/CodexCliInstaller.js';
import { codexHooksCheck } from '../../src/npx-cli/commands/doctor.js';

const REPO_ROOT = resolve(import.meta.dir, '..', '..');
const HOOK_DEFINITIONS_PATH = join(REPO_ROOT, 'plugin', 'hooks', 'codex-hooks.json');
const LAUNCHER_PATH = '/home/someone/.local/bin/claude-mem';
const CLAUDE_MEM_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'PostCompact', 'SubagentStart'];

/** What two other tools already wrote: shared events, a matcher, an event claude-mem does not use. */
function otherToolsHooks() {
  return {
    hooks: {
      SessionStart: [
        { hooks: [{ type: 'command', command: 'python3 /opt/device-lease/lease hook', timeout: 5, statusMessage: 'Checking leases' }] },
        { hooks: [{ type: 'command', command: '[ -x "$NOTIFY" ] && "$NOTIFY" || true' }] },
      ],
      PreToolUse: [
        { matcher: '^request_user_input$', hooks: [{ type: 'command', command: '"$NOTIFY" ask' }] },
      ],
      SessionEnd: [
        { hooks: [{ type: 'command', command: '"$NOTIFY" bye' }] },
      ],
    },
  };
}

function claudeMemCommands(document: any): string[] {
  const commands: string[] = [];
  for (const groups of Object.values<any[]>(document.hooks ?? {})) {
    for (const group of groups) {
      for (const handler of group.hooks) {
        if (/hook codex /.test(handler.command)) commands.push(handler.command);
      }
    }
  }
  return commands.sort();
}

let codexHome: string;
let hooksPath: string;

beforeEach(() => {
  codexHome = mkdtempSync(join(tmpdir(), 'codex-user-hooks-'));
  hooksPath = join(codexHome, 'hooks.json');
});

afterEach(() => {
  rmSync(codexHome, { recursive: true, force: true });
});

function register() {
  return registerCodexUserHooks({ codexHome, hookDefinitionsPath: HOOK_DEFINITIONS_PATH, launcherPath: LAUNCHER_PATH, platform: 'linux' });
}

describe('claude-mem hooks in the Codex user hooks.json', () => {
  it('registers one hook per event whose command names no version and no plugin folder', () => {
    const result = register();
    const written = JSON.parse(readFileSync(hooksPath, 'utf-8'));

    expect(result).toEqual({ hooksPath, changed: true, hookCount: CLAUDE_MEM_EVENTS.length });
    expect(Object.keys(written.hooks).sort()).toEqual([...CLAUDE_MEM_EVENTS].sort());
    expect(written.hooks.Stop).toEqual([
      { hooks: [{ type: 'command', timeout: 60, command: `'${LAUNCHER_PATH}' hook codex summarize` }] },
    ]);
    // Matchers and timeouts come from the generated definitions, unchanged.
    const definitions = JSON.parse(readFileSync(HOOK_DEFINITIONS_PATH, 'utf-8')).hooks;
    for (const eventName of CLAUDE_MEM_EVENTS) {
      expect(written.hooks[eventName][0].matcher).toBe(definitions[eventName][0].matcher);
      expect(written.hooks[eventName][0].hooks[0].timeout).toBe(definitions[eventName][0].hooks[0].timeout);
      expect(written.hooks[eventName][0].hooks[0].commandWindows).toBeUndefined();
    }
    for (const command of claudeMemCommands(written)) {
      expect(command).toMatch(/^'\/home\/someone\/\.local\/bin\/claude-mem' hook codex [a-z-]+$/);
    }
  });

  it('keeps every other tool\'s hook, in order, and appends its own after them', () => {
    writeFileSync(hooksPath, JSON.stringify(otherToolsHooks(), null, 2));

    register();
    const written = JSON.parse(readFileSync(hooksPath, 'utf-8'));
    const before = otherToolsHooks().hooks;

    // Codex keys an approval by position, so nobody else's hook may move.
    expect(written.hooks.SessionStart.slice(0, 2)).toEqual(before.SessionStart);
    expect(written.hooks.SessionStart).toHaveLength(3);
    expect(written.hooks.PreToolUse[0]).toEqual(before.PreToolUse[0]);
    expect(written.hooks.PreToolUse).toHaveLength(2);
    expect(written.hooks.SessionEnd).toEqual(before.SessionEnd);
    expect(Object.keys(written.hooks).slice(0, 3)).toEqual(['SessionStart', 'PreToolUse', 'SessionEnd']);
    expect(claudeMemCommands(written)).toHaveLength(CLAUDE_MEM_EVENTS.length);
  });

  it('changes nothing when installed a second time', () => {
    writeFileSync(hooksPath, JSON.stringify(otherToolsHooks(), null, 2));
    register();
    const afterFirst = readFileSync(hooksPath, 'utf-8');

    const second = register();

    expect(second.changed).toBe(false);
    expect(readFileSync(hooksPath, 'utf-8')).toBe(afterFirst);
  });

  it('keeps its position when another tool adds a hook after it', () => {
    register();
    const document = JSON.parse(readFileSync(hooksPath, 'utf-8'));
    document.hooks.Stop.push({ hooks: [{ type: 'command', command: '"$NOTIFY" stop' }] });
    writeFileSync(hooksPath, JSON.stringify(document, null, 2));

    expect(register().changed).toBe(false);
    expect(JSON.parse(readFileSync(hooksPath, 'utf-8')).hooks.Stop[0].hooks[0].command).toContain('hook codex summarize');
  });

  it('leaves exactly one registration of each hook when migrating older or duplicated entries', () => {
    const olderForm = `/bin/sh -c 'node "$_P/scripts/bun-runner.js" "$_P/scripts/worker-service.cjs" hook codex summarize'`;
    const document = otherToolsHooks() as any;
    document.hooks.Stop = [
      { hooks: [{ type: 'command', command: olderForm, timeout: 60 }] },
      { hooks: [{ type: 'command', command: '"$NOTIFY" stop' }] },
      { hooks: [{ type: 'command', command: `'${LAUNCHER_PATH}' hook codex summarize`, timeout: 60 }] },
    ];
    // An event claude-mem no longer registers.
    document.hooks.SessionEnd.push({ hooks: [{ type: 'command', command: `'${LAUNCHER_PATH}' hook codex session-end` }] });
    writeFileSync(hooksPath, JSON.stringify(document, null, 2));

    register();
    const written = JSON.parse(readFileSync(hooksPath, 'utf-8'));

    const commands = claudeMemCommands(written);
    expect(commands).toHaveLength(CLAUDE_MEM_EVENTS.length);
    expect(new Set(commands).size).toBe(CLAUDE_MEM_EVENTS.length);
    expect(written.hooks.Stop).toEqual([
      { hooks: [{ type: 'command', timeout: 60, command: `'${LAUNCHER_PATH}' hook codex summarize` }] },
      { hooks: [{ type: 'command', command: '"$NOTIFY" stop' }] },
    ]);
    expect(written.hooks.SessionEnd).toEqual(otherToolsHooks().hooks.SessionEnd);
  });

  it('bundles no hooks in the Codex plugin, so the user-level ones never fire twice', () => {
    for (const [manifestPath, pluginRoot] of [
      [join(REPO_ROOT, 'plugin', '.codex-plugin', 'plugin.json'), join(REPO_ROOT, 'plugin')],
      [join(REPO_ROOT, '.codex-plugin', 'plugin.json'), REPO_ROOT],
    ]) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      // Without a `hooks` entry Codex falls back to hooks/hooks.json, which holds Claude Code's hooks.
      expect(typeof manifest.hooks).toBe('string');
      const bundled = JSON.parse(readFileSync(join(pluginRoot, manifest.hooks), 'utf-8'));
      expect(bundled).toEqual({ hooks: {} });
    }
  });

  it('removes only its own hooks on uninstall', () => {
    writeFileSync(hooksPath, JSON.stringify(otherToolsHooks(), null, 2));
    register();

    const removed = removeCodexUserHooks(codexHome);

    expect(removed.changed).toBe(true);
    expect(JSON.parse(readFileSync(hooksPath, 'utf-8'))).toEqual(otherToolsHooks());
    expect(removeCodexUserHooks(codexHome).changed).toBe(false);
  });

  it('takes its hook out of a group it shares with another tool without touching that tool\'s hook', () => {
    const shared = {
      hooks: {
        Stop: [{ hooks: [
          { type: 'command', command: '"$NOTIFY" stop' },
          { type: 'command', command: `'${LAUNCHER_PATH}' hook codex summarize` },
        ] }],
      },
    };

    const merged = mergeCodexUserHooks(shared, {});

    expect(merged.document).toEqual({ hooks: { Stop: [{ hooks: [{ type: 'command', command: '"$NOTIFY" stop' }] }] } });
  });

  it('refuses a hooks.json that is not valid JSON and leaves it untouched', () => {
    const broken = '{ "hooks": { "Stop": [ }';
    writeFileSync(hooksPath, broken);

    expect(register).toThrow(/hooks\.json is not valid JSON.*claude-mem left the file untouched/s);
    expect(() => removeCodexUserHooks(codexHome)).toThrow(/is not valid JSON/);
    expect(readFileSync(hooksPath, 'utf-8')).toBe(broken);
  });

  it('refuses a hooks.json whose shape it cannot merge into and leaves it untouched', () => {
    for (const unusable of ['[]', '{"hooks": []}', '{"hooks": {"Stop": {"hooks": []}}}', '{"hooks": {"Stop": ["notify"]}}']) {
      writeFileSync(hooksPath, unusable);
      expect(register).toThrow(/claude-mem left the file untouched/);
      expect(readFileSync(hooksPath, 'utf-8')).toBe(unusable);
    }
  });

  it('quotes the launcher path for cmd.exe on Windows', () => {
    const definitions = JSON.parse(readFileSync(HOOK_DEFINITIONS_PATH, 'utf-8'));
    const groups = buildCodexUserHookGroups(definitions, 'C:\\Users\\some one\\AppData\\Local\\claude-mem\\bin\\claude-mem.exe', 'win32');

    expect((groups.Stop.hooks as any[])[0].command)
      .toBe('"C:\\Users\\some one\\AppData\\Local\\claude-mem\\bin\\claude-mem.exe" hook codex summarize');
  });
});

describe('Codex install for one home', () => {
  function recordingSpawn(calls: string[], onCall?: (args: string[]) => void) {
    return (args: string[]): SpawnSyncReturns<string> => {
      calls.push(args.join(' '));
      onCall?.(args);
      return { pid: 1, output: [], stdout: args[0] === '--version' ? 'codex-cli 0.166.0' : '', stderr: '', status: 0, signal: null };
    };
  }

  it('writes the user-level hooks only after Codex refreshed the plugin copy', () => {
    const calls: string[] = [];
    let hooksExistedAtPluginAdd: boolean | undefined;

    installCodexPluginForHome({
      marketplaceRoot: REPO_ROOT,
      homePath: codexHome,
      launcherPath: LAUNCHER_PATH,
      spawn: recordingSpawn(calls, (args) => {
        if (args[0] === 'plugin' && args[1] === 'add') hooksExistedAtPluginAdd = existsSync(hooksPath);
      }),
    });

    expect(hooksExistedAtPluginAdd).toBe(false);
    expect(claudeMemCommands(JSON.parse(readFileSync(hooksPath, 'utf-8')))).toHaveLength(CLAUDE_MEM_EVENTS.length);
    // Approval is the owner's step in Codex: the installer writes no trust state.
    expect(readFileSync(join(codexHome, 'config.toml'), 'utf-8')).not.toMatch(/trusted_hash|hooks\.state/);
    expect(existsSync(join(codexHome, '.hook-trust'))).toBe(false);

    disableCodexPluginForHome(codexHome);
    expect(JSON.parse(readFileSync(hooksPath, 'utf-8'))).toEqual({ hooks: {} });
  });

  it('changes nothing in the home when hooks.json cannot be merged', () => {
    writeFileSync(hooksPath, 'not json');
    const calls: string[] = [];

    expect(() => installCodexPluginForHome({
      marketplaceRoot: REPO_ROOT, homePath: codexHome, launcherPath: LAUNCHER_PATH, spawn: recordingSpawn(calls),
    })).toThrow(/claude-mem left the file untouched/);

    expect(calls).toEqual(['--version']);
    expect(existsSync(join(codexHome, 'config.toml'))).toBe(false);
    expect(readFileSync(hooksPath, 'utf-8')).toBe('not json');
  });
});

describe('doctor: Codex hooks row', () => {
  const check = () => codexHooksCheck({ codexHome, hookDefinitionsPath: HOOK_DEFINITIONS_PATH, launcherPath: LAUNCHER_PATH, platform: 'linux' });
  const enablePlugin = () => writeFileSync(join(codexHome, 'config.toml'), '[plugins."claude-mem@claude-mem-local"]\nenabled = true\n');

  it('says nothing for a home that does not use the Codex plugin', () => {
    expect(check()).toBeNull();
    writeFileSync(join(codexHome, 'config.toml'), '[plugins."claude-mem@claude-mem-local"]\nenabled = false\n');
    expect(check()).toBeNull();
  });

  it('warns that chats are not captured when the plugin is on but the hooks are not registered', () => {
    enablePlugin();
    writeFileSync(hooksPath, JSON.stringify(otherToolsHooks()));

    const result = check();

    expect(result?.status).toBe('warn');
    expect(result?.detail).toContain('Codex chats are not being captured');
    expect(result?.detail).toContain('npx claude-mem install');
    // The check only reads.
    expect(JSON.parse(readFileSync(hooksPath, 'utf-8'))).toEqual(otherToolsHooks());
  });

  it('is ok once the hooks are registered, and names the approval step', () => {
    enablePlugin();
    register();

    const result = check();

    expect(result?.status).toBe('ok');
    expect(result?.detail).toContain('/hooks');
  });

  it('reports a hooks.json it cannot read instead of passing', () => {
    enablePlugin();
    writeFileSync(hooksPath, '{');

    expect(check()?.status).toBe('warn');
    expect(check()?.detail).toContain('is not valid JSON');
  });
});
