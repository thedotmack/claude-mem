/**
 * Hook Templates for System Integration
 * 
 * This module provides standardized templates for hook responses that integrate
 * with Claude Code's hook system. These templates ensure consistent formatting
 * and proper JSON structure for different hook events.
 * 
 * Based on Claude Code Hook Documentation v2025
 */

import { 
  BaseHookResponse, 
  PreCompactResponse, 
  SessionStartResponse, 
  PreToolUseResponse,
  HookPayload,
  PreCompactPayload,
  SessionStartPayload
} from '../../../shared/types.js';

// =============================================================================
// HOOK RESPONSE INTERFACES
// =============================================================================

/**
 * Context data for generating hook responses
 */
export interface HookResponseContext {
  /** The hook event name */
  hookEventName: string;
  /** Session identifier */
  sessionId: string;
  /** Whether the operation was successful */
  success: boolean;
  /** Optional message for the response */
  message?: string;
  /** Additional data specific to the hook type */
  additionalData?: Record<string, unknown>;
  /** Duration of the operation in milliseconds */
  duration?: number;
  /** Number of items processed */
  itemCount?: number;
}

/**
 * Progress information for long-running operations
 */
export interface OperationProgress {
  /** Current step number */
  current: number;
  /** Total number of steps */
  total: number;
  /** Description of current step */
  currentStep?: string;
  /** Estimated time remaining in milliseconds */
  estimatedRemaining?: number;
}

// =============================================================================
// PRE-COMPACT HOOK TEMPLATES
// =============================================================================

/**
 * Creates a successful pre-compact response that allows compression to proceed
 * PreCompact hooks do NOT support hookSpecificOutput according to documentation
 */
export function createPreCompactSuccessResponse(): PreCompactResponse {
  return {
    continue: true,
    suppressOutput: true
  };
}

/**
 * Creates a blocked pre-compact response that prevents compression
 */
export function createPreCompactBlockedResponse(reason: string): PreCompactResponse {
  return {
    continue: false,
    stopReason: reason,
    suppressOutput: true
  };
}

/**
 * Creates a pre-compact response with approval decision
 */
export function createPreCompactApprovalResponse(
  decision: 'approve' | 'block',
  reason?: string
): PreCompactResponse {
  return {
    decision,
    reason,
    continue: decision === 'approve',
    suppressOutput: true
  };
}

// =============================================================================
// SESSION START HOOK TEMPLATES
// =============================================================================

/**
 * Creates a successful session start response with loaded context
 * SessionStart hooks DO support hookSpecificOutput
 */
export function createSessionStartSuccessResponse(
  additionalContext?: string
): SessionStartResponse {
  return {
    continue: true,
    suppressOutput: true,
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext
    }
  };
}

/**
 * Creates a session start response when no context is available
 */
export function createSessionStartEmptyResponse(): SessionStartResponse {
  return {
    continue: true,
    suppressOutput: true,
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: 'Starting fresh session - no previous context available'
    }
  };
}

/**
 * Creates a session start response with error information
 */
export function createSessionStartErrorResponse(error: string): SessionStartResponse {
  return {
    continue: true, // Continue even if context loading fails
    suppressOutput: true,
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: `Context loading encountered an issue: ${error}. Starting without previous context.`
    }
  };
}

/**
 * Creates a rich session start response with memory summary
 */
export function createSessionStartMemoryResponse(memoryData: {
  projectName: string;
  memoryCount: number;
  lastSessionTime?: string;
  recentComponents?: string[];
  recentDecisions?: string[];
}): SessionStartResponse {
  const { projectName, memoryCount, lastSessionTime, recentComponents = [], recentDecisions = [] } = memoryData;
  
  const timeInfo = lastSessionTime ? ` (last worked: ${lastSessionTime})` : '';
  const contextParts: string[] = [];
  
  contextParts.push(`🧠 Loaded ${memoryCount} memories from previous sessions for ${projectName}${timeInfo}`);
  
  if (recentComponents.length > 0) {
    contextParts.push(`\n🎯 Recent components: ${recentComponents.slice(0, 3).join(', ')}`);
  }
  
  if (recentDecisions.length > 0) {
    contextParts.push(`\n🔄 Recent decisions: ${recentDecisions.slice(0, 2).join(', ')}`);
  }
  
  contextParts.push('\n💡 Use chroma_query_documents(["keywords"]) to find related work or chroma_get_documents(["document_id"]) to load specific content');
  
  return {
    continue: true,
    suppressOutput: true,
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: contextParts.join('')
    }
  };
}

// =============================================================================
// PRE-TOOL USE HOOK TEMPLATES
// =============================================================================

/**
 * Creates a pre-tool use response that allows the tool to execute
 */
export function createPreToolUseAllowResponse(reason?: string): PreToolUseResponse {
  return {
    continue: true,
    suppressOutput: true,
    permissionDecision: 'allow',
    permissionDecisionReason: reason
  };
}

/**
 * Creates a pre-tool use response that blocks the tool execution
 */
export function createPreToolUseDenyResponse(reason: string): PreToolUseResponse {
  return {
    continue: false,
    stopReason: reason,
    suppressOutput: true,
    permissionDecision: 'deny',
    permissionDecisionReason: reason
  };
}

/**
 * Creates a pre-tool use response that asks for user confirmation
 */
export function createPreToolUseAskResponse(reason: string): PreToolUseResponse {
  return {
    continue: true,
    suppressOutput: false, // Show output so user can see the question
    permissionDecision: 'ask',
    permissionDecisionReason: reason
  };
}

// =============================================================================
// GENERIC HOOK RESPONSE TEMPLATES
// =============================================================================

/**
 * Creates a basic success response for any hook type
 */
export function createHookSuccessResponse(suppressOutput = true): BaseHookResponse {
  return {
    continue: true,
    suppressOutput
  };
}

/**
 * Creates a basic error response for any hook type
 */
export function createHookErrorResponse(
  reason: string, 
  suppressOutput = true
): BaseHookResponse {
  return {
    continue: false,
    stopReason: reason,
    suppressOutput
  };
}

/**
 * Creates a response with system message (warning/info for user)
 */
export function createHookSystemMessageResponse(
  message: string,
  continueProcessing = true
): BaseHookResponse & { systemMessage: string } {
  return {
    continue: continueProcessing,
    suppressOutput: true,
    systemMessage: message
  };
}

// =============================================================================
// OPERATION STATUS TEMPLATES
// =============================================================================

/**
 * Templates for different types of operation status messages
 */
export const OPERATION_STATUS_TEMPLATES = {
  // Compression operations
  COMPRESSION_STARTED: 'Starting memory compression...',
  COMPRESSION_ANALYZING: 'Analyzing transcript content...',
  COMPRESSION_EXTRACTING: 'Extracting memories and connections...',
  COMPRESSION_SAVING: 'Saving compressed memories...',
  COMPRESSION_COMPLETE: (count: number, duration?: number) => 
    `Memory compression complete. Extracted ${count} memories${duration ? ` in ${Math.round(duration/1000)}s` : ''}`,
  
  // Context loading operations
  CONTEXT_LOADING: 'Loading previous session context...',
  CONTEXT_SEARCHING: 'Searching for relevant memories...',
  CONTEXT_FORMATTING: 'Organizing context for display...',
  CONTEXT_LOADED: (count: number) => `Context loaded successfully. Found ${count} relevant memories`,
  CONTEXT_EMPTY: 'No previous context found. Starting fresh session',
  
  // Tool operations
  TOOL_CHECKING: (toolName: string) => `Checking permissions for ${toolName}...`,
  TOOL_ALLOWED: (toolName: string) => `✅ ${toolName} execution approved`,
  TOOL_BLOCKED: (toolName: string, reason: string) => `❌ ${toolName} blocked: ${reason}`,
  
  // General operations
  OPERATION_STARTING: (operation: string) => `Starting ${operation}...`,
  OPERATION_PROGRESS: (operation: string, current: number, total: number) => 
    `${operation}: ${current}/${total} (${Math.round((current/total)*100)}%)`,
  OPERATION_COMPLETE: (operation: string) => `✅ ${operation} completed successfully`,
  OPERATION_FAILED: (operation: string, error: string) => `❌ ${operation} failed: ${error}`
} as const;

/**
 * Creates a progress message for long-running operations
 */
export function createProgressMessage(
  operation: string,
  progress: OperationProgress
): string {
  const { current, total, currentStep, estimatedRemaining } = progress;
  const percentage = Math.round((current / total) * 100);
  
  let message = `${operation}: ${current}/${total} (${percentage}%)`;
  
  if (currentStep) {
    message += ` - ${currentStep}`;
  }
  
  if (estimatedRemaining && estimatedRemaining > 1000) {
    const seconds = Math.round(estimatedRemaining / 1000);
    message += ` (${seconds}s remaining)`;
  }
  
  return message;
}

// =============================================================================
// ERROR RESPONSE TEMPLATES
// =============================================================================

/**
 * Standard error messages for different failure scenarios
 */
export const ERROR_RESPONSE_TEMPLATES = {
  // File system errors
  FILE_NOT_FOUND: (path: string) => `File not found: ${path}`,
  FILE_READ_ERROR: (path: string, error: string) => `Failed to read ${path}: ${error}`,
  FILE_WRITE_ERROR: (path: string, error: string) => `Failed to write ${path}: ${error}`,
  
  // Network/connection errors
  CONNECTION_FAILED: (service: string) => `Failed to connect to ${service}`,
  CONNECTION_TIMEOUT: (service: string) => `Connection to ${service} timed out`,
  
  // Validation errors
  INVALID_PAYLOAD: (field: string) => `Invalid or missing field: ${field}`,
  INVALID_FORMAT: (expected: string, received: string) => `Expected ${expected}, received ${received}`,
  
  // Operation errors
  OPERATION_TIMEOUT: (operation: string, timeout: number) => 
    `${operation} timed out after ${timeout}ms`,
  OPERATION_CANCELLED: (operation: string) => `${operation} was cancelled`,
  INSUFFICIENT_PERMISSIONS: (operation: string) => 
    `Insufficient permissions for ${operation}`,
  
  // Memory system errors
  MEMORY_SYSTEM_UNAVAILABLE: 'Memory system is not available',
  MEMORY_CORRUPTION: 'Memory index appears to be corrupted',
  MEMORY_SEARCH_FAILED: (query: string) => `Memory search failed for query: "${query}"`,
  
  // Compression errors
  COMPRESSION_FAILED: (stage: string) => `Compression failed during ${stage}`,
  INVALID_TRANSCRIPT: 'Transcript file is invalid or corrupted',
  
  // General errors
  UNKNOWN_ERROR: (context: string) => `An unexpected error occurred during ${context}`,
  SYSTEM_ERROR: (error: string) => `System error: ${error}`
} as const;

/**
 * Creates a standardized error response with troubleshooting guidance
 */
export function createDetailedErrorResponse(
  operation: string,
  error: string,
  troubleshootingSteps: string[] = []
): BaseHookResponse {
  const baseMessage = `${operation} failed: ${error}`;
  
  const fullMessage = troubleshootingSteps.length > 0
    ? `${baseMessage}\n\nTroubleshooting steps:\n${troubleshootingSteps.map(step => `• ${step}`).join('\n')}`
    : baseMessage;
  
  return {
    continue: false,
    stopReason: fullMessage,
    suppressOutput: false // Show error details to user
  };
}

// =============================================================================
// HOOK RESPONSE VALIDATION
// =============================================================================

/**
 * Validates that a hook response conforms to Claude Code expectations
 */
export function validateHookResponse(
  response: any,
  hookType: string
): { isValid: boolean; errors: string[] } {
  const errors: string[] = [];
  
  // Check required fields
  if (typeof response !== 'object' || response === null) {
    errors.push('Response must be a valid JSON object');
    return { isValid: false, errors };
  }
  
  // Validate continue field
  if (response.continue !== undefined && typeof response.continue !== 'boolean') {
    errors.push('continue field must be a boolean');
  }
  
  // Validate suppressOutput field
  if (response.suppressOutput !== undefined && typeof response.suppressOutput !== 'boolean') {
    errors.push('suppressOutput field must be a boolean');
  }
  
  // Validate stopReason field
  if (response.stopReason !== undefined && typeof response.stopReason !== 'string') {
    errors.push('stopReason field must be a string');
  }
  
  // Hook-specific validations
  if (hookType === 'PreCompact') {
    // PreCompact should not have hookSpecificOutput
    if (response.hookSpecificOutput !== undefined) {
      errors.push('PreCompact hooks do not support hookSpecificOutput');
    }
    
    // Validate decision field if present
    if (response.decision !== undefined && !['approve', 'block'].includes(response.decision)) {
      errors.push('decision field must be "approve" or "block"');
    }
  }
  
  if (hookType === 'SessionStart') {
    // Validate hookSpecificOutput structure
    if (response.hookSpecificOutput) {
      const hso = response.hookSpecificOutput;
      if (hso.hookEventName !== 'SessionStart') {
        errors.push('hookSpecificOutput.hookEventName must be "SessionStart"');
      }
      if (hso.additionalContext !== undefined && typeof hso.additionalContext !== 'string') {
        errors.push('hookSpecificOutput.additionalContext must be a string');
      }
    }
  }
  
  if (hookType === 'PreToolUse') {
    // Validate permissionDecision field
    if (response.permissionDecision !== undefined) {
      if (!['allow', 'deny', 'ask'].includes(response.permissionDecision)) {
        errors.push('permissionDecision must be "allow", "deny", or "ask"');
      }
    }
  }
  
  return {
    isValid: errors.length === 0,
    errors
  };
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Creates a hook response based on context and automatically handles hook-specific formatting
 */
export function createContextualHookResponse(context: HookResponseContext): BaseHookResponse {
  const { hookEventName, success, message, additionalData, duration, itemCount } = context;
  
  // Base response
  const response: BaseHookResponse = {
    continue: success,
    suppressOutput: true
  };
  
  // Add failure reason if not successful
  if (!success && message) {
    response.stopReason = message;
    response.suppressOutput = false; // Show error to user
  }
  
  // Handle hook-specific output
  if (success && hookEventName === 'SessionStart' && message) {
    return {
      ...response,
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: message
      }
    } as SessionStartResponse;
  }
  
  // Handle PreCompact approval
  if (hookEventName === 'PreCompact') {
    return {
      ...response,
      decision: success ? 'approve' : 'block',
      reason: message
    } as PreCompactResponse;
  }
  
  return response;
}

/**
 * Formats duration in milliseconds to human-readable format
 */
export function formatDuration(milliseconds: number): string {
  if (milliseconds < 1000) {
    return `${milliseconds}ms`;
  }
  
  const seconds = Math.round(milliseconds / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
}

/**
 * Creates a summary line for operation completion
 */
export function createOperationSummary(
  operation: string,
  success: boolean,
  duration?: number,
  itemCount?: number,
  details?: string
): string {
  const status = success ? '✅' : '❌';
  const durationText = duration ? ` in ${formatDuration(duration)}` : '';
  const itemText = itemCount ? ` (${itemCount} items)` : '';
  const detailText = details ? ` - ${details}` : '';
  
  return `${status} ${operation}${itemText}${durationText}${detailText}`;
}