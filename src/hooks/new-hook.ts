/**
 * New Hook - UserPromptSubmit
 * Consolidated entry point + logic with optional JIT context filtering
 */

import path from 'path';
import { stdin } from 'process';
import { SessionStore } from '../services/sqlite/SessionStore.js';
import { createHookResponse } from './hook-response.js';
import { ensureWorkerRunning, getWorkerPort } from '../shared/worker-utils.js';
import { getContextDepth, isJitContextEnabled } from '../shared/settings.js';
// @ts-ignore - Agent SDK types may not be available
import { query } from '@anthropic-ai/claude-agent-sdk';

export interface UserPromptSubmitInput {
  session_id: string;
  cwd: string;
  prompt: string;
  [key: string]: any;
}

interface Observation {
  id: number;
  type: string;
  title: string | null;
  subtitle: string | null;
  narrative: string | null;
  facts: string | null;
  concepts: string | null;
  files_modified: string | null;
  created_at: string;
}

/**
 * Get emoji for observation type
 */
function getTypeEmoji(type: string): string {
  const emojiMap: Record<string, string> = {
    'bugfix': '🔴',
    'feature': '🟣',
    'refactor': '🔄',
    'change': '✅',
    'discovery': '🔵',
    'decision': '🧠'
  };
  return emojiMap[type] || '📝';
}

/**
 * Generate JIT context by filtering observations with an LLM agent
 */
async function generateJitContext(db: SessionStore, project: string, prompt: string): Promise<string | null> {
  const contextObservationCount = getContextDepth();

  // Fetch recent observations for this project
  const observations = db.db.prepare(`
    SELECT
      id, type, title, subtitle, narrative,
      facts, concepts, files_modified, created_at
    FROM observations
    WHERE project = ?
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `).all(project, contextObservationCount) as Observation[];

  if (observations.length === 0) {
    return `🔍 **JIT Context**: No previous observations found for this project.`;
  }

  // Format observations for agent (lightweight list)
  const observationList = observations.map(obs => {
    const typeEmoji = getTypeEmoji(obs.type);
    return `${typeEmoji} #${obs.id}: ${obs.title || 'Untitled'} (${obs.type})`;
  }).join('\n');

  // Create message generator for SDK query
  async function* messageGenerator() {
    yield {
      role: 'user' as const,
      content: `You are filtering past observations for relevance to a user's current question.

# Available observations (from session-start context):
${observationList}

# User's current question:
${prompt}

# Task:
Select the 3-5 most relevant observation IDs (just the numbers) that would help answer this question.
If nothing is relevant, respond with "NONE".

Respond ONLY with comma-separated IDs (e.g., "1234,5678,9012") or "NONE".`
    };
  }

  // Launch SDK agent to pick relevant IDs
  const queryResult = query({
    prompt: messageGenerator(),
    options: {
      model: process.env.CLAUDE_MEM_MODEL || 'claude-haiku-4-5'
    }
  });

  let agentOutput = '';
  for await (const message of queryResult) {
    if (message.type === 'assistant') {
      const content = message.message.content;
      const textContent = Array.isArray(content)
        ? content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n')
        : typeof content === 'string' ? content : '';
      agentOutput += textContent;
    }
  }

  agentOutput = agentOutput.trim();

  if (agentOutput === 'NONE' || !agentOutput) {
    return `🔍 **JIT Context**: Agent analyzed ${observations.length} observations and found none directly relevant to your prompt.`;
  }

  // Parse observation IDs
  const selectedIds = agentOutput
    .split(',')
    .map((id: string) => parseInt(id.trim(), 10))
    .filter((id: number) => !isNaN(id));

  if (selectedIds.length === 0) {
    return `🔍 **JIT Context**: Agent response could not be parsed into valid observation IDs. Response: "${agentOutput}"`;
  }

  // Fetch full observation data for selected IDs
  const selectedObservations = observations.filter(obs => selectedIds.includes(obs.id));

  // Format as context
  const contextLines: string[] = [
    '# Related context from JIT filtering:',
    ''
  ];

  for (const obs of selectedObservations) {
    const typeEmoji = getTypeEmoji(obs.type);
    contextLines.push(`## ${typeEmoji} ${obs.title || 'Untitled'}`);

    if (obs.subtitle) {
      contextLines.push(`**${obs.subtitle}**`);
      contextLines.push('');
    }

    if (obs.narrative) {
      contextLines.push(obs.narrative);
      contextLines.push('');
    }

    if (obs.facts) {
      contextLines.push('**Facts:**');
      contextLines.push(obs.facts);
      contextLines.push('');
    }

    if (obs.files_modified) {
      contextLines.push(`**Files:** ${obs.files_modified}`);
      contextLines.push('');
    }

    contextLines.push('---');
    contextLines.push('');
  }

  return contextLines.join('\n');
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

  try {
    // Save session_id for indexing
    const sessionDbId = db.createSDKSession(session_id, project, prompt);
    const promptNumber = db.incrementPromptCounter(sessionDbId);

    // Save raw user prompt for full-text search
    db.saveUserPrompt(session_id, promptNumber, prompt);

    console.error(`[new-hook] Session ${sessionDbId}, prompt #${promptNumber}`);

    const port = getWorkerPort();

    // Initialize session via HTTP
    const response = await fetch(`http://127.0.0.1:${port}/sessions/${sessionDbId}/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project, userPrompt: prompt }),
      signal: AbortSignal.timeout(5000)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to initialize session: ${response.status} ${errorText}`);
    }

    // Generate JIT context if enabled
    let context: string | null = null;
    if (isJitContextEnabled()) {
      try {
        context = await generateJitContext(db, project, prompt);
      } catch (error: any) {
        console.error(`[new-hook] JIT context error: ${error.message}`);
        context = `🔍 **JIT Context**: Error occurred while filtering context: ${error.message}`;
      }
    }

    db.close();

    if (context) {
      console.log(createHookResponse('UserPromptSubmit', true, { context }));
    } else {
      console.log(createHookResponse('UserPromptSubmit', true));
    }
  } catch (error: any) {
    db.close();
    // Only show restart message for connection errors, not HTTP errors
    if (error.cause?.code === 'ECONNREFUSED' || error.name === 'TimeoutError' || error.message.includes('fetch failed')) {
      throw new Error("There's a problem with the worker. If you just updated, type `pm2 restart claude-mem-worker` in your terminal to continue");
    }
    // Re-throw HTTP errors and other errors as-is
    throw error;
  }
}

// Entry Point
let input = '';
stdin.on('data', (chunk) => input += chunk);
stdin.on('end', async () => {
  const parsed = input ? JSON.parse(input) : undefined;
  await newHook(parsed);
});
