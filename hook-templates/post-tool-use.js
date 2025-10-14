#!/usr/bin/env node

/**
 * Post Tool Use Hook - Streaming SDK Version
 *
 * Feeds tool responses to the streaming SDK session for real-time processing.
 * SDK decides what to store and calls bash commands directly.
 */

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { renderToolMessage, HOOK_CONFIG } from './shared/hook-prompt-renderer.js';
import { getProjectName } from './shared/path-resolver.js';
import { initializeDatabase, getActiveStreamingSessionsForProject, acquireSessionLock, releaseSessionLock, cleanupStaleLocks } from './shared/hook-helpers.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HOOKS_LOG = path.join(process.env.HOME || '', '.claude-mem', 'logs', 'hooks.log');

function debugLog(message, data = {}) {
  if (process.env.CLAUDE_MEM_DEBUG === 'true') {
    const timestamp = new Date().toISOString();
    const logLine = `[${timestamp}] HOOK DEBUG: ${message} ${JSON.stringify(data)}\n`;
    try {
      fs.appendFileSync(HOOKS_LOG, logLine);
      process.stderr.write(logLine);
    } catch (error) {
      // Silent fail on log errors
    }
  }
}

// Removed: buildStreamingToolMessage function
// Now using centralized config from hook-prompt-renderer.js

// =============================================================================
// MAIN
// =============================================================================

// =============================================================================
// GRACEFUL SHUTDOWN HANDLERS
// =============================================================================

let db;
let lockAcquired = false;
let sdkSessionId = null;

function cleanup() {
  if (lockAcquired && sdkSessionId && db) {
    try {
      releaseSessionLock(db, sdkSessionId);
      debugLog('PostToolUse: Released session lock on shutdown', { sdkSessionId });
    } catch (err) {
      // Silent fail on cleanup
    }
  }
  if (db) {
    try {
      db.close();
    } catch (err) {
      // Silent fail on cleanup
    }
  }
}

process.on('SIGTERM', () => {
  debugLog('PostToolUse: Received SIGTERM, cleaning up');
  cleanup();
  process.exit(0);
});

process.on('SIGINT', () => {
  debugLog('PostToolUse: Received SIGINT, cleaning up');
  cleanup();
  process.exit(0);
});

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });

process.stdin.on('end', async () => {
  let payload;
  try {
    payload = input ? JSON.parse(input) : {};
  } catch (error) {
    debugLog('PostToolUse: JSON parse error', { error: error.message });
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    process.exit(0);
  }

  const { tool_name, tool_response, prompt, cwd, timestamp } = payload;
  const project = cwd ? getProjectName(cwd) : 'unknown';

  // Return immediately - process async in background (don't block next tool)
  console.log(JSON.stringify({ async: true, asyncTimeout: 180000 }));

  try {
    // Load SDK session info from database
    db = initializeDatabase();

    // Clean up any stale locks first
    cleanupStaleLocks(db);

    const sessions = getActiveStreamingSessionsForProject(db, project);
    if (!sessions || sessions.length === 0) {
      debugLog('PostToolUse: No streaming session found', { project });
      db.close();
      process.exit(0);
    }

    const sessionData = sessions[0];
    sdkSessionId = sessionData.sdk_session_id;

    // Validate SDK session ID exists
    if (!sdkSessionId) {
      debugLog('PostToolUse: SDK session ID not yet available', { project });
      db.close();
      process.exit(0);
    }

    // Try to acquire lock - if another hook has it, skip this tool
    lockAcquired = acquireSessionLock(db, sdkSessionId, 'PostToolUse');
    if (!lockAcquired) {
      debugLog('PostToolUse: Session locked by another hook, skipping', { sdkSessionId });
      db.close();
      process.exit(0);
    }

    // Convert tool response to string
    const toolResponseStr = typeof tool_response === 'string'
      ? tool_response
      : JSON.stringify(tool_response);

    // Build message for SDK using centralized config
    const message = renderToolMessage({
      toolName: tool_name,
      toolResponse: toolResponseStr,
      userPrompt: prompt || '',
      timestamp: timestamp || new Date().toISOString()
    });

    // Send to SDK and wait for processing to complete using centralized config
    const response = query({
      prompt: message,
      options: {
        model: HOOK_CONFIG.sdk.model,
        resume: sdkSessionId,
        allowedTools: HOOK_CONFIG.sdk.allowedTools,
        maxTokens: HOOK_CONFIG.sdk.maxTokensTool,
        cwd  // Must match where transcript was created
      }
    });

    // Consume the stream to let SDK fully process
    for await (const msg of response) {
      debugLog('PostToolUse: SDK message', { type: msg.type, subtype: msg.subtype });

      // SDK messages are structured differently than we expected
      // - type: 'assistant' contains the assistant's response with content blocks
      // - Content blocks can be text or tool_use
      // - type: 'user' contains tool results
      // - type: 'result' is the final summary

      if (msg.type === 'assistant' && msg.message?.content) {
        for (const block of msg.message.content) {
          if (block.type === 'text') {
            debugLog('PostToolUse: SDK text', { text: block.text?.slice(0, 200) });
          } else if (block.type === 'tool_use') {
            debugLog('PostToolUse: SDK tool_use', {
              tool: block.name,
              input: JSON.stringify(block.input).slice(0, 200)
            });
          }
        }
      } else if (msg.type === 'user' && msg.message?.content) {
        for (const block of msg.message.content) {
          if (block.type === 'tool_result') {
            debugLog('PostToolUse: SDK tool_result', {
              tool_use_id: block.tool_use_id,
              content: typeof block.content === 'string' ? block.content.slice(0, 300) : JSON.stringify(block.content).slice(0, 300)
            });
          }
        }
      } else if (msg.type === 'result') {
        debugLog('PostToolUse: SDK result', {
          subtype: msg.subtype,
          is_error: msg.is_error
        });
      }
    }

    debugLog('PostToolUse: SDK finished processing', { tool_name, sdkSessionId });

  } catch (error) {
    debugLog('PostToolUse: Error sending to SDK', { error: error.message, stack: error.stack });
  } finally {
    // Always release lock and close database
    if (lockAcquired && sdkSessionId && db) {
      try {
        releaseSessionLock(db, sdkSessionId);
        debugLog('PostToolUse: Released session lock', { sdkSessionId });
      } catch (err) {
        debugLog('PostToolUse: Error releasing lock', { error: err.message });
      }
    }

    if (db) {
      try {
        db.close();
      } catch (err) {
        debugLog('PostToolUse: Error closing database', { error: err.message });
      }
    }
  }

  // Exit cleanly after async processing completes
  process.exit(0);
});