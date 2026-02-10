import { readJsonFromStdin } from './stdin-reader.js';
import { getPlatformAdapter } from './adapters/index.js';
import { getEventHandler } from './handlers/index.js';
import { HOOK_EXIT_CODES } from '../shared/hook-constants.js';

export interface HookCommandOptions {
  /** If true, don't call process.exit() - let caller handle process lifecycle */
  skipExit?: boolean;
}

export async function hookCommand(platform: string, event: string, options: HookCommandOptions = {}): Promise<number> {
  try {
    const adapter = getPlatformAdapter(platform);
    const handler = getEventHandler(event);

    const rawInput = await readJsonFromStdin();
    const input = adapter.normalizeInput(rawInput);
    input.platform = platform;  // Inject platform for handler-level decisions
    const result = await handler.execute(input);
    const output = adapter.formatOutput(result);

    console.log(JSON.stringify(output));
    const exitCode = result.exitCode ?? HOOK_EXIT_CODES.SUCCESS;
    if (!options.skipExit) {
      process.exit(exitCode);
    }
    return exitCode;
  } catch (error) {
    // Exit code 0 to prevent Windows Terminal tab accumulation and avoid
    // showing confusing "hook error" messages to users (Issue #897).
    // Hook/worker errors are non-fatal - claude-mem failing should never
    // block the user's Claude Code session.
    console.error(`Hook error (non-blocking): ${error}`);
    if (!options.skipExit) {
      process.exit(HOOK_EXIT_CODES.SUCCESS);
    }
    return HOOK_EXIT_CODES.SUCCESS;
  }
}
