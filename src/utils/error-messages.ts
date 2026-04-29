
export interface WorkerErrorMessageOptions {
  port?: number;
  includeSkillFallback?: boolean;
  customPrefix?: string;
  actualError?: string;
}

export function getWorkerRestartInstructions(
  options: WorkerErrorMessageOptions = {}
): string {
  const {
    port,
    includeSkillFallback = false,
    customPrefix,
    actualError
  } = options;

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

  if (actualError) {
    message = `Worker Error: ${actualError}\n\n${message}`;
  }

  return message;
}
