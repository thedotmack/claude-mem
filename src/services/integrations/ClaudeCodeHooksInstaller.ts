import { readFileSync, writeFileSync } from 'fs';
import path from 'path';

interface ClaudeCodeHookCommand {
  type: 'command';
  command: string;
  args?: string[];
  shell?: string;
  timeout?: number;
}

interface ClaudeCodeHookGroup {
  matcher?: string;
  hooks: ClaudeCodeHookCommand[];
}

interface ClaudeCodeHooksJson {
  description: string;
  hooks: Record<string, ClaudeCodeHookGroup[]>;
}

type HookTarget = {
  event: string;
  groupIndex: number;
  hookIndex: number;
  args: string[];
};

const WINDOWS_CLAUDE_CODE_HOOKS: HookTarget[] = [
  { event: 'Setup', groupIndex: 0, hookIndex: 0, args: ['version-check.js'] },
  { event: 'SessionStart', groupIndex: 0, hookIndex: 0, args: ['bun-runner.js', '--hook-continue-json', 'worker-service.cjs', 'start'] },
  { event: 'SessionStart', groupIndex: 0, hookIndex: 1, args: ['bun-runner.js', 'worker-service.cjs', 'hook', 'claude-code', 'context'] },
  { event: 'UserPromptSubmit', groupIndex: 0, hookIndex: 0, args: ['bun-runner.js', 'worker-service.cjs', 'hook', 'claude-code', 'session-init'] },
  { event: 'PostToolUse', groupIndex: 0, hookIndex: 0, args: ['bun-runner.js', 'worker-service.cjs', 'hook', 'claude-code', 'observation'] },
  { event: 'PreToolUse', groupIndex: 0, hookIndex: 0, args: ['bun-runner.js', 'worker-service.cjs', 'hook', 'claude-code', 'file-context'] },
  { event: 'Stop', groupIndex: 0, hookIndex: 0, args: ['bun-runner.js', 'worker-service.cjs', 'hook', 'claude-code', 'summarize'] },
];

function resolveScriptArgs(pluginRoot: string, relativeArgs: string[]): string[] {
  return relativeArgs.map((arg) => {
    if (!arg.endsWith('.js') && !arg.endsWith('.cjs')) return arg;
    return path.join(pluginRoot, 'scripts', arg);
  });
}

export function rewriteInstalledClaudeCodeHooksForWindows(pluginRoot: string, nodePath: string = process.execPath): void {
  const hooksPath = path.join(pluginRoot, 'hooks', 'hooks.json');
  const parsed = JSON.parse(readFileSync(hooksPath, 'utf-8')) as ClaudeCodeHooksJson;

  for (const target of WINDOWS_CLAUDE_CODE_HOOKS) {
    const hook = parsed.hooks?.[target.event]?.[target.groupIndex]?.hooks?.[target.hookIndex];
    if (!hook) {
      throw new Error(`Claude Code hook ${target.event}.${target.groupIndex}.${target.hookIndex} missing in ${hooksPath}`);
    }
    hook.command = nodePath;
    hook.args = resolveScriptArgs(pluginRoot, target.args);
    delete hook.shell;
  }

  writeFileSync(hooksPath, JSON.stringify(parsed, null, 2) + '\n');
}
