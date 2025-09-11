/**
 * Claude Memory System - Prompt-Related Constants and Templates
 * 
 * This file contains all prompts, instructions, and output templates
 * for the analysis and context priming system.
 */

import * as HookTemplates from './templates/hooks/HookTemplates.js';

// =============================================================================
// ANALYSIS PROMPTS AND TEMPLATES
// =============================================================================

/**
 * Entity naming patterns for the knowledge graph
 */
export const ENTITY_NAMING_PATTERNS = {
  component: "Component_Name",
  decision: "Decision_Name", 
  pattern: "Pattern_Name",
  tool: "Tool_Name",
  fix: "Fix_Name",
  workflow: "Workflow_Name"
} as const;

/**
 * Available entity types for classification
 */
export const ENTITY_TYPES = {
  component: "component", // UI components, modules, services
  pattern: "pattern",     // Architectural or design patterns
  workflow: "workflow",   // Processes, pipelines, sequences
  integration: "integration", // APIs, external services, data sources
  concept: "concept",     // Abstract ideas, methodologies, principles
  decision: "decision",   // Design choices, trade-offs, solutions
  tool: "tool",          // Utilities, libraries, development tools
  fix: "fix"             // Bug fixes, patches, workarounds
} as const;

/**
 * Standard observation fields for entities
 */
export const OBSERVATION_FIELDS = [
  "Core purpose: [what it fundamentally does]",
  "Brief description: [one-line summary for session-start display]", 
  "Implementation: [key technical details, code patterns]",
  "Dependencies: [what it requires or builds upon]",
  "Usage context: [when/why it's used]",
  "Performance characteristics: [speed, reliability, constraints]",
  "Integration points: [how it connects to other systems]",
  "Keywords: [searchable terms for this concept]",
  "Decision rationale: [why this approach was chosen]",
  "Next steps: [what needs to be done next with this component]",
  "Files modified: [list of files changed]",
  "Tools used: [development tools/commands used]"
] as const;

/**
 * Relationship types for creating meaningful entity connections
 */
export const RELATIONSHIP_TYPES = [
  "executes_via", "orchestrates_through", "validates_using",
  "provides_auth_to", "manages_state_for", "processes_events_from",
  "caches_data_from", "routes_requests_to", "transforms_data_for",
  "extends", "enhances_performance_of", "builds_upon",
  "fixes_issue_in", "replaces", "optimizes",
  "triggers_tool", "receives_result_from"
] as const;



// =============================================================================
// CONTEXT PRIMING TEMPLATES
// =============================================================================

/**
 * System message templates for context priming
 */
export const CONTEXT_TEMPLATES = {
  PRIMARY_CONTEXT: (projectName: string) => 
    `Context primed for project: ${projectName}. Access memories with chroma_query_documents(["${projectName}*"]) or chroma_get_documents(["document_id"]).`,
  
  RECENT_SESSIONS: (sessionList: string) =>
    `Recent sessions available: ${sessionList}`,
    
  AVAILABLE_ENTITIES: (type: string, entities: string[], hasMore: boolean, moreCount: number) =>
    `Available ${type} entities: ${entities.join(', ')}${hasMore ? ` (+${moreCount} more)` : ''}`,

  SESSION_START_HEADER: '🧠 Active Working Context from Previous Sessions:',
  SESSION_START_SEPARATOR: '═'.repeat(70),
  
  RESUME_INSTRUCTIONS: `💡 TO RESUME: Load active components with chroma_get_documents(["<exact_document_ids>"])
📊 TO EXPLORE: Search related work with chroma_query_documents(["<keywords>"])`
} as const;

// =============================================================================
// SESSION START OUTPUT TEMPLATES  
// =============================================================================

/**
 * Session start formatting templates
 */
export const SESSION_START_TEMPLATES = {
  FOCUS_LINE: (focus: string) => `📌 CURRENT FOCUS: ${focus}`,
  LAST_WORKED: (timeAgo: string, projectName: string) => `Last worked: ${timeAgo} | Project: ${projectName}`,
  
  SECTIONS: {
    COMPONENTS: '🎯 ACTIVE COMPONENTS (load these for context):',
    DECISIONS: '🔄 RECENT DECISIONS & PATTERNS:',
    TOOLS: '🛠️ TOOLS & INFRASTRUCTURE:',
    FIXES: '🐛 RECENT FIXES:',
    ACTIONS: '⚡ NEXT ACTIONS:'
  },
  
  ACTION_PREFIX: '□ ',
  ENTITY_BULLET: '• '
} as const;

/**
 * Time formatting for "time ago" displays
 */
export const TIME_FORMATS = {
  JUST_NOW: 'just now',
  HOURS_AGO: (hours: number) => `${hours} hour${hours > 1 ? 's' : ''} ago`,
  DAYS_AGO: (days: number) => `${days} day${days > 1 ? 's' : ''} ago`,
  RECENTLY: 'recently'
} as const;

// =============================================================================
// HOOK RESPONSE TEMPLATES
// =============================================================================

/**
 * Standard hook response structures for Claude Code integration
 */
export const HOOK_RESPONSES = {
  SUCCESS: (hookEventName: string, message: string) => ({
    hookSpecificOutput: {
      hookEventName,
      status: "success",
      message
    },
    suppressOutput: true
  }),

  SKIPPED: (hookEventName: string, message: string) => ({
    hookSpecificOutput: {
      hookEventName,
      status: "skipped", 
      message
    },
    suppressOutput: true
  }),

  BLOCKED: (reason: string) => ({
    decision: "block",
    reason
  }),

  CONTINUE: (hookEventName: string, additionalContext?: string) => ({
    continue: true,
    ...(additionalContext && {
      hookSpecificOutput: {
        hookEventName,
        additionalContext
      }
    })
  }),

  ERROR: (reason: string) => ({
    decision: "block",
    reason
  })
} as const;

/**
 * Pre-defined hook messages
 */
export const HOOK_MESSAGES = {
  COMPRESSION_SUCCESS: "Memory compression completed successfully",
  COMPRESSION_FAILED: (stderr: string) => `Compression failed: ${stderr}`,
  CONTEXT_LOADED: "Project context loaded successfully",
  CONTEXT_SKIPPED: "Continuing session - context loading skipped",
  NO_TRANSCRIPT: "No transcript path provided",
  HOOK_ERROR: (error: string) => `Hook error: ${error}`
} as const;

/**
 * Export hook templates for direct usage
 */
export { HookTemplates };