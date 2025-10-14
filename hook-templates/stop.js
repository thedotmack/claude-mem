#!/usr/bin/env node

/**
 * Stop Hook - Simple Orchestrator
 *
 * Signals session end to SDK, which generates and stores the overview via CLI.
 * Cleans up SDK transcript from UI.
 */

import path from 'path';
import fs from 'fs';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { renderEndMessage, HOOK_CONFIG } from './shared/hook-prompt-renderer.js';
import { getProjectName } from './shared/path-resolver.js';
import { initializeDatabase, getActiveStreamingSessionsForProject, markStreamingSessionCompleted, acquireSessionLock, releaseSessionLock, cleanupStaleLocks } from './shared/hook-helpers.js';

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

// =============================================================================
// GRACEFUL SHUTDOWN HANDLERS
// =============================================================================

let db;
let lockAcquired = false;
let sdkSessionId = null;
let sessionData = null;

function cleanup() {
  if (lockAcquired && sdkSessionId && db) {
    try {
      releaseSessionLock(db, sdkSessionId);
      debugLog('Stop: Released session lock on shutdown', { sdkSessionId });
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
  debugLog('Stop: Received SIGTERM, cleaning up');
  cleanup();
  process.exit(0);
});

process.on('SIGINT', () => {
  debugLog('Stop: Received SIGINT, cleaning up');
  cleanup();
  process.exit(0);
});

// =============================================================================
// MAIN
// =============================================================================

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });

process.stdin.on('end', async () => {
  let payload;
  try {
    payload = input ? JSON.parse(input) : {};
  } catch (error) {
    debugLog('Stop: JSON parse error', { error: error.message });
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    process.exit(0);
  }

  const { cwd } = payload;
  const project = cwd ? getProjectName(cwd) : 'unknown';

  // Return immediately with async mode
  console.log(JSON.stringify({ async: true, asyncTimeout: 180000 }));

  try {
    // Clear activity flag FIRST - even if hook fails, UI should update
    const activityFlagPath = path.join(process.env.HOME || '', '.claude-mem', 'activity.flag');
    try {
      fs.writeFileSync(activityFlagPath, JSON.stringify({ active: false, timestamp: Date.now() }));
    } catch (error) {
      debugLog('Stop: Error clearing activity flag', { error: error.message });
    }

    // Load SDK session info from database
    db = initializeDatabase();

    // Clean up any stale locks first
    cleanupStaleLocks(db);

    const sessions = getActiveStreamingSessionsForProject(db, project);
    if (!sessions || sessions.length === 0) {
      debugLog('Stop: No streaming session found', { project });
      db.close();
      process.exit(0);
    }

    sessionData = sessions[0];
    sdkSessionId = sessionData.sdk_session_id;
    const claudeSessionId = sessionData.claude_session_id;

    // Validate SDK session ID exists
    if (!sdkSessionId) {
      debugLog('Stop: SDK session ID not yet available', { project });
      db.close();
      process.exit(0);
    }

    // Try to acquire lock - wait up to 10 seconds for PostToolUse to finish
    let attempts = 0;
    while (attempts < 20) {
      lockAcquired = acquireSessionLock(db, sdkSessionId, 'Stop');
      if (lockAcquired) break;

      debugLog('Stop: Waiting for session lock', { attempt: attempts + 1, sdkSessionId });
      await new Promise(resolve => setTimeout(resolve, 500));
      attempts++;
    }

    if (!lockAcquired) {
      debugLog('Stop: Could not acquire session lock after 10 seconds', { sdkSessionId });
      db.close();
      process.exit(1);
    }

    debugLog('Stop: Ending SDK session', { sdkSessionId, claudeSessionId });

    // Build end message - SDK will call `claude-mem store-overview` and `chroma_add_documents`
    const message = renderEndMessage({
      project,
      sessionId: claudeSessionId
    });

    // Send end message and wait for SDK to complete
    const response = query({
      prompt: message,
      options: {
        model: HOOK_CONFIG.sdk.model,
        resume: sdkSessionId,
        allowedTools: HOOK_CONFIG.sdk.allowedTools,
        maxTokens: HOOK_CONFIG.sdk.maxTokensEnd,
        cwd  // Must match where transcript was created
      }
    });

    // Consume the response stream (wait for SDK to finish storing via CLI)
    for await (const msg of response) {
      if (msg.type === 'assistant' && msg.message?.content) {
        for (const block of msg.message.content) {
          if (block.type === 'tool_use') {
            debugLog('Stop: SDK tool call', { tool: block.name });
          }
        }
      }
    }

    debugLog('Stop: SDK session ended', { sdkSessionId });

    // Delete SDK memories transcript from Claude Code UI
    const sanitizedCwd = cwd.replace(/\//g, '-');
    const projectsDir = path.join(process.env.HOME, '.claude', 'projects', sanitizedCwd);
    const memoriesTranscriptPath = path.join(projectsDir, `${sdkSessionId}.jsonl`);

    if (fs.existsSync(memoriesTranscriptPath)) {
      fs.unlinkSync(memoriesTranscriptPath);
      debugLog('Stop: Cleaned up memories transcript', { memoriesTranscriptPath });
    }

    // Mark session as completed in database
    if (sessionData) {
      markStreamingSessionCompleted(db, sessionData.id);
      debugLog('Stop: Session ended and marked complete', { project, sessionId: sessionData.id });
    }

  } catch (error) {
    debugLog('Stop: Error ending session', { error: error.message, stack: error.stack });
  } finally {
    // Always release lock and close database
    if (lockAcquired && sdkSessionId && db) {
      try {
        releaseSessionLock(db, sdkSessionId);
        debugLog('Stop: Released session lock', { sdkSessionId });
      } catch (err) {
        debugLog('Stop: Error releasing lock', { error: err.message });
      }
    }

    if (db) {
      try {
        db.close();
      } catch (err) {
        debugLog('Stop: Error closing database', { error: err.message });
      }
    }
  }

  // Exit cleanly after async processing completes
  process.exit(0);
});
