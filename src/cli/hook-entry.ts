/**
 * Thin entry for `claude-mem hook <platform> <event>`.
 *
 * Every agent hook is a short-lived process. Loading the whole worker bundle
 * for it costs ~0.3 s of parse time and ~120 MB per hook; with several agents
 * starting at once that is the dominant CPU cost. This bundle carries only the
 * hook pipeline and mirrors the `hook` branch of `main()` in worker-service.ts.
 * The worker-service.cjs shim (src/services/worker-service-shim.ts) routes
 * `hook` here, so the version-stable launcher contract is unchanged.
 */
import { isPluginDisabledInClaudeSettings } from '../shared/plugin-state.js';
import { isHookStdoutClosed } from '../shared/hook-io.js';
import { restoreHookOriginalCwd } from './hook-original-cwd.js';
import { hookCommand } from './hook-command.js';
import { logger } from '../utils/logger.js';

async function main(): Promise<void> {
  if (isPluginDisabledInClaudeSettings()) {
    logger.info('SYSTEM', 'Worker not starting: claude-mem is disabled in Claude settings (enabledPlugins["claude-mem@thedotmack"] === false). Re-enable the plugin to resume memory capture.', {
      command: 'hook',
      configDir: process.env.CLAUDE_CONFIG_DIR || '~/.claude',
    });
    process.exit(0);
  }

  // argv: [runtime, script, 'hook', platform, event]
  const platform = process.argv[3];
  const event = process.argv[4];
  if (!platform || !event) {
    console.error('Usage: claude-mem hook <platform> <event>');
    console.error('Platforms: claude-code, codex, cursor, antigravity-cli, raw');
    console.error('Events: context, session-init, observation, summarize, user-message');
    process.exit(1);
  }

  restoreHookOriginalCwd();
  await hookCommand(platform, event);
}

main().catch((error) => {
  if (isHookStdoutClosed(error)) {
    logger.debug('SYSTEM', 'Hook output not delivered: session already closed (EPIPE)');
    process.exit(0);
  }
  logger.error('SYSTEM', 'Fatal error in main', {}, error instanceof Error ? error : undefined);
  process.exit(0);
});
