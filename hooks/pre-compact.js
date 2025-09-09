#!/usr/bin/env node

/**
 * Pre-Compact Hook for Claude Memory System
 * 
 * Updated to use the centralized PromptOrchestrator and HookTemplates system.
 * This hook validates the pre-compact request and executes compression using
 * standardized response templates for consistent Claude Code integration.
 */

import { loadCliCommand } from './shared/config-loader.js';
import { getLogsDir } from './shared/path-resolver.js';
import { 
  createHookResponse, 
  executeCliCommand, 
  validateHookPayload, 
  debugLog 
} from './shared/hook-helpers.js';

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
    // Load CLI command inside try-catch to handle config errors properly
    const cliCommand = loadCliCommand();
    
    const payload = JSON.parse(input);
    debugLog('Pre-compact hook started', { payload });

    // Validate payload using centralized validation
    const validation = validateHookPayload(payload, 'PreCompact');
    if (!validation.valid) {
      const response = createHookResponse('PreCompact', false, { reason: validation.error });
      debugLog('Validation failed', { response });
      // Exit silently - validation failure is expected flow control
      process.exit(0);
    }

    // Check for environment-based blocking conditions
    if (payload.trigger === 'auto' && process.env.DISABLE_AUTO_COMPRESSION === 'true') {
      const response = createHookResponse('PreCompact', false, { 
        reason: 'Auto-compression disabled by configuration' 
      });
      debugLog('Auto-compression disabled', { response });
      // Exit silently - disabled compression is expected flow control
      process.exit(0);
    }

    // Execute compression using standardized CLI execution helper
    debugLog('Executing compression command', { 
      command: cliCommand, 
      args: ['compress', payload.transcript_path] 
    });
    
    const result = await executeCliCommand(cliCommand, ['compress', payload.transcript_path]);
    
    if (!result.success) {
      const response = createHookResponse('PreCompact', false, { 
        reason: `Compression failed: ${result.stderr || 'Unknown error'}` 
      });
      debugLog('Compression command failed', { stderr: result.stderr, response });
      console.log(`claude-mem error: compression failed, see logs at ${getLogsDir()}`);
      process.exit(1);  // Exit with error code for actual compression failure
    }

    // Success - exit silently (suppressOutput is true)
    debugLog('Compression completed successfully');
    process.exit(0);

  } catch (error) {
    const response = createHookResponse('PreCompact', false, { 
      reason: `Hook execution error: ${error.message}` 
    });
    debugLog('Pre-compact hook error', { error: error.message, response });
    console.log(`claude-mem error: hook failed, see logs at ${getLogsDir()}`);
    process.exit(1);
  }
});