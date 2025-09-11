/**
 * Claude Memory System - Core Constants
 * 
 * This file contains core application constants, CLI messages, 
 * configuration templates, and infrastructure-related constants.
 */

// =============================================================================
// CONFIGURATION TEMPLATES
// =============================================================================

/**
 * Hook configuration templates for Claude settings
 */
export const HOOK_CONFIG_TEMPLATES = {
  PRE_COMPACT: (scriptPath: string) => ({
    pattern: "*",
    hooks: [{
      type: "command",
      command: scriptPath,
      timeout: 180
    }]
  }),

  SESSION_START: (scriptPath: string) => ({
    pattern: "*", 
    hooks: [{
      type: "command",
      command: scriptPath,
      timeout: 30
    }]
  }),

  SESSION_END: (scriptPath: string) => ({
    pattern: "*",
    hooks: [{
      type: "command", 
      command: scriptPath,
      timeout: 180
    }]
  })
} as const;

// =============================================================================
// CLI MESSAGES AND STATUS TEMPLATES
// =============================================================================

/**
 * Command-line interface messages
 */
export const CLI_MESSAGES = {
  INSTALLATION: {
    STARTING: '🚀 Installing Claude Memory System with Chroma...',
    SUCCESS: '🎉 Installation complete! Vector database ready.',
    HOOKS_INSTALLED: '✅ Installed hooks to ~/.claude-mem/hooks/',
    MCP_CONFIGURED: (path: string) => `✅ Configured MCP memory server in ${path}`,
    EMBEDDED_READY: '🧠 Chroma initialized for persistent semantic memory',
    ALREADY_INSTALLED: '⚠️  Claude Memory hooks are already installed.',
    USE_FORCE: '   Use --force to overwrite existing installation.',
    SETTINGS_WRITTEN: (type: string, path: string) => 
      `✅ Installed hooks in ${type} settings\n   Settings file: ${path}`
  },

  NEXT_STEPS: [
    '1. Restart Claude Code to load the new hooks',
    '2. Use `/clear` and `/compact` in Claude Code to save and compress session memories', 
    '3. New sessions will automatically load relevant context'
  ],

  ERRORS: {
    HOOKS_NOT_FOUND: '❌ Hook source files not found',
    SETTINGS_WRITE_FAILED: (path: string, error: string) => 
      `❌ Failed to write settings file: ${error}\n   Path: ${path}`,
    MCP_CONFIG_PARSE_FAILED: (error: string) => 
      `⚠️  Warning: Could not parse existing MCP config: ${error}`,
    MCP_CONFIG_WRITE_FAILED: (error: string) => 
      `⚠️  Warning: Could not write MCP config: ${error}`,
    COMPRESSION_FAILED: (error: string) => `❌ Compression failed: ${error}`,
    CONTEXT_LOAD_FAILED: (error: string) => `❌ Failed to load context: ${error}`
  },

  STATUS: {
    NO_INDEX: '📚 No memory index found. Starting fresh session.',
    RECENT_MEMORIES: '🧠 Recent memories from previous sessions:',
    MEMORY_COUNT: (count: number) => `📚 Showing ${count} most recent memories`,
    FULL_CONTEXT_AVAILABLE: '💡 Full context available via MCP memory tools'
  }
} as const;

// =============================================================================
// DEBUG AND LOGGING TEMPLATES
// =============================================================================

/**
 * Debug logging message templates
 */
