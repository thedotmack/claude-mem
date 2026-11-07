import { logger } from '../utils/logger.js';

/**
 * bun-runner.js starts Bun in a neutral directory so Bun never reads the
 * project's tsconfig.json and prints its warnings as hook errors (#4628). It
 * passes the directory the host launched the hook from in this variable, and
 * the hook entry point moves back there before any adapter runs, because
 * adapters whose payload carries no `cwd` fall back to process.cwd() to find
 * the project.
 */
export const HOOK_ORIGINAL_CWD_ENV = 'CLAUDE_MEM_HOOK_ORIGINAL_CWD';

export function restoreHookOriginalCwd(
  env: NodeJS.ProcessEnv = process.env,
  changeDirectory: (directory: string) => void = (directory) => process.chdir(directory),
): void {
  const originalCwd = env[HOOK_ORIGINAL_CWD_ENV];
  // Consumed here so a worker daemon started from this hook doesn't inherit it.
  delete env[HOOK_ORIGINAL_CWD_ENV];
  if (!originalCwd) return;
  try {
    changeDirectory(originalCwd);
  } catch (error: unknown) {
    // The launch directory is gone; stay in the neutral one. Payload `cwd`
    // still wins in every adapter, so only cwd-less hosts lose attribution.
    logger.warn('HOOK', `Could not return to the hook launch directory ${originalCwd}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
