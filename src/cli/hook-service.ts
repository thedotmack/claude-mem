#!/usr/bin/env bun
// Lightweight hook-only entry point. Runtime commands continue through the
// full worker-service bundle; bun-runner selects this sibling only for the
// already-recognized `worker-service.cjs hook <platform> <event>` shape.
import { isPluginDisabledInClaudeSettings } from '../shared/plugin-state.js';
import { logger } from '../utils/logger.js';
import { pathToFileURL } from 'node:url';
import { loadFromFileOnce } from '../shared/hook-settings.js';
import { selectRuntime } from '../services/hooks/runtime-selector.js';
import { getWorkerHost } from '../shared/worker-utils.js';
import { usesRemoteHookSpool } from '../shared/hook-spool-remote.js';
import type { HookCommandOptions } from './hook-command.js';

export function canRunInNode(platform: string, event: string): boolean {
  if (platform !== 'codex' || !['context', 'session-init', 'session-init-context', 'observation', 'summarize', 'post-compact', 'subagent-context'].includes(event)) return false;
  // File-read claims require Bun SQLite. Server mode and remote spool upload
  // retain their Bun runtime, including the uploader's process.execPath.
  return selectRuntime() === 'worker' && !usesRemoteHookSpool(getWorkerHost(), loadFromFileOnce().CLAUDE_MEM_HOOK_SPOOL_TRANSPORT);
}

export async function runHookService(platform: string, event: string, options: HookCommandOptions = {}): Promise<void> {
  if (!platform || !event) {
    process.stderr.write('Usage: hook-service hook <platform> <event>\n');
    process.exit(1);
  }
  try {
    if (isPluginDisabledInClaudeSettings()) {
      if (options.skipExit) return;
      process.exit(0);
    }

    const { restoreHookOriginalCwd } = await import('./hook-original-cwd.js');
    restoreHookOriginalCwd();
    const { hookCommand } = await import('./hook-command.js');
    await hookCommand(platform, event, options);
  } catch (error) {
    // Match the non-daemon worker entry point; never invoke the hook twice.
    logger.error('SYSTEM', 'Fatal error in main', {}, error instanceof Error ? error : undefined);
    if (options.skipExit) { process.exitCode = 0; return; }
    process.exit(0);
  }
}

// Importing the library from bun-runner must not consume its argv or stdin.
// The build maps import.meta.url to this CJS module's actual filename.
const isCommonJsMain = typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module;
if (isCommonJsMain || (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)) {
  const [, , command, platform, event] = process.argv;
  if (command !== 'hook') { process.stderr.write('Usage: hook-service hook <platform> <event>\n'); process.exit(1); }
  const isNode = !process.versions.bun;
  void runHookService(platform, event, { skipExit: isNode }).then(() => {
    if (isNode) {
      process.exitCode = 0;
      const input = process.stdin as typeof process.stdin & { unref?: () => void };
      input.unref?.();
    }
  });
}
