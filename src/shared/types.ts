/**
 * Core Type Definitions
 *
 * Minimal type definitions for the claude-mem system.
 * Only includes types that are actively imported and used.
 */

// =============================================================================
// CONFIGURATION TYPES
// =============================================================================

/**
 * Main settings interface for claude-mem configuration
 */
export interface Settings {
  autoCompress?: boolean;
  projectName?: string;
  installed?: boolean;
  backend?: string;
  embedded?: boolean;
  saveMemoriesOnClear?: boolean;
  rollingCaptureEnabled?: boolean;
  rollingSummaryEnabled?: boolean;
  rollingSessionStartEnabled?: boolean;
  rollingChunkTokens?: number;
  rollingChunkOverlapTokens?: number;
  rollingSummaryTurnLimit?: number;
  [key: string]: unknown;  // Allow additional properties
}