export const DEBUG_MESSAGES = {
  COMPRESSION_STARTED: '🚀 COMPRESSION STARTED',
  TRANSCRIPT_PATH: (path: string) => `📁 Transcript Path: ${path}`,
  SESSION_ID: (id: string) => `🔍 Session ID: ${id}`,
  PROJECT_NAME: (name: string) => `📝 PROJECT NAME: ${name}`,
  CLAUDE_SDK_CALL: '🤖 Calling Claude SDK to analyze and populate memory database...',
  TRANSCRIPT_STATS: (size: number, count: number) => 
    `📊 Transcript size: ${size} characters, ${count} messages`,
  COMPRESSION_COMPLETE: (count: number) => `✅ COMPRESSION COMPLETE\n  Total summaries extracted: ${count}`,
  CLAUDE_PATH_FOUND: (path: string) => `🎯 Found Claude Code at: ${path}`,
  MCP_CONFIG_USED: (path: string) => `📋 Using MCP config: ${path}`
} as const;

// =============================================================================
// SEARCH AND QUERY TEMPLATES
// =============================================================================

/**
 * Memory database search templates
 */
export const SEARCH_TEMPLATES = {
  SEARCH_SCRIPT: (query: string) => `
import { query } from "@anthropic-ai/claude-code";

const searchQuery = process.env.SEARCH_QUERY || '';

const result = await query({
    prompt: "Search for: " + searchQuery,
    options: {
        mcpConfig: "~/.claude/.mcp.json",
        allowedTools: ["mcp__claude-mem__chroma_query_documents"],
        outputFormat: "json"
    }
});
`,

  SEARCH_PREFIX: "Search for: "
} as const;

// =============================================================================
// CHROMA INTEGRATION CONSTANTS
// =============================================================================

/**
 * Chroma collection names for documents
 */
export const CHROMA_COLLECTIONS = {
  DOCUMENTS: 'claude_mem_documents',
  MEMORIES: 'claude_mem_memories'
} as const;

/**
 * Default Chroma configuration values
 */
export const CHROMA_DEFAULTS = {
  HOST: 'localhost:8000',
  COLLECTION: 'claude_mem_documents'
} as const;

/**
 * Chroma-specific CLI messages
 */
export const CHROMA_MESSAGES = {
  CONNECTION: {
    CONNECTING: '🔗 Connecting to Chroma server...',
    CONNECTED: '✅ Connected to Chroma successfully',
    FAILED: (error: string) => `❌ Failed to connect to Chroma: ${error}`,
    DISCONNECTED: '👋 Disconnected from Chroma'
  },
  
  SEARCH: {
    SEMANTIC_SEARCH: '🧠 Using semantic search with Chroma...',
    KEYWORD_SEARCH: '🔍 Using keyword search with Chroma...',
    HYBRID_SEARCH: '🔬 Using hybrid search with Chroma...',
    RESULTS_FOUND: (count: number) => `📊 Found ${count} results in Chroma`
  },
  
  SETUP: {
    STARTING_CHROMA: '🚀 Starting Chroma instance...',
    CHROMA_READY: '✅ Chroma is ready and accepting connections',
    INITIALIZING_COLLECTIONS: '📋 Initializing document collections...'
  }
} as const;

/**
 * Chroma error messages
 */
export const CHROMA_ERRORS = {
  CONNECTION_FAILED: 'Could not establish connection to Chroma server',
  MCP_SERVER_NOT_FOUND: 'Chroma MCP server not found',
  INVALID_COLLECTION: (collection: string) => `Invalid Chroma collection: ${collection}`,
  QUERY_FAILED: (query: string, error: string) => `Query failed for '${query}': ${error}`,
  DOCUMENT_CREATION_FAILED: (id: string) => `Failed to create document '${id}' in Chroma`,
  COLLECTION_CREATION_FAILED: (name: string) => `Failed to create collection '${name}' in Chroma`
} as const;

/**
 * Export all core constants for easy importing
 */
export const CONSTANTS = {
  HOOK_CONFIG_TEMPLATES,
  CLI_MESSAGES,
  DEBUG_MESSAGES,
  SEARCH_TEMPLATES,
  // Chroma constants
  CHROMA_COLLECTIONS,
  CHROMA_DEFAULTS,
  CHROMA_MESSAGES,
  CHROMA_ERRORS
} as const;