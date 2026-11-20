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
      'plugin/hooks/hooks.json (SessionStart.0.1) has claude-mem args ["arbitrary","worker","arguments"] that are not in the manifest',
    );
  });

  it('rejects a node entry that is not the ensure-launcher self-heal', () => {
    const parsedHooks = readCommittedHooks();
    parsedHooks.hooks.Stop[0].hooks.push({ type: 'command', command: 'node', args: ['/somewhere/else.cjs'] });
    expect(() => verifyParsedHooks(parsedHooks)).toThrow('(Stop.0.1) has command="node"');
  });
});
