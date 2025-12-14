import { logger } from '../../utils/logger.js';
import { getWorkerRestartInstructions } from '../../utils/error-messages.js';

export interface HookErrorContext {
  hookName: string;
  operation: string;
  project?: string;
  sessionId?: string;
  toolName?: string;
  port?: number;
}

/**
 * Standardized error handler for hook fetch failures.
 *
 * This function:
 * 1. Logs the error with full context to worker logs
 * 2. Throws a user-facing error with restart instructions
 *
 * Use this for all fetch errors in hooks to ensure consistent error handling.
 */
export function handleFetchError(
  response: Response,
  errorText: string,
  context: HookErrorContext
): never {
  logger.error('HOOK', `${context.operation} failed`, {
    status: response.status,
    ...context
  }, errorText);

  const userMessage = context.toolName
    ? `Failed ${context.operation} for ${context.toolName}: ${getWorkerRestartInstructions()}`
    : `${context.operation} failed: ${getWorkerRestartInstructions()}`;

  throw new Error(userMessage);
}
