#!/usr/bin/env node

/**
 * Session Start Hook - Load context when Claude Code starts
 * 
 * Updated to use the centralized PromptOrchestrator and HookTemplates system.
 * This hook loads previous session context using standardized formatting and
 * provides rich context messages for Claude Code integration.
 */

import path from 'path';
import { loadCliCommand } from './shared/config-loader.js';
import { 
  createHookResponse, 
  formatSessionStartContext, 
  executeCliCommand, 
  parseContextData, 
  validateHookPayload, 
  debugLog 
} from './shared/hook-helpers.js';

const cliCommand = loadCliCommand();

// Set up stdin immediately before any async operations
process.stdin.setEncoding('utf8');
process.stdin.resume(); // Explicitly enter flowing mode to prevent data loss

// Read input from stdin
let input = '';
process.stdin.on('data', chunk => {
  input += chunk;
});

process.stdin.on('end', async () => {
  try {
    const payload = JSON.parse(input);
    debugLog('Session start hook started', { payload });

    // Validate payload using centralized validation
    const validation = validateHookPayload(payload, 'SessionStart');
    if (!validation.valid) {
      debugLog('Payload validation failed', { error: validation.error });
      // For session start, continue even with invalid payload but log the error
      const response = createHookResponse('SessionStart', false, { 
        error: `Payload validation failed: ${validation.error}` 
      });
      console.log(JSON.stringify(response));
      process.exit(0);
    }

    // Skip load-context when source is "resume" to avoid duplicate context
    if (payload.source === 'resume') {
      debugLog('Skipping load-context for resume source');
      // Output valid JSON response with suppressOutput for resume
      const response = createHookResponse('SessionStart', true);
      console.log(JSON.stringify(response));
      process.exit(0);
    }

    // Extract project name from current working directory
    const projectName = path.basename(process.cwd());

    // Load context using standardized CLI execution helper
    const contextResult = await executeCliCommand(cliCommand, [
      'load-context', 
      '--format', 'session-start', 
      '--project', projectName
    ]);

    if (!contextResult.success) {
      debugLog('Context loading failed', { stderr: contextResult.stderr });
      // Don't fail the session start, just provide error context
      const response = createHookResponse('SessionStart', false, {
        error: contextResult.stderr || 'Failed to load context'
      });
      console.log(JSON.stringify(response));
      process.exit(0);
    }

    const rawContext = contextResult.stdout;
    debugLog('Raw context loaded', { contextLength: rawContext.length });

    // Check if the output is actually an error message (starts with ❌)
    if (rawContext && rawContext.trim().startsWith('❌')) {
      debugLog('Detected error message in stdout', { rawContext });
      // Extract the clean error message without the emoji and format
      const errorMatch = rawContext.match(/❌\s*[^:]+:\s*([^\n]+)(?:\n\n💡\s*(.+))?/);
      let errorMsg = 'No previous memories found';
      let suggestion = '';
      
      if (errorMatch) {
        errorMsg = errorMatch[1] || errorMsg;
        suggestion = errorMatch[2] || '';
      }
      
      // Create a clean response without duplicating the error formatting
      const response = createHookResponse('SessionStart', false, {
        error: errorMsg + (suggestion ? `. ${suggestion}` : '')
      });
      console.log(JSON.stringify(response));
      process.exit(0);
    }

    if (!rawContext || !rawContext.trim()) {
      debugLog('No context available, creating empty response');
      // No context available - use standardized empty response
      const response = createHookResponse('SessionStart', true);
      console.log(JSON.stringify(response));
      process.exit(0);
    }

    // Parse context data and format using centralized templates
    const contextData = parseContextData(rawContext);
    contextData.projectName = projectName;
    
    // If we have raw context (not structured data), use it directly
    let formattedContext;
    if (contextData.rawContext) {
      formattedContext = contextData.rawContext;
    } else {
      // Use standardized formatting for structured context
      formattedContext = formatSessionStartContext(contextData);
    }

    debugLog('Context formatted successfully', { 
      memoryCount: contextData.memoryCount,
      hasStructuredData: !contextData.rawContext 
    });

    // Create standardized session start response using HookTemplates
    const response = createHookResponse('SessionStart', true, { 
      context: formattedContext 
    });
    
    console.log(JSON.stringify(response));
    process.exit(0);

  } catch (error) {
    debugLog('Session start hook error', { error: error.message });
    // Even on error, continue the session with error information
    const response = createHookResponse('SessionStart', false, { 
      error: `Hook execution error: ${error.message}` 
    });
    console.log(JSON.stringify(response));
    process.exit(0);
  }
});

/**
 * Extracts project name from transcript path
 * @param {string} transcriptPath - Path to transcript file
 * @returns {string|null} Extracted project name or null
 */
function extractProjectName(transcriptPath) {
  if (!transcriptPath) return null;
  
  // Look for project pattern: /path/to/PROJECT_NAME/.claude/
  // Need to get PROJECT_NAME, not the parent directory
  const parts = transcriptPath.split(path.sep);
  const claudeIndex = parts.indexOf('.claude');
  
  if (claudeIndex > 0) {
    // Get the directory immediately before .claude
    return parts[claudeIndex - 1];
  }
  
  // Fall back to directory containing the transcript
  const dir = path.dirname(transcriptPath);
  return path.basename(dir);
}