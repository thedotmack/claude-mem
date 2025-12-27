/**
 * Platform-aware error message generator for worker connection failures
 */

export interface WorkerErrorMessageOptions {
  port?: number;
  includeSkillFallback?: boolean;
  customPrefix?: string;
  actualError?: string;
}

/**
 * Generate platform-specific worker restart instructions
 * @param options Configuration for error message generation
 * @returns Formatted error message with platform-specific paths and commands
 */
export function getWorkerRestartInstructions(
  options: WorkerErrorMessageOptions = {}
): string {
  const {
    port,
    includeSkillFallback = false,
    customPrefix,
    actualError
  } = options;

  // Build error message
  const prefix = customPrefix || 'Worker service connection failed.';
  const portInfo = port ? ` (port ${port})` : '';

  let message = `${prefix}${portInfo}\n\n`;
  message += `To restart the worker:\n`;
  message += `1. Exit Claude Code completely\n`;
  message += `2. Run: npm run worker:restart\n`;
  message += `3. Restart Claude Code`;

  if (includeSkillFallback) {
    message += `\n\nIf that doesn't work, try: /troubleshoot`;
  }

  // Prepend actual error if provided
  if (actualError) {
    message = `Worker Error: ${actualError}\n\n${message}`;
  }

  return message;
}
