/**
 * Claude Memory System - Core Constants
 *
 * This file contains debug logging templates used throughout the application.
 */

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
