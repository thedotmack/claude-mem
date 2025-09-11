/**
 * PromptOrchestrator - Single source of truth for all prompt generation
 * 
 * This class serves as the central orchestrator for generating different types of prompts
 * used throughout the claude-mem system. It provides clear, well-typed interfaces and
 * methods for creating prompts for LLM analysis, human context, and system integration.
 */

import { createAnalysisPrompt } from '../../prompts/templates/analysis/AnalysisTemplates.js';

// =============================================================================
// CORE INTERFACES
// =============================================================================

/**
 * Context data for LLM analysis prompts
 */
export interface AnalysisContext {
  /** The transcript content to analyze */
  transcriptContent: string;
  /** Session identifier */
  sessionId: string;
  /** Project name for context */
  projectName?: string;
  /** Custom analysis instructions */
  customInstructions?: string;
  /** Compression trigger type */
  trigger?: 'manual' | 'auto';
  /** Original token count */
  originalTokens?: number;
  /** Target compression ratio */
  targetCompressionRatio?: number;
}

/**
 * Context data for human-facing session prompts
 */
export interface SessionContext {
  /** Session identifier */
  sessionId: string;
  /** Source of the session start */
  source: 'startup' | 'compact' | 'vscode' | 'web';
  /** Project name */
  projectName?: string;
  /** Additional context to provide to the human */
  additionalContext?: string;
  /** Path to the transcript file */
  transcriptPath?: string;
  /** Working directory */
  cwd?: string;
}

/**
 * Context data for hook response generation
 */
export interface HookContext {
  /** The hook event name */
  hookEventName: string;
  /** Session identifier */
  sessionId: string;
  /** Success status */
  success: boolean;
  /** Optional message */
  message?: string;
  /** Additional data specific to the hook */
  data?: Record<string, unknown>;
  /** Whether to continue processing */
  shouldContinue?: boolean;
  /** Reason for stopping if applicable */
  stopReason?: string;
}

/**
 * Generated analysis prompt for LLM consumption
 */
export interface AnalysisPrompt {
  /** The formatted prompt text */
  prompt: string;
  /** Context used to generate the prompt */
  context: AnalysisContext;
  /** Prompt type identifier */
  type: 'analysis';
  /** Generated timestamp */
  timestamp: string;
}

/**
 * Generated session prompt for human context
 */
export interface SessionPrompt {
  /** The formatted message text */
  message: string;
  /** Context used to generate the prompt */
  context: SessionContext;
  /** Prompt type identifier */
  type: 'session';
  /** Generated timestamp */
  timestamp: string;
}

/**
 * Generated hook response
 */
export interface HookResponse {
  /** Whether to continue processing */
  continue: boolean;
  /** Reason for stopping if continue is false */
  stopReason?: string;
  /** Whether to suppress output */
  suppressOutput?: boolean;
  /** Hook-specific output data */
  hookSpecificOutput?: Record<string, unknown>;
  /** Context used to generate the response */
  context: HookContext;
  /** Response type identifier */
  type: 'hook';
  /** Generated timestamp */
  timestamp: string;
}

// =============================================================================
// PROMPT ORCHESTRATOR CLASS
// =============================================================================

/**
 * Central orchestrator for all prompt generation in the claude-mem system
 */
export class PromptOrchestrator {
  private projectName: string;

  constructor(projectName = 'claude-mem') {
    this.projectName = projectName;
  }

  /**
   * Creates an analysis prompt for LLM processing of transcript content
   */
  public createAnalysisPrompt(context: AnalysisContext): AnalysisPrompt {
    const timestamp = new Date().toISOString();
    
    const prompt = this.buildAnalysisPrompt(context);

    return {
      prompt,
      context,
      type: 'analysis',
      timestamp,
    };
  }

  /**
   * Creates a session start prompt for human context
   */
  public createSessionStartPrompt(context: SessionContext): SessionPrompt {
    const timestamp = new Date().toISOString();
    
    const message = this.buildSessionStartMessage(context);

    return {
      message,
      context,
      type: 'session',
      timestamp,
    };
  }

  /**
   * Creates a hook response for system integration
   */
  public createHookResponse(context: HookContext): HookResponse {
    const timestamp = new Date().toISOString();

    const response = this.buildHookResponse(context);

    return {
      ...response,
      context,
      type: 'hook',
      timestamp,
    };
  }

  // =============================================================================
  // PRIVATE PROMPT BUILDERS
  // =============================================================================

  private buildAnalysisPrompt(context: AnalysisContext): string {
    const {
      transcriptContent,
      sessionId,
      projectName = this.projectName,
    } = context;

    // Extract project prefix from project name (convert to snake_case)
    const projectPrefix = projectName.replace(/[-\s]/g, '_').toLowerCase();

    // Use the simple prompt with the transcript included
    return createAnalysisPrompt(
      transcriptContent,
      sessionId,
      projectPrefix
    );
  }

  private buildSessionStartMessage(context: SessionContext): string {
    const {
      sessionId,
      source,
      projectName = this.projectName,
      additionalContext,
      transcriptPath,
      cwd,
    } = context;

    let message = `## Session Started (${source})

**Project**: ${projectName}  
**Session ID**: ${sessionId}  `;

    if (transcriptPath) {
      message += `**Transcript**: ${transcriptPath}  `;
    }

    if (cwd) {
      message += `**Working Directory**: ${cwd}  `;
    }

    if (additionalContext) {
      message += `\n### Additional Context\n${additionalContext}`;
    }

    message += `\n\nMemory system is active and ready to preserve context across sessions.`;

    return message;
  }

  private buildHookResponse(context: HookContext): Omit<HookResponse, 'context' | 'type' | 'timestamp'> {
    const {
      hookEventName,
      success,
      message,
      data,
      shouldContinue = success,
      stopReason,
    } = context;

    const response: Omit<HookResponse, 'context' | 'type' | 'timestamp'> = {
      continue: shouldContinue,
      suppressOutput: false,
    };

    if (!shouldContinue && stopReason) {
      response.stopReason = stopReason;
    }

    // Add hook-specific output based on event type
    if (hookEventName === 'SessionStart') {
      response.hookSpecificOutput = {
        hookEventName: 'SessionStart',
        additionalContext: message,
        ...data,
      };
    } else if (data) {
      response.hookSpecificOutput = data;
    }

    return response;
  }

  // =============================================================================
  // UTILITY METHODS
  // =============================================================================

  /**
   * Validates that an AnalysisContext has required fields
   */
  public validateAnalysisContext(context: Partial<AnalysisContext>): context is AnalysisContext {
    return !!(context.transcriptContent && context.sessionId);
  }

  /**
   * Validates that a SessionContext has required fields
   */
  public validateSessionContext(context: Partial<SessionContext>): context is SessionContext {
    return !!(context.sessionId && context.source);
  }

  /**
   * Validates that a HookContext has required fields
   */
  public validateHookContext(context: Partial<HookContext>): context is HookContext {
    return !!(context.hookEventName && context.sessionId && typeof context.success === 'boolean');
  }

  /**
   * Gets the project name for this orchestrator instance
   */
  public getProjectName(): string {
    return this.projectName;
  }

  /**
   * Sets a new project name for this orchestrator instance
   */
  public setProjectName(projectName: string): void {
    this.projectName = projectName;
  }
}

// =============================================================================
// FACTORY FUNCTIONS
// =============================================================================

/**
 * Creates a new PromptOrchestrator instance
 */
export function createPromptOrchestrator(projectName?: string): PromptOrchestrator {
  return new PromptOrchestrator(projectName);
}

/**
 * Creates an analysis context from basic parameters
 */
export function createAnalysisContext(
  transcriptContent: string,
  sessionId: string,
  options: Partial<Omit<AnalysisContext, 'transcriptContent' | 'sessionId'>> = {}
): AnalysisContext {
  return {
    transcriptContent,
    sessionId,
    ...options,
  };
}

/**
 * Creates a session context from basic parameters
 */
export function createSessionContext(
  sessionId: string,
  source: SessionContext['source'],
  options: Partial<Omit<SessionContext, 'sessionId' | 'source'>> = {}
): SessionContext {
  return {
    sessionId,
    source,
    ...options,
  };
}

/**
 * Creates a hook context from basic parameters
 */
export function createHookContext(
  hookEventName: string,
  sessionId: string,
  success: boolean,
  options: Partial<Omit<HookContext, 'hookEventName' | 'sessionId' | 'success'>> = {}
): HookContext {
  return {
    hookEventName,
    sessionId,
    success,
    ...options,
  };
}