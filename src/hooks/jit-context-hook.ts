/**
 * JIT Context Hook - UserPromptSubmit
 *
 * Uses an LLM agent to filter session-start context observations,
 * returning only the most relevant ones for the current user prompt.
 *
 * Architecture:
 * 1. Fetch the same 50 observations loaded at session-start
 * 2. Launch Haiku agent with observation list + user prompt
 * 3. Agent picks 3-5 most relevant observation IDs
 * 4. Return full observation data as context
 */

import path from 'path';
import { stdin } from 'process';
import { SessionStore } from '../services/sqlite/SessionStore.js';
import { createHookResponse } from './hook-response.js';
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

const CONTEXT_OBSERVATION_COUNT = parseInt(process.env.CLAUDE_MEM_CONTEXT_OBSERVATIONS || '50', 10);

/**
 * Use agent to filter startup context observations
 */
async function jitContextHook(input?: UserPromptSubmitInput): Promise<void> {
  if (!input) {
    throw new Error('jitContextHook requires input');
  }

  const { cwd, prompt } = input;
  const project = path.basename(cwd);

  const db = new SessionStore();

  try {
    // Fetch the same observations that were loaded at session-start
    const observations = db.db.prepare(`
      SELECT
        id, type, title, subtitle, narrative,
        facts, concepts, files_modified, created_at
      FROM observations
      WHERE project = ?
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `).all(project, CONTEXT_OBSERVATION_COUNT) as Observation[];

    if (observations.length === 0) {
      // No context available - return empty
      console.log(createHookResponse('UserPromptSubmit', true));
      return;
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
      // Agent determined nothing is relevant
      console.log(createHookResponse('UserPromptSubmit', true));
      return;
    }

    // Parse observation IDs
    const selectedIds = agentOutput
      .split(',')
      .map((id: string) => parseInt(id.trim(), 10))
      .filter((id: number) => !isNaN(id));

    if (selectedIds.length === 0) {
      console.log(createHookResponse('UserPromptSubmit', true));
      return;
    }

    // Fetch full observation data for selected IDs
    const selectedObservations = observations.filter(obs => selectedIds.includes(obs.id));

    // Format as context
    const contextLines: string[] = [
      '# Related context:',
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

    const context = contextLines.join('\n');
    console.log(createHookResponse('UserPromptSubmit', true, { context }));

  } catch (error: any) {
    console.error(`[jit-context-hook] Error: ${error.message}`);
    // On error, return empty context rather than failing
    console.log(createHookResponse('UserPromptSubmit', true));
  } finally {
    db.close();
  }
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

// Entry Point
let input = '';
stdin.on('data', (chunk) => input += chunk);
stdin.on('end', async () => {
  const parsed = input ? JSON.parse(input) : undefined;
  await jitContextHook(parsed);
});
