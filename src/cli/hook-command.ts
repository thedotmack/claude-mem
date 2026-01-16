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
    console.error(`Hook error: ${error}`);
    // Use exit code 2 (blocking error) so users see the error message
    // Exit code 1 only shows in verbose mode per Claude Code docs
    if (!options.skipExit) {
      process.exit(HOOK_EXIT_CODES.BLOCKING_ERROR);  // = 2
    }
    return HOOK_EXIT_CODES.BLOCKING_ERROR;
  }
}
