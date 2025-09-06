#!/usr/bin/env node

/**
 * Pre-Compact Hook for Claude Memory System
 * 
 * Updated to use the centralized PromptOrchestrator and HookTemplates system.
 * This hook validates the pre-compact request and executes compression using
 * standardized response templates for consistent Claude Code integration.
 */

import { loadCliCommand } from './shared/config-loader.js';
import { 
  createHookResponse, 
  executeCliCommand, 
  validateHookPayload, 
  debugLog 
} from './shared/hook-helpers.js';

const cliCommand = loadCliCommand();

// Read input from stdin
let input = '';
process.stdin.on('data', chunk => {
  input += chunk;
});

process.stdin.on('end', async () => {
  try {
    const payload = JSON.parse(input);
    debugLog('Pre-compact hook started', { payload });

    // Validate payload using centralized validation
    const validation = validateHookPayload(payload, 'PreCompact');
    if (!validation.valid) {
      const response = createHookResponse('PreCompact', false, { reason: validation.error });
      console.log(JSON.stringify(response));
      process.exit(0);
    }

    // Check for environment-based blocking conditions
    if (payload.trigger === 'auto' && process.env.DISABLE_AUTO_COMPRESSION === 'true') {
      debugLog('Auto-compression disabled by configuration');
      const response = createHookResponse('PreCompact', false, { 
        reason: 'Auto-compression disabled by configuration' 
      });
      console.log(JSON.stringify(response));
      process.exit(0);
    }

    // Execute compression using standardized CLI execution helper
    debugLog('Executing compression command', { 
      command: cliCommand, 
      args: ['compress', payload.transcript_path] 
    });
    
    const result = await executeCliCommand(cliCommand, ['compress', payload.transcript_path]);
    
    if (!result.success) {
      debugLog('Compression command failed', { stderr: result.stderr });
      const response = createHookResponse('PreCompact', false, { 
        reason: `Compression failed: ${result.stderr || 'Unknown error'}` 
      });
      console.log(JSON.stringify(response));
      process.exit(0);
    }

    // Success - create standardized approval response using HookTemplates
    debugLog('Compression completed successfully');
    const response = createHookResponse('PreCompact', true);
    console.log(JSON.stringify(response));
    process.exit(0);

  } catch (error) {
    debugLog('Pre-compact hook error', { error: error.message });
    const response = createHookResponse('PreCompact', false, { 
      reason: `Hook execution error: ${error.message}` 
    });
    console.log(JSON.stringify(response));
    process.exit(1);
  }
});