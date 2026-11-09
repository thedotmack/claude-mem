/**
 * `claude-mem hook <platform> <event>`: the one implementation shared by the
 * full worker bundle (worker-service.ts `case 'hook'`) and the hook-only bundle
 * (hook-entry.ts), so the two entry points cannot drift.
 *
 * IO discipline: once hookCommand is invoked, src/shared/hook-io.ts owns all
 * stdout/stderr/exit. The missing-args path below is CLI-style (console.error +
 * exit 1) because it runs BEFORE the buffered window opens.
 */
import { restoreHookOriginalCwd } from './hook-original-cwd.js';
import { hookCommand } from './hook-command.js';

export async function runHookSubcommand(platform: string | undefined, event: string | undefined): Promise<void> {
  if (!platform || !event) {
    console.error('Usage: claude-mem hook <platform> <event>');
    console.error('Platforms: claude-code, codex, cursor, antigravity-cli, raw');
    console.error('Events: context, session-init, observation, summarize, user-message');
    process.exit(1);
  }

  restoreHookOriginalCwd();
  await hookCommand(platform, event);
}
