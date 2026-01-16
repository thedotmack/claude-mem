/**
 * Resume Logic Module
 *
 * Centralized logic for determining whether to pass the resume parameter
 * to the Claude Agent SDK. This module is extracted for testability and
 * to ensure consistent behavior across the codebase.
 *
 * The resume parameter should ONLY be passed when ALL conditions are met:
 * 1. memorySessionId exists (was captured from a previous SDK response)
 * 2. lastPromptNumber > 1 (this is a continuation within the same SDK session)
 * 3. Session was NOT initialized via startup-recovery (SDK context was lost)
 */

export interface ResumeDecisionInput {
  memorySessionId: string | null;
  lastPromptNumber: number;
  isStartupRecovery: boolean;
}

/**
 * Determine whether to pass the resume parameter to the SDK query.
 *
 * @param input - The session state to evaluate
 * @returns true if the resume parameter should be passed, false otherwise
 */
export function shouldPassResumeParameter(input: ResumeDecisionInput): boolean {
  const hasRealMemorySessionId = !!input.memorySessionId;

  // Never resume if this is a startup-recovery session
  // The SDK context was lost when the worker restarted
  if (input.isStartupRecovery) {
    return false;
  }

  // Resume only if we have a valid memorySessionId AND this is a continuation (prompt > 1)
  return hasRealMemorySessionId && input.lastPromptNumber > 1;
}
