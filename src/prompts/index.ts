/**
 * Prompts Module - Single source of truth for all prompt generation
 * 
 * This module provides a centralized system for generating prompts across
 * the claude-mem system. It includes the core PromptOrchestrator class
 * and all related TypeScript interfaces.
 */

// Export all interfaces
export type {
  AnalysisContext,
  SessionContext,
  HookContext,
  AnalysisPrompt,
  SessionPrompt,
  HookResponse,
} from '../core/orchestration/PromptOrchestrator.js';

// Export the main class
export {
  PromptOrchestrator,
} from '../core/orchestration/PromptOrchestrator.js';

// Export factory functions
export {
  createPromptOrchestrator,
  createAnalysisContext,
  createSessionContext,
  createHookContext,
} from '../core/orchestration/PromptOrchestrator.js';