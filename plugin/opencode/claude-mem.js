#!/usr/bin/env node

/**
 * Claude-Mem Plugin for OpenCode
 *
 * Provides persistent memory across OpenCode sessions by:
 * - Capturing session lifecycle events
 * - Recording tool usage and file edits as observations
 * - Injecting relevant context from past work
 * - Generating session summaries
 *
 * Installation:
 * 1. ln -sf /path/to/claude-mem/plugin/opencode/claude-mem.js ~/.config/opencode/plugin/claude-mem.js
 * 2. Ensure claude-mem worker is running (npm run worker:start)
 * 3. Restart OpenCode
 */

import { tool } from '@opencode-ai/plugin';

const WORKER_HOST = process.env.CLAUDE_MEM_WORKER_HOST || 'localhost';
const WORKER_PORT = process.env.CLAUDE_MEM_WORKER_PORT || '37777';
const BASE_URL = `http://${WORKER_HOST}:${WORKER_PORT}`;

// Track session states
const sessionStates = new Map();

// Helper: Make HTTP request to worker
async function workerRequest(endpoint, method = 'GET', body = null) {
  try {
    const options = {
      method,
      headers: { 'Content-Type': 'application/json' },
    };

    if (body) {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(`${BASE_URL}${endpoint}`, options);

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Worker ${method} ${endpoint}: ${response.status} - ${error}`);
    }

    return await response.json();
  } catch (error) {
    console.error(`[claude-mem] Worker request failed:`, error.message);
    throw error;
  }
}

// Helper: Initialize session in claude-mem
async function initializeSession(sessionID, project) {
  try {
    const result = await workerRequest('/api/sessions/init', 'POST', {
      session_id: sessionID,
      project: project?.name || 'default',
      started_at: new Date().toISOString(),
    });

    sessionStates.set(sessionID, {
      initialized: true,
      project: project?.name || 'default',
      startTime: Date.now(),
    });

    return result;
  } catch (error) {
    console.error(`[claude-mem] Failed to initialize session ${sessionID}:`, error.message);
  }
}

// Helper: Save observation
async function saveObservation(sessionID, observation) {
  try {
    const state = sessionStates.get(sessionID);
    if (!state?.initialized) {
      console.warn(`[claude-mem] Session ${sessionID} not initialized, skipping observation`);
      return;
    }

    await workerRequest('/api/sessions/observations', 'POST', {
      session_id: sessionID,
      ...observation,
      created_at: new Date().toISOString(),
    });
  } catch (error) {
    console.error(`[claude-mem] Failed to save observation:`, error.message);
  }
}

// Helper: Get context for injection
async function getContext(sessionID, project) {
  try {
    const params = new URLSearchParams({
      session_id: sessionID,
      project: project || 'default',
    });

    const result = await workerRequest(`/api/context/inject?${params}`);
    return result.context || '';
  } catch (error) {
    console.error(`[claude-mem] Failed to get context:`, error.message);
    return '';
  }
}

// Helper: Summarize session
async function summarizeSession(sessionID) {
  try {
    const state = sessionStates.get(sessionID);
    if (!state?.initialized) {
      return;
    }

    await workerRequest('/api/sessions/summarize', 'POST', {
      session_id: sessionID,
      summary: 'OpenCode session completed',
      ended_at: new Date().toISOString(),
    });

    sessionStates.delete(sessionID);
  } catch (error) {
    console.error(`[claude-mem] Failed to summarize session:`, error.message);
  }
}

/**
 * Main plugin export
 */
export const ClaudeMemPlugin = async ({ client, project, directory }) => {
  console.log(`[claude-mem] Plugin loaded for project: ${project?.name || 'default'}`);

  // Check worker health
  try {
    await workerRequest('/api/health');
    console.log(`[claude-mem] Connected to worker at ${BASE_URL}`);
  } catch (error) {
    console.error(`[claude-mem] WARNING: Cannot connect to worker at ${BASE_URL}`);
    console.error(`[claude-mem] Start worker with: npm run worker:start`);
  }

  return {
    /**
     * Custom tools for memory operations
     */
    tool: {
      search_memory: tool({
        description: 'Search past work and learnings from previous sessions. Returns index with observation IDs (~50-100 tokens/result). For full details, use get_memory_details.',
        args: {
          query: tool.schema.string().describe('What to search for in past work'),
          limit: tool.schema.number().optional().default(10).describe('Number of results'),
          project: tool.schema.string().optional().describe('Filter by project name'),
          type: tool.schema.string().optional().describe('Filter by type: bugfix, feature, decision, discovery, refactor'),
        },
        async execute(args, ctx) {
          const params = new URLSearchParams();
          Object.entries(args).forEach(([key, value]) => {
            if (value !== undefined && value !== null) {
              params.append(key, String(value));
            }
          });

          const results = await workerRequest(`/api/search?${params}`);
          return JSON.stringify(results, null, 2);
        },
      }),

      get_memory_details: tool({
        description: 'Fetch full details for specific observations after filtering search results. ONLY use after search_memory to avoid token waste.',
        args: {
          ids: tool.schema.array(tool.schema.number()).describe('Array of observation IDs from search_memory'),
        },
        async execute(args, ctx) {
          const results = await workerRequest('/api/observations/batch', 'POST', args);
          return JSON.stringify(results, null, 2);
        },
      }),

      timeline_memory: tool({
        description: 'Get chronological context around a specific observation. Shows what happened before and after.',
        args: {
          anchor: tool.schema.number().describe('Observation ID to get context around'),
          depth_before: tool.schema.number().optional().default(2).describe('How many observations before'),
          depth_after: tool.schema.number().optional().default(2).describe('How many observations after'),
        },
        async execute(args, ctx) {
          const params = new URLSearchParams();
          Object.entries(args).forEach(([key, value]) => {
            if (value !== undefined && value !== null) {
              params.append(key, String(value));
            }
          });

          const results = await workerRequest(`/api/timeline?${params}`);
          return JSON.stringify(results, null, 2);
        },
      }),
    },

    /**
     * Event handler for session lifecycle
     */
    event: async (event) => {
      const sessionID = event.session_id || event.sessionID;
      if (!sessionID) return;

      switch (event.type) {
        case 'session.created':
          console.log(`[claude-mem] Session created: ${sessionID}`);
          await initializeSession(sessionID, project);
          break;

        case 'session.deleted':
          console.log(`[claude-mem] Session deleted: ${sessionID}`);
          await summarizeSession(sessionID);
          break;

        case 'session.compacted':
          console.log(`[claude-mem] Session compacted: ${sessionID}, re-injecting context`);
          // Wait for OpenCode's internal lock to release
          await new Promise(r => setTimeout(r, 100));

          const context = await getContext(sessionID, project?.name);
          if (context) {
            await client.session.prompt(sessionID, {
              role: 'system',
              content: `# Claude-Mem Context\n\n${context}`,
              noReply: true,
            });
          }
          break;

        case 'tool.execute.after':
          // Capture tool usage as observations
          if (event.tool && event.result) {
            await saveObservation(sessionID, {
              type: 'discovery',
              title: `Used ${event.tool.name} tool`,
              text: JSON.stringify({
                tool: event.tool.name,
                args: event.tool.args,
                result: typeof event.result === 'string' ? event.result.substring(0, 500) : event.result,
              }, null, 2),
              tool_name: event.tool.name,
            });
          }
          break;

        case 'file.edited':
          // Capture file edits
          if (event.file) {
            await saveObservation(sessionID, {
              type: 'change',
              title: `Edited ${event.file.path}`,
              text: event.file.diff || 'File modified',
              file_path: event.file.path,
              tool_name: 'write_file',
            });
          }
          break;
      }
    },

    /**
     * Chat message hook for initial context injection
     */
    'chat.message': async (message) => {
      // Inject context on first user message
      if (message.role === 'user') {
        const sessionID = message.sessionID || message.session_id;
        const state = sessionStates.get(sessionID);

        // Only inject once per session
        if (state?.initialized && !state.contextInjected) {
          const context = await getContext(sessionID, project?.name);

          if (context) {
            // Mark as injected
            state.contextInjected = true;
            sessionStates.set(sessionID, state);

            // Return modified message with context prepended
            return {
              ...message,
              content: `${context}\n\n---\n\n${message.content}`,
            };
          }
        }
      }

      return message;
    },
  };
};

export default ClaudeMemPlugin;
