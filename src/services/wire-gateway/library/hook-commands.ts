// SPDX-License-Identifier: Apache-2.0
//
// The `bun worker-service.cjs hook <platform> <event>` command every hook
// item runs (plan Phase 14 task 1), spelled the way each agent executes it.
// Before the Library each installer built its own (Cursor, Windsurf, Kimi,
// Antigravity). Paths are absolute (install-paths.ts, Rule B): these agents
// do no `${CLAUDE_PLUGIN_ROOT}` substitution.

import { execSync } from 'child_process';
import { logger } from '../../../utils/logger.js';

/**
 * Neutral hook events (plan task 1) and each agent's own name for them
 * (Appendix B; magpie hooks.go:84-133 `hookSpecOf`).
 */
export type NeutralHookEvent = 'session-start' | 'prompt' | 'before-tool' | 'after-tool' | 'turn-end';

export const NATIVE_HOOK_EVENTS: Readonly<Record<'claude-code' | 'codex' | 'gemini-cli' | 'cursor', Readonly<Record<NeutralHookEvent, string>>>> = {
  'claude-code': { 'session-start': 'SessionStart', prompt: 'UserPromptSubmit', 'before-tool': 'PreToolUse', 'after-tool': 'PostToolUse', 'turn-end': 'Stop' },
  codex: { 'session-start': 'SessionStart', prompt: 'UserPromptSubmit', 'before-tool': 'PreToolUse', 'after-tool': 'PostToolUse', 'turn-end': 'Stop' },
  'gemini-cli': { 'session-start': 'SessionStart', prompt: 'BeforeAgent', 'before-tool': 'BeforeTool', 'after-tool': 'AfterTool', 'turn-end': 'AfterAgent' },
  cursor: { 'session-start': 'sessionStart', prompt: 'beforeSubmitPrompt', 'before-tool': 'preToolUse', 'after-tool': 'postToolUse', 'turn-end': 'stop' },
};

/**
 * How the agent runs a hook's command string:
 *  - `shell-quoted`: through a shell (Windsurf); PowerShell needs `& ` before a quoted path.
 *  - `shell-quoted-json-escaped`: through a shell, with backslashes doubled (Cursor).
 *  - `split-on-spaces`: split on spaces with no quote handling (agy): bare, forward-slashed paths.
 *  - `toml-literal`: a shell command inside a TOML literal string (Kimi).
 */
export type HookCommandStyle = 'shell-quoted' | 'shell-quoted-json-escaped' | 'split-on-spaces' | 'toml-literal';

export interface WorkerHookCommandInput {
  bunPath: string;
  workerServicePath: string;
  /** What follows the worker path: `hook windsurf session-init`, or `start`. */
  args: string;
  style: HookCommandStyle;
  platform?: NodeJS.Platform;
}

/**
 * `agy` splits a command on spaces and does not strip quotes, so a path with
 * a space cannot be quoted: on Windows the 8.3 short path removes the space;
 * elsewhere (or when 8.3 names are off) the path is kept and a warning logged.
 */
function toSpaceFreePath(filePath: string, platform: NodeJS.Platform): string {
  if (!filePath.includes(' ')) return filePath;
  if (platform !== 'win32') {
    logger.warn('LIBRARY', 'Antigravity CLI hook path contains spaces; agy splits commands on spaces, so hooks may fail to launch. Move bun or the plugin to a path without spaces.', { path: filePath });
    return filePath;
  }
  try {
    const shortPath = execSync(`for %~I in ("${filePath}") do @echo %~sI`, { shell: 'cmd.exe', encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
    if (shortPath && !shortPath.includes(' ')) return shortPath;
  } catch (error) {
    logger.error('LIBRARY', 'Failed to resolve Windows 8.3 short path', { path: filePath }, error instanceof Error ? error : new Error(String(error)));
  }
  logger.warn('LIBRARY', 'Antigravity CLI hook path contains spaces and 8.3 short-path resolution failed; hooks may fail to launch.', { path: filePath });
  return filePath;
}

export function buildWorkerHookCommand(input: WorkerHookCommandInput): string {
  const platform = input.platform ?? process.platform;
  switch (input.style) {
    case 'shell-quoted': {
      const callOperator = platform === 'win32' ? '& ' : '';
      return `${callOperator}"${input.bunPath}" "${input.workerServicePath}" ${input.args}`;
    }
    case 'shell-quoted-json-escaped': {
      const callOperator = platform === 'win32' ? '& ' : '';
      return `${callOperator}"${input.bunPath.replace(/\\/g, '\\\\')}" "${input.workerServicePath.replace(/\\/g, '\\\\')}" ${input.args}`;
    }
    case 'split-on-spaces': {
      const bun = toSpaceFreePath(input.bunPath, platform).replace(/\\/g, '/');
      const worker = toSpaceFreePath(input.workerServicePath, platform).replace(/\\/g, '/');
      return `${bun} ${worker} ${input.args}`;
    }
    case 'toml-literal':
      return `'"${input.bunPath}" "${input.workerServicePath}" ${input.args}'`;
  }
}

/** Whether a hook command is one claude-mem's unified CLI wrote for `platform` (`worker-service … hook <platform> …`). */
export function isWorkerHookCommandFor(command: unknown, platformMarker: string): boolean {
  return typeof command === 'string' && command.includes('worker-service') && command.includes(platformMarker);
}
