#!/usr/bin/env bun
// Lightweight hook-only entry point. Runtime commands continue through the
// full worker-service bundle; bun-runner selects this sibling only for the
// already-recognized `worker-service.cjs hook <platform> <event>` shape.
import { isPluginDisabledInClaudeSettings } from '../shared/plugin-state.js';
import { logger } from '../utils/logger.js';

async function main(): Promise<void> {
  const [, , command, platform, event] = process.argv;
  if (command !== 'hook' || !platform || !event) {
    process.stderr.write('Usage: hook-service hook <platform> <event>\n');
    process.exit(1);
  }
  if (isPluginDisabledInClaudeSettings()) process.exit(0);

  const { restoreHookOriginalCwd } = await import('./hook-original-cwd.js');
  restoreHookOriginalCwd();
  const { hookCommand } = await import('./hook-command.js');
  await hookCommand(platform, event);
}

void main().catch((error) => {
  // Match the non-daemon worker entry point: a hook failure is diagnostic and
  // must not block the host. hookCommand owns stdout flushing and normal exit.
  logger.error('SYSTEM', 'Fatal error in main', {}, error instanceof Error ? error : undefined);
  process.exit(0);
});
