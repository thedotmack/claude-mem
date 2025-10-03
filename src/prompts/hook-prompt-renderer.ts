/**
 * Hook Prompt Renderer
 *
 * Simple template rendering for hook prompts.
 * Handles variable substitution and auto-truncation.
 */

import {
  PROMPTS,
  HOOK_CONFIG,
  type SystemPromptVariables,
  type ToolMessageVariables,
  type EndMessageVariables,
} from './hook-prompts.config.js';

// =============================================================================
// TEMPLATE RENDERING
// =============================================================================

/**
 * Simple template variable substitution
 * Replaces {{variableName}} with actual values
 */
function substituteVariables(
  template: string,
  variables: Record<string, string>
): string {
  let result = template;

  for (const [key, value] of Object.entries(variables)) {
    const placeholder = `{{${key}}}`;
    // Replace all occurrences of this placeholder
    result = result.split(placeholder).join(value);
  }

  return result;
}

/**
 * Truncate text with ellipsis if it exceeds maxLength
 */
function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + (text.length > maxLength ? '...' : '');
}

/**
 * Format timestamp for tool message header
 * Extracts HH:MM:SS from ISO timestamp
 */
function formatTime(timestamp: string): string {
  const timePart = timestamp.split('T')[1];
  if (!timePart) return '';
  return timePart.slice(0, 8); // HH:MM:SS
}

// =============================================================================
// PUBLIC RENDERING FUNCTIONS
// =============================================================================

/**
 * Render system prompt for SDK session initialization
 */
export function renderSystemPrompt(
  variables: SystemPromptVariables
): string {
  // Auto-truncate userPrompt
  const userPromptTruncated = truncate(
    variables.userPrompt,
    HOOK_CONFIG.maxUserPromptLength
  );

  return substituteVariables(PROMPTS.system, {
    project: variables.project,
    sessionId: variables.sessionId,
    date: variables.date,
    userPrompt: userPromptTruncated,
  });
}

/**
 * Render tool message for SDK processing
 */
export function renderToolMessage(
  variables: ToolMessageVariables
): string {
  // Auto-truncate userPrompt and toolResponse
  const userPromptTruncated = truncate(
    variables.userPrompt,
    HOOK_CONFIG.maxUserPromptLength
  );

  const toolResponseTruncated = truncate(
    variables.toolResponse,
    HOOK_CONFIG.maxToolResponseLength
  );

  // Format timestamp
  const timeFormatted = formatTime(variables.timestamp);

  return substituteVariables(PROMPTS.tool, {
    toolName: variables.toolName,
    toolResponse: toolResponseTruncated,
    userPrompt: userPromptTruncated,
    timestamp: variables.timestamp,
    timeFormatted,
  });
}

/**
 * Render end message for session completion
 */
export function renderEndMessage(
  variables: EndMessageVariables
): string {
  return substituteVariables(PROMPTS.end, {
    project: variables.project,
    sessionId: variables.sessionId,
  });
}

// =============================================================================
// GENERIC RENDERER (for convenience)
// =============================================================================

export type PromptType = 'system' | 'tool' | 'end';

export type PromptVariables<T extends PromptType> = T extends 'system'
  ? SystemPromptVariables
  : T extends 'tool'
    ? ToolMessageVariables
    : T extends 'end'
      ? EndMessageVariables
      : never;

/**
 * Generic prompt renderer - dispatches to specific renderer based on type
 */
export function renderPrompt<T extends PromptType>(
  type: T,
  variables: PromptVariables<T>
): string {
  switch (type) {
    case 'system':
      return renderSystemPrompt(variables as SystemPromptVariables);
    case 'tool':
      return renderToolMessage(variables as ToolMessageVariables);
    case 'end':
      return renderEndMessage(variables as EndMessageVariables);
    default:
      throw new Error(`Unknown prompt type: ${type}`);
  }
}

// =============================================================================
// EXPORTS
// =============================================================================

export { HOOK_CONFIG, PROMPTS };
