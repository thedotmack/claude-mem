/**
 * New Hook - UserPromptSubmit
 *
 * DUAL PURPOSE HOOK: Handles BOTH session initialization AND continuation
 * ==========================================================================
 *
 * CRITICAL ARCHITECTURE FACTS (NEVER FORGET):
 *
 * 1. SESSION ID THREADING - The Single Source of Truth
 *    - Claude Code assigns ONE session_id per conversation
 *    - ALL hooks in that conversation receive the SAME session_id
 *    - We ALWAYS use this session_id - NEVER generate our own
 *    - This is how NEW hook, SAVE hook, and SUMMARY hook stay connected
 *
 * 2. NO EXISTENCE CHECKS NEEDED
 *    - createSDKSession is idempotent (INSERT OR IGNORE)
 *    - Prompt #1: Creates new database row, returns new ID
 *    - Prompt #2+: Row exists, returns existing ID
 *    - We NEVER need to check "does session exist?" - just use the session_id
 *
 * 3. CONTINUATION LOGIC LOCATION
 *    - This hook does NOT contain continuation prompt logic
 *    - That lives in SDKAgent.ts (lines 125-127)
 *    - SDKAgent checks promptNumber to choose init vs continuation prompt
 *    - BOTH prompts receive the SAME session_id from this hook
 *
 * 4. UNIFIED WITH SAVE HOOK
 *    - SAVE hook uses: db.createSDKSession(session_id, '', '')
 *    - NEW hook uses: db.createSDKSession(session_id, project, prompt)
 *    - Both use session_id from hook context - this keeps everything connected
 *
 * This is KISS in action: Use the session_id we're given, trust idempotent
 * database operations, and let SDKAgent handle init vs continuation logic.
 */

import path from 'path';
import { stdin } from 'process';
import { SessionStore } from '../services/sqlite/SessionStore.js';
import { createHookResponse } from './hook-response.js';
import { ensureWorkerRunning, getWorkerPort } from '../shared/worker-utils.js';
import { silentDebug } from '../utils/silent-debug.js';

export interface UserPromptSubmitInput {
  session_id: string;
  cwd: string;
  prompt: string;
  [key: string]: any;
}

/**
 * New Hook Main Logic
 */
async function newHook(input?: UserPromptSubmitInput): Promise<void> {
  if (!input) {
    throw new Error('newHook requires input');
  }

  const { session_id, cwd, prompt } = input;
  const project = path.basename(cwd);

  // Ensure worker is running
  await ensureWorkerRunning();

  const db = new SessionStore();

  // CRITICAL: Use session_id from hook as THE source of truth
  // createSDKSession is idempotent - creates new or returns existing
  // This is how ALL hooks stay connected to the same session
  const sessionDbId = db.createSDKSession(session_id, project, prompt);
  const promptNumber = db.incrementPromptCounter(sessionDbId);

  // Save raw user prompt for full-text search
  db.saveUserPrompt(session_id, promptNumber, prompt);

  console.error(`[new-hook] Session ${sessionDbId}, prompt #${promptNumber}`);

  const port = getWorkerPort();

  try {
    // Initialize session via HTTP
    const response = await fetch(`http://127.0.0.1:${port}/sessions/${sessionDbId}/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project, userPrompt: prompt, promptNumber }),
      signal: AbortSignal.timeout(5000)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to initialize session: ${response.status} ${errorText}`);
    }
  } catch (error: any) {
    // Only show restart message for connection errors, not HTTP errors
    if (error.cause?.code === 'ECONNREFUSED' || error.name === 'TimeoutError' || error.message.includes('fetch failed')) {
      throw new Error("There's a problem with the worker. If you just updated, type `pm2 restart claude-mem-worker` in your terminal to continue");
    }
    // Re-throw HTTP errors and other errors as-is
    throw error;
  }

  // Real-time context: Intelligent context selection following workflow
  // IMPORTANT: The user CANNOT see this injected context - only Claude can see it.
  // This is why we use silentDebug() - so the user can verify it's working by
  // checking ~/.claude-mem/silent.log for success/error messages.
  // The user only knows it worked if Claude's responses show relevant past context.
  let realtimeContext = '';
  if (process.env.CLAUDE_MEM_REALTIME_CONTEXT === 'true') {
    try {
      // Step 1: Get session start observations (recent observations for this project)
      const CONTEXT_DEPTH = parseInt(process.env.CLAUDE_MEM_CONTEXT_OBSERVATIONS || '50', 10);
      const sessionStartObs = db.db.prepare(`
        SELECT id, type, title, subtitle
        FROM observations
        WHERE project = ?
        ORDER BY created_at_epoch DESC
        LIMIT ?
      `).all(project, CONTEXT_DEPTH) as Array<{ id: number; type: string; title: string; subtitle: string }>;

      silentDebug(`[new-hook] Calling context selection with ${sessionStartObs.length} session start observations`);

      // Step 2: Call context selection endpoint
      const selectionResponse = await fetch(`http://127.0.0.1:${port}/api/context/select-from-timeline`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userPrompt: prompt,
          project
        })
      });

      if (!selectionResponse.ok) {
        const errorText = await selectionResponse.text();
        silentDebug(`[new-hook] Context selection failed with ${selectionResponse.status}`, { error: errorText });
      } else {
        const selection = await selectionResponse.json();
        silentDebug(`[new-hook] Context selection complete`, selection);

        // Step 3: Fetch full observations for selected IDs
        const selectedIds: number[] = selection.relevant_observation_ids || [];

        if (selectedIds.length > 0) {
          const placeholders = selectedIds.map(() => '?').join(',');
          const fullObservations = db.db.prepare(`
            SELECT id, type, title, subtitle, narrative, facts, concepts
            FROM observations
            WHERE id IN (${placeholders})
            ORDER BY created_at_epoch DESC
          `).all(...selectedIds);

          // Format observations as markdown
          const obsContext = fullObservations.map((obs: any) => {
            let text = `### [${obs.id}] ${obs.title}\n\n`;
            if (obs.subtitle) text += `${obs.subtitle}\n\n`;
            if (obs.narrative) text += `**Context:** ${obs.narrative}\n\n`;
            if (obs.facts) {
              try {
                const facts = JSON.parse(obs.facts);
                if (Array.isArray(facts) && facts.length > 0) {
                  text += `**Facts:**\n${facts.map(f => `- ${f}`).join('\n')}\n\n`;
                }
              } catch {}
            }
            return text;
          }).join('\n---\n\n');

          realtimeContext = `# Relevant Context from Past Sessions\n\n${obsContext}`;
          silentDebug(`[new-hook] ✓ Injected ${selectedIds.length} observations as context`);
        } else {
          silentDebug(`[new-hook] No relevant observations selected`);
        }

        // TODO: Step 4: If needs_search is true, search for additional observations
        // This would call the search API and add those results to the context
      }
    } catch (error: any) {
      // Log the error but don't block the prompt
      silentDebug('[new-hook] Real-time context selection failed', {
        message: error.message,
        cause: error.cause,
        stack: error.stack
      });
    }
  }

  // Close database connection after all operations complete
  db.close();

  console.log(createHookResponse('UserPromptSubmit', true, { context: realtimeContext }));
}

// Entry Point
let input = '';
stdin.on('data', (chunk) => input += chunk);
stdin.on('end', async () => {
  const parsed = input ? JSON.parse(input) : undefined;
  await newHook(parsed);
});
