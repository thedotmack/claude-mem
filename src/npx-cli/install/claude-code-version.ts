/**
 * Claude Code CLI version detection and the minimum version claude-mem's
 * exec-form hooks need.
 */

import { spawnSync } from 'child_process';
import { buildSpawnSyncInvocation, lookupWindowsCommand } from '../../shared/spawn.js';

/**
 * Claude Code CHANGELOG, `## 2.1.139`: "Added hook `args: string[]` field
 * (exec form)…". plugin/hooks/hooks.json runs every runtime hook as
 * `{"command": "claude-mem", "args": [...]}`. An older Claude Code ignores
 * `args` and runs bare `claude-mem`, which prints usage and exits 0, so
 * nothing is captured and the user is not told.
 */
export const MINIMUM_CLAUDE_CODE_VERSION_FOR_EXEC_FORM_HOOKS = '2.1.139';

/**
 * Claude Code CLI version, best effort. Hook/plugin behavior differs across
 * Claude Code releases, so this is key for diagnosing installs whose worker
 * never starts. Missing binary or timeout → undefined.
 */
function readClaudeCodeVersionOutput(): string | undefined {
  const command = process.platform === 'win32'
    ? (lookupWindowsCommand('claude') ?? 'claude.cmd')
    : 'claude';
  const invocation = buildSpawnSyncInvocation(command, ['--version'], {
    timeout: 5000,
    encoding: 'utf-8',
  });
  const result = spawnSync(invocation.command, invocation.args, invocation.options);
  const output = (result.stdout ?? '').trim();
  if (!output) return undefined;
  // "2.0.14 (Claude Code)" → "2.0.14"
  return output.split(/\s+/)[0].slice(0, 40) || undefined;
}

export function detectClaudeCodeVersion(): string | undefined {
  try {
    return readClaudeCodeVersionOutput();
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    console.warn('[install] Could not detect Claude Code version:', err);
    return undefined;
  }
}

function parseMajorMinorPatch(version: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/**
 * The user-facing warning when `detectedClaudeCodeVersion` is older than the
 * exec-form minimum; null when it is new enough, missing or unparseable (an
 * unknown version is not evidence of an old one).
 */
export function claudeCodeVersionTooOldWarning(detectedClaudeCodeVersion: string | undefined): string | null {
  if (!detectedClaudeCodeVersion) return null;
  const detected = parseMajorMinorPatch(detectedClaudeCodeVersion);
  const minimum = parseMajorMinorPatch(MINIMUM_CLAUDE_CODE_VERSION_FOR_EXEC_FORM_HOOKS)!;
  if (!detected) return null;
  for (let index = 0; index < 3; index++) {
    if (detected[index] > minimum[index]) return null;
    if (detected[index] < minimum[index]) {
      return `Claude Code ${detectedClaudeCodeVersion} is older than ${MINIMUM_CLAUDE_CODE_VERSION_FOR_EXEC_FORM_HOOKS}; ` +
        `claude-mem hooks need ${MINIMUM_CLAUDE_CODE_VERSION_FOR_EXEC_FORM_HOOKS}+. Update Claude Code: claude update`;
    }
  }
  return null;
}
