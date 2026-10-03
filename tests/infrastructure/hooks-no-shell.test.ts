import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import path from 'path';
import {
  buildCodexWindowsCommand,
  buildEnsureLauncherExecHook,
  buildExecHook,
  buildShellCommand,
} from '../../src/build/hook-shell-template.js';
import { shellTemplateManifest, verifyClaudeCodeRuntimeHooksAreExecForm } from '../../scripts/build-hooks.js';

// Regression guard for plan-17 #3605: Claude Code runtime hooks are shell-free
// exec form. A `shell` key or a bash string brings back the per-hook bash →
// node → bun chain and its Windows console flash (#3559, #3521, #3396, #3248,
// #4121). Setup is the only shell-form entry; it fires only on
// `claude --init` / `--maintenance`.

const hooksJsonPath = path.resolve(import.meta.dir, '../../plugin/hooks/hooks.json');
const ENSURE_LAUNCHER_ARGS = ['${CLAUDE_PLUGIN_ROOT}/scripts/ensure-launcher.cjs'];
const FORBIDDEN_SHELL_FRAGMENTS = ['export PATH', '_P=', 'bash'];

interface RuntimeHookEntry {
  location: string;
  entry: Record<string, unknown>;
}

function claudeCodeRuntimeHookEntries(): RuntimeHookEntry[] {
  const parsed = JSON.parse(readFileSync(hooksJsonPath, 'utf-8')) as {
    hooks: Record<string, Array<{ hooks: Array<Record<string, unknown>> }>>;
  };
  return Object.entries(parsed.hooks)
    .filter(([eventName]) => eventName !== 'Setup')
    .flatMap(([eventName, groups]) =>
      groups.flatMap((group, groupIndex) =>
        group.hooks.map((entry, hookIndex) => ({ location: `${eventName}.${groupIndex}.${hookIndex}`, entry })),
      ),
    );
}

function allStringsIn(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(allStringsIn);
  if (value && typeof value === 'object') return Object.values(value).flatMap(allStringsIn);
  return [];
}

describe('plugin/hooks/hooks.json runtime hooks have no shell (#3605)', () => {
  const runtimeEntries = claudeCodeRuntimeHookEntries();

  it('has runtime entries to check', () => {
    expect(runtimeEntries.length).toBeGreaterThanOrEqual(8);
  });

  for (const { location, entry } of runtimeEntries) {
    it(`${location} is exec form: no shell key, args array, launcher command`, () => {
      expect(Object.prototype.hasOwnProperty.call(entry, 'shell')).toBe(false);
      expect(Array.isArray(entry.args)).toBe(true);
      const isLauncher = entry.command === 'claude-mem';
      const isEnsureLauncher = entry.command === 'node'
        && JSON.stringify(entry.args) === JSON.stringify(ENSURE_LAUNCHER_ARGS);
      expect({ location, isLauncherOrEnsureLauncher: isLauncher || isEnsureLauncher })
        .toEqual({ location, isLauncherOrEnsureLauncher: true });
      for (const text of allStringsIn(entry)) {
        for (const fragment of FORBIDDEN_SHELL_FRAGMENTS) {
          expect({ location, text, containsShellFragment: text.includes(fragment) })
            .toEqual({ location, text, containsShellFragment: false });
        }
      }
    });
  }

  it('has exactly one node entry, the SessionStart ensure-launcher self-heal', () => {
    const nodeEntries = runtimeEntries.filter(({ entry }) => entry.command === 'node');
    expect(nodeEntries.map(({ location }) => location)).toEqual(['SessionStart.1.0']);
  });
});

describe('build-hooks Rule A verifier rejects runtime entries outside the manifest (#3605)', () => {
  const claudeCodeExecEntries = shellTemplateManifest(
    buildShellCommand, buildCodexWindowsCommand, buildExecHook, buildEnsureLauncherExecHook,
  )['plugin/hooks/hooks.json'].execEntries;
  const verifyParsedHooks = (parsedHooks: unknown) => verifyClaudeCodeRuntimeHooksAreExecForm(
    parsedHooks, claudeCodeExecEntries, buildEnsureLauncherExecHook(), 'plugin/hooks/hooks.json',
  );
  const readCommittedHooks = () => JSON.parse(readFileSync(hooksJsonPath, 'utf-8'));

  it('accepts the committed hooks.json', () => {
    expect(() => verifyParsedHooks(readCommittedHooks())).not.toThrow();
  });

  it('rejects an extra claude-mem entry whose args are not in the manifest', () => {
    const parsedHooks = readCommittedHooks();
    parsedHooks.hooks.SessionStart[0].hooks.push({
      type: 'command', command: 'claude-mem', args: ['arbitrary', 'worker', 'arguments'],
    });
    expect(() => verifyParsedHooks(parsedHooks)).toThrow(
      'plugin/hooks/hooks.json (SessionStart.0.2) has claude-mem args ["arbitrary","worker","arguments"] that are not in the manifest',
    );
  });

  it('rejects a node entry that is not the ensure-launcher self-heal', () => {
    const parsedHooks = readCommittedHooks();
    parsedHooks.hooks.Stop[0].hooks.push({ type: 'command', command: 'node', args: ['/somewhere/else.cjs'] });
    expect(() => verifyParsedHooks(parsedHooks)).toThrow('(Stop.0.1) has command="node"');
  });
});
