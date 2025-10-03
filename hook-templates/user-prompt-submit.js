#!/usr/bin/env node

/**
 * User Prompt Submit Hook - Streaming SDK Version
 *
 * Starts a streaming SDK session that will process tool responses in real-time.
 * Saves the SDK session ID for post-tool-use and stop hooks to resume.
 */

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { renderSystemPrompt, HOOK_CONFIG } from './shared/hook-prompt-renderer.js';
import { getProjectName } from './shared/path-resolver.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SESSION_DIR = path.join(process.env.HOME || '', '.claude-mem', 'sessions');
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

// Removed: buildStreamingSystemPrompt function
// Now using centralized config from hook-prompt-renderer.js

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
    debugLog('UserPromptSubmit: JSON parse error', { error: error.message });
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    process.exit(0);
  }

  const { prompt, cwd, session_id, timestamp } = payload;
  const project = cwd ? getProjectName(cwd) : 'unknown';
  const date = timestamp ? timestamp.split('T')[0] : new Date().toISOString().split('T')[0];

  debugLog('UserPromptSubmit: Starting streaming session', { project, session_id });

  // Generate title and subtitle non-blocking
  if (prompt && session_id && project) {
    import('child_process').then(({ spawn }) => {
      const titleProcess = spawn('claude-mem', [
        'generate-title',
        '--save',
        '--project', project,
        '--session', session_id,
        prompt
      ], {
        stdio: 'ignore',
        detached: true
      });
      titleProcess.unref();
    }).catch(error => {
      debugLog('UserPromptSubmit: Error spawning title generator', { error: error.message });
    });
  }

  try {
    // Build system prompt using centralized config
    const systemPrompt = renderSystemPrompt({
      project,
      sessionId: session_id,
      date,
      userPrompt: prompt || ''
    });

    // Start SDK session using centralized config
    const response = query({
      prompt: systemPrompt,
      options: {
        model: HOOK_CONFIG.sdk.model,
        allowedTools: HOOK_CONFIG.sdk.allowedTools,
        maxTokens: HOOK_CONFIG.sdk.maxTokensSystem,
        cwd  // SDK will save transcript in this directory
      }
    });

    // Wait for session ID from init message and consume entire stream
    let sdkSessionId = null;
    for await (const message of response) {
      if (message.type === 'system' && message.subtype === 'init') {
        sdkSessionId = message.session_id;
        debugLog('UserPromptSubmit: Got SDK session ID', { sdkSessionId });
      }
      // Don't break - consume entire stream so transcript gets written
    }

    if (sdkSessionId) {
      // Save session info for other hooks
      fs.mkdirSync(SESSION_DIR, { recursive: true });
      const sessionFile = path.join(SESSION_DIR, `${project}_streaming.json`);
      fs.writeFileSync(sessionFile, JSON.stringify({
        sdkSessionId,
        claudeSessionId: session_id,
        project,
        startedAt: timestamp,
        date
      }, null, 2));

      debugLog('UserPromptSubmit: SDK session started', { sdkSessionId, sessionFile });
    }
  } catch (error) {
    debugLog('UserPromptSubmit: Error starting SDK session', { error: error.message });
  }

  // Return success to Claude Code
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
  process.exit(0);
});