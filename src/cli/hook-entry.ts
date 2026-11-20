/**
 * Thin entry for `claude-mem hook <platform> <event>`, built to
 * plugin/scripts/hook-service.cjs.
 *
 * Every agent hook is a short-lived process. Loading the whole worker bundle
 * for it costs ~0.3 s of parse time and ~120 MB per hook; with several agents
 * starting at once that is the dominant CPU cost. This bundle carries only the
 * hook pipeline. The compiled launcher (src/launcher/claude-mem-launcher.ts)
 * and plugin/scripts/bun-runner.js run it for `hook` when it exists and fall
 * back to worker-service.cjs otherwise. The subcommand itself is
 * runHookSubcommand, the same function worker-service.ts runs for `hook`.
 */
import { isPluginDisabledInClaudeSettings } from '../shared/plugin-state.js';
import { isHookStdoutClosed } from '../shared/hook-io.js';
import { runHookSubcommand } from './run-hook-subcommand.js';
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
  await runHookSubcommand(process.argv[3], process.argv[4]);
}

main().catch((error) => {
  if (isHookStdoutClosed(error)) {
    logger.debug('SYSTEM', 'Hook output not delivered: session already closed (EPIPE)');
    process.exit(0);
  }
  logger.error('SYSTEM', 'Fatal error in main', {}, error instanceof Error ? error : undefined);
  process.exit(0);
});
