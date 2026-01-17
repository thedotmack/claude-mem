#!/usr/bin/env node

/**
 * Claude-Mem Plugin for OpenCode
 *
 * Matches Claude Code behavior with OpenCode adaptations:
 * - SessionStart: Context injection on session.created
 * - UserPromptSubmit: Session initialization on first user message OR first tool use
 * - PostToolUse: Observation capture on tool execution
 * - SessionEnd: Summary generation on session.deleted
 *
 * Note: OpenCode plan mode doesn't fire user message events, so we initialize
 * on first tool execution as fallback (when switching plan -> build mid-session)
 */

import { z } from 'zod';

const WORKER_HOST = process.env.CLAUDE_MEM_WORKER_HOST || 'localhost';
const WORKER_PORT = process.env.CLAUDE_MEM_WORKER_PORT || '37777';
const BASE_URL = `http://${WORKER_HOST}:${WORKER_PORT}`;

const sessionStates = new Map();

function log(level, message, data = {}) {
  const prefix = `[claude-mem][${level}]`;
  const dataStr = Object.keys(data).length > 0 ? ` ${JSON.stringify(data)}` : '';
  console[level === 'ERROR' ? 'error' : 'log'](`${prefix} ${message}${dataStr}`);
}

async function workerRequest(endpoint, method = 'GET', body = null) {
  const url = `${BASE_URL}${endpoint}`;
  
  try {
    const options = { method, headers: { 'Content-Type': 'application/json' } };
    if (body) options.body = JSON.stringify(body);
    const response = await fetch(url, options);
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Worker ${method} ${endpoint} failed: ${response.status} - ${errorText}`);
    }
    const contentType = response.headers.get('content-type');
    return contentType?.includes('application/json') ? await response.json() : await response.text();
  } catch (error) {
    if (error.message.includes('ECONNREFUSED')) {
      log('ERROR', 'Worker not running! Start with: npm run worker:start');
    } else {
      log('ERROR', 'Worker request failed', { endpoint, error: error.message });
    }
    throw error;
  }
}

export const ClaudeMemPlugin = async ({ client, project, directory }) => {
  const projectName = project?.name || 'default';
  const projectCwd = directory || project?.worktree || '/unknown';
  
  log('INFO', `Plugin loaded`, { project: projectName });

  const initializeSession = async (contentSessionId, promptOrTool, source) => {
    log('INFO', `Initializing session (${source})`, { contentSessionId });
    const result = await workerRequest('/api/sessions/init', 'POST', {
      contentSessionId,
      project: projectName,
      prompt: promptOrTool,
    });
    log('INFO', `Session initialized`, { sessionDbId: result.sessionDbId, source });
    return result;
  };

  const saveObservation = async (contentSessionId, toolName, toolInput, toolResponse, cwd) => {
    await workerRequest('/api/sessions/observations', 'POST', {
      contentSessionId,
      tool_name: toolName,
      tool_input: typeof toolInput === 'string' ? toolInput : JSON.stringify(toolInput || {}),
      tool_response: typeof toolResponse === 'string' ? toolResponse : JSON.stringify(toolResponse || ''),
      cwd: cwd || '/unknown',
    });
    log('INFO', `Observation saved: ${toolName}`);
  };

  const getContext = async () => {
    const params = new URLSearchParams({ project: projectName });
    return await workerRequest(`/api/context/inject?${params}`) || '';
  };

  const summarizeSession = async (contentSessionId) => {
    log('INFO', `Summarizing session`, { contentSessionId });
    await workerRequest('/api/sessions/summarize', 'POST', {
      contentSessionId,
      last_assistant_message: 'Session completed',
    });
    log('INFO', `Session summarized`);
  };

  return {
    tool: {
      search_memory: {
        description: 'Search past work and learnings from previous sessions.',
        args: {
          query: z.string().describe('What to search for'),
          limit: z.number().optional().default(10),
          project: z.string().optional(),
        },
        async execute(args) {
          try {
            const params = new URLSearchParams();
            if (args.query) params.append('query', args.query);
            if (args.limit) params.append('limit', String(args.limit));
            params.append('project', args.project || projectName);
            return JSON.stringify(await workerRequest(`/api/search?${params}`), null, 2);
          } catch (error) {
            return `Error: ${error.message}\n\nMake sure worker is running: npm run worker:start`;
          }
        },
      },

      get_memory_details: {
        description: 'Fetch full details for specific observations by ID.',
        args: {
          ids: z.array(z.number()).describe('Observation IDs'),
        },
        async execute(args) {
          try {
            return JSON.stringify(await workerRequest('/api/observations/batch', 'POST', args), null, 2);
          } catch (error) {
            return `Error: ${error.message}`;
          }
        },
      },

      timeline_memory: {
        description: 'Get chronological context around a specific observation.',
        args: {
          anchor: z.number().describe('Observation ID'),
          depth_before: z.number().optional().default(2),
          depth_after: z.number().optional().default(2),
        },
        async execute(args) {
          try {
            const params = new URLSearchParams();
            Object.entries(args).forEach(([k, v]) => {
              if (v !== undefined && v !== null) params.append(k, String(v));
            });
            return JSON.stringify(await workerRequest(`/api/timeline?${params}`), null, 2);
          } catch (error) {
            return `Error: ${error.message}`;
          }
        },
      },
    },

    event: async ({ event }) => {
      try {
        // SessionStart equivalent - inject context immediately
        if (event.type === 'session.created') {
          const sessionID = event.properties?.info?.id || event.properties?.sessionID;
          if (sessionID) {
            log('INFO', `Session created`, { sessionID });
            
            // Create session state
            sessionStates.set(sessionID, {
              initialized: false,
              project: projectName,
              cwd: event.properties?.info?.directory || projectCwd,
            });
            
            // Inject context immediately (like SessionStart hook)
            try {
              const context = await getContext();
              if (context) {
                await client.session.prompt({
                  path: { id: sessionID },
                  body: {
                    noReply: true,
                    parts: [{ type: 'text', text: `# Claude-Mem Context\n\n${context}`, synthetic: true }],
                  },
                });
                log('INFO', `Context injected (SessionStart)`);
              }
            } catch (error) {
              log('ERROR', `Failed to inject context`, { error: error.message });
            }
          }
        }
        
        // UserPromptSubmit equivalent - initialize session with user prompt
        if (event.type === 'message.updated') {
          const info = event.properties?.info;
          const sessionID = info?.sessionID;
          
          if (info?.role === 'user' && sessionID) {
            const state = sessionStates.get(sessionID);
            
            // Create state if missing (plugin loaded after session started)
            if (!state) {
              sessionStates.set(sessionID, {
                initialized: false,
                project: projectName,
                cwd: projectCwd,
              });
            }
            
            // Initialize on first user message
            const currentState = sessionStates.get(sessionID);
            if (currentState && !currentState.initialized) {
              const userText = info.parts?.filter(p => p.type === 'text').map(p => p.text).join('\n');
              if (userText) {
                try {
                  await initializeSession(sessionID, userText, 'UserPromptSubmit');
                  currentState.initialized = true;
                  sessionStates.set(sessionID, currentState);
                } catch (error) {
                  log('ERROR', `Failed to initialize session`, { error: error.message });
                }
              }
            }
          }
        }

        // SessionEnd equivalent - summarize on deletion
        if (event.type === 'session.deleted') {
          const sessionID = event.properties?.info?.id || event.properties?.sessionID;
          if (sessionID) {
            const state = sessionStates.get(sessionID);
            if (state?.initialized) {
              try {
                await summarizeSession(sessionID);
              } catch (error) {
                log('ERROR', `Failed to summarize`, { error: error.message });
              }
            }
            sessionStates.delete(sessionID);
            log('INFO', `Session deleted`, { sessionID, wasInitialized: state?.initialized });
          }
        }

        // Re-inject context after compaction
        if (event.type === 'session.compacted') {
          const sessionID = event.properties?.info?.id || event.properties?.sessionID;
          if (sessionID) {
            const state = sessionStates.get(sessionID);
            if (state?.initialized) {
              try {
                await new Promise(r => setTimeout(r, 100));
                const context = await getContext();
                if (context) {
                  await client.session.prompt({
                    path: { id: sessionID },
                    body: {
                      noReply: true,
                      parts: [{ type: 'text', text: `# Claude-Mem Context\n\n${context}`, synthetic: true }],
                    },
                  });
                  log('INFO', `Context re-injected after compaction`);
                }
              } catch (error) {
                log('ERROR', `Failed to re-inject context`, { error: error.message });
              }
            }
          }
        }
      } catch (error) {
        log('ERROR', `Event handler failed`, { eventType: event.type, error: error.message });
      }
    },

    // PostToolUse equivalent - save observations, with fallback initialization
    'tool.execute.after': async (input, output) => {
      const { tool: toolName, sessionID } = input;
      
      try {
        let state = sessionStates.get(sessionID);
        
        // Create state if missing (plugin loaded after session started)
        if (!state) {
          log('INFO', `Creating session state on tool use`, { sessionID });
          state = { initialized: false, project: projectName, cwd: projectCwd };
          sessionStates.set(sessionID, state);
        }
        
        // Fallback: Initialize on first tool if not yet initialized
        // (handles plan -> build mode switches where no user message event fired)
        if (!state.initialized) {
          log('INFO', `Initializing on first tool use (plan->build fallback)`, { sessionID, toolName });
          try {
            await initializeSession(sessionID, `[Build mode - started with ${toolName}]`, 'ToolExecuteFallback');
            state.initialized = true;
            sessionStates.set(sessionID, state);
          } catch (error) {
            log('ERROR', `Failed to initialize`, { error: error.message });
            return;
          }
        }
        
        // Save observation
        const { output: toolOutput, metadata } = output;
        await saveObservation(
          sessionID,
          toolName,
          metadata?.input || {},
          (toolOutput || '').substring(0, 2000),
          state.cwd
        );
      } catch (error) {
        log('ERROR', `tool.execute.after failed`, { tool: toolName, error: error.message });
      }
    },

    'experimental.session.compacting': async (input, output) => {
      try {
        const { sessionID } = input;
        const state = sessionStates.get(sessionID);
        
        if (state?.initialized && output.context) {
          const context = await getContext();
          if (context) {
            output.context.push(context);
            log('INFO', `Context injected via compacting hook`);
          }
        }
      } catch (error) {
        log('ERROR', `session.compacting failed`, { error: error.message });
      }
    },
  };
};

export default ClaudeMemPlugin;
