#!/usr/bin/env node
/**
 * SDK Worker Process
 * Background server that processes tool observations via Unix socket
 */

// Bun-specific ImportMeta extension
declare global {
  interface ImportMeta {
    main: boolean;
  }
}

import net from 'net';
import { unlinkSync, existsSync } from 'fs';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKUserMessage, SDKSystemMessage } from '@anthropic-ai/claude-agent-sdk';
import { SessionStore } from '../services/sqlite/SessionStore.js';
import { getWorkerSocketPath } from '../shared/paths.js';
import { buildInitPrompt, buildObservationPrompt, buildSummaryPrompt } from './prompts.js';
import { parseObservations, parseSummary } from './parser.js';
import type { SDKSession } from './prompts.js';

const MODEL = 'claude-sonnet-4-5';
const DISALLOWED_TOOLS = ['Glob', 'Grep', 'ListMcpResourcesTool', 'WebSearch'];

interface ObservationMessage {
  type: 'observation';
  tool_name: string;
  tool_input: string;
  tool_output: string;
}

interface FinalizeMessage {
  type: 'finalize';
}

type WorkerMessage = ObservationMessage | FinalizeMessage;

/**
 * Main worker process entry point
 */
export async function main() {
  console.error('[SDK Worker DEBUG] main() called');
  const sessionDbId = parseInt(process.argv[2], 10);
  console.error(`[SDK Worker DEBUG] Session DB ID: ${sessionDbId}`);

  if (!sessionDbId) {
    console.error('[SDK Worker] Missing session ID argument');
    process.exit(1);
  }

  const worker = new SDKWorker(sessionDbId);
  console.error('[SDK Worker DEBUG] SDKWorker instance created');
  await worker.run();
}

/**
 * SDK Worker - Unix socket server that processes observations
 */
class SDKWorker {
  private sessionDbId: number;
  private db: SessionStore;
  private socketPath: string;
  private server: net.Server | null = null;
  private sdkSessionId: string | null = null;
  private project: string = '';
  private userPrompt: string = '';
  private abortController: AbortController;
  private isFinalized = false;
  private pendingMessages: WorkerMessage[] = [];

  constructor(sessionDbId: number) {
    this.sessionDbId = sessionDbId;
    this.db = new SessionStore();
    this.abortController = new AbortController();
    this.socketPath = getWorkerSocketPath(sessionDbId);
    console.error('[claude-mem worker] Worker instance created', {
      sessionDbId,
      socketPath: this.socketPath
    });
  }

  /**
   * Main run loop
   */
  async run(): Promise<void> {
    console.error('[claude-mem worker] Worker run() started', {
      sessionDbId: this.sessionDbId,
      socketPath: this.socketPath
    });

    try {
      // Load session info
      const session = await this.loadSession();
      if (!session) {
        console.error('[claude-mem worker] Session not found in database', {
          sessionDbId: this.sessionDbId
        });
        process.exit(1);
      }

      console.error('[claude-mem worker] Session loaded successfully', {
        sessionDbId: this.sessionDbId,
        project: session.project,
        sdkSessionId: session.sdk_session_id,
        userPromptLength: session.user_prompt?.length || 0
      });

      this.project = session.project;
      this.userPrompt = session.user_prompt;

      // Start Unix socket server
      await this.startSocketServer();
      console.error('[claude-mem worker] Socket server started successfully', {
        socketPath: this.socketPath,
        sessionDbId: this.sessionDbId
      });

      // Run SDK agent with streaming input
      console.error('[claude-mem worker] Starting SDK agent', {
        sessionDbId: this.sessionDbId,
        model: MODEL
      });
      await this.runSDKAgent();

      // Mark session as completed
      console.error('[claude-mem worker] SDK agent completed, marking session as completed', {
        sessionDbId: this.sessionDbId,
        sdkSessionId: this.sdkSessionId
      });
      this.db.markSessionCompleted(this.sessionDbId);
      this.db.close();
      this.cleanup();

    } catch (error: any) {
      console.error('[claude-mem worker] Fatal error in run()', {
        sessionDbId: this.sessionDbId,
        error: error.message,
        stack: error.stack
      });
      this.db.markSessionFailed(this.sessionDbId);
      this.db.close();
      this.cleanup();
      process.exit(1);
    }
  }

  /**
   * Start Unix socket server to receive messages from hooks
   */
  private async startSocketServer(): Promise<void> {
    console.error(`[SDK Worker DEBUG] Starting socket server...`);
    console.error(`[SDK Worker DEBUG] Socket path: ${this.socketPath}`);

    // Clean up old socket if it exists
    if (existsSync(this.socketPath)) {
      console.error(`[SDK Worker DEBUG] Removing existing socket`);
      unlinkSync(this.socketPath);
    }

    return new Promise((resolve, reject) => {
      console.error(`[SDK Worker DEBUG] Creating net server...`);
      this.server = net.createServer((socket) => {
        console.error('[claude-mem worker] Socket connection received', {
          sessionDbId: this.sessionDbId,
          socketPath: this.socketPath
        });
        let buffer = '';

        socket.on('data', (chunk) => {
          console.error('[claude-mem worker] Data received on socket', {
            sessionDbId: this.sessionDbId,
            chunkSize: chunk.length
          });
          buffer += chunk.toString();

          // Try to parse complete JSON messages (separated by newlines)
          const lines = buffer.split('\n');
          buffer = lines.pop() || ''; // Keep incomplete line in buffer

          for (const line of lines) {
            if (line.trim()) {
              try {
                const message: WorkerMessage = JSON.parse(line);
                console.error('[claude-mem worker] Message received from socket', {
                  sessionDbId: this.sessionDbId,
                  messageType: message.type,
                  rawMessage: line.substring(0, 500) // Truncate to avoid massive logs
                });
                this.handleMessage(message);
              } catch (err) {
                console.error('[claude-mem worker] Invalid message - failed to parse JSON', {
                  sessionDbId: this.sessionDbId,
                  error: err instanceof Error ? err.message : String(err),
                  rawLine: line.substring(0, 200)
                });
              }
            }
          }
        });

        socket.on('error', (err) => {
          console.error('[claude-mem worker] Socket connection error', {
            sessionDbId: this.sessionDbId,
            error: err.message,
            stack: err.stack
          });
        });
      });

      this.server.on('error', (err: any) => {
        if (err.code === 'EADDRINUSE') {
          console.error('[claude-mem worker] Socket already in use', {
            socketPath: this.socketPath,
            sessionDbId: this.sessionDbId
          });
        } else {
          console.error('[claude-mem worker] Server error', {
            sessionDbId: this.sessionDbId,
            error: err.message,
            code: err.code,
            stack: err.stack
          });
        }
        reject(err);
      });

      this.server.listen(this.socketPath, () => {
        console.error(`[SDK Worker DEBUG] listen() callback fired`);
        console.error(`[SDK Worker DEBUG] Checking if socket exists: ${existsSync(this.socketPath)}`);
        resolve();
      });
    });
  }

  /**
   * Handle incoming message from hook
   */
  private handleMessage(message: WorkerMessage): void {
    console.error('[claude-mem worker] Processing message in handleMessage()', {
      sessionDbId: this.sessionDbId,
      messageType: message.type,
      pendingMessagesCount: this.pendingMessages.length
    });

    this.pendingMessages.push(message);

    if (message.type === 'finalize') {
      console.error('[claude-mem worker] FINALIZE message detected - queued for processing', {
        sessionDbId: this.sessionDbId,
        pendingMessagesCount: this.pendingMessages.length
      });
      // DON'T set isFinalized here - let the generator set it after yielding finalize prompt
    } else if (message.type === 'observation') {
      console.error('[claude-mem worker] Observation message queued', {
        sessionDbId: this.sessionDbId,
        toolName: message.tool_name,
        inputLength: message.tool_input?.length || 0,
        outputLength: message.tool_output?.length || 0
      });
    }
  }

  /**
   * Load session from database
   */
  private async loadSession(): Promise<SDKSession | null> {
    const db = this.db as any;
    const query = db.db.query(`
      SELECT id, sdk_session_id, project, user_prompt
      FROM sdk_sessions
      WHERE id = ?
      LIMIT 1
    `);

    const session = query.get(this.sessionDbId);
    return session as SDKSession | null;
  }

  /**
   * Run SDK agent with streaming input mode
   */
  private async runSDKAgent(): Promise<void> {
    // Find Claude Code executable
    const claudePath = process.env.CLAUDE_CODE_PATH || '/Users/alexnewman/.nvm/versions/node/v24.5.0/bin/claude';
    console.error(`[SDK Worker DEBUG] About to call query with claudePath: ${claudePath}`);

    const queryResult = query({
      prompt: this.createMessageGenerator(),
      options: {
        model: MODEL,
        disallowedTools: DISALLOWED_TOOLS,
        abortController: this.abortController,
        pathToClaudeCodeExecutable: claudePath
      }
    });

    // Iterate over SDK messages
    for await (const message of queryResult) {
      // Handle system init message to capture session ID
      if (message.type === 'system' && message.subtype === 'init') {
        const systemMsg = message as SDKSystemMessage;
        if (systemMsg.session_id) {
          console.error('[claude-mem worker] SDK session initialized', {
            sessionDbId: this.sessionDbId,
            sdkSessionId: systemMsg.session_id
          });
          this.sdkSessionId = systemMsg.session_id;
          this.db.updateSDKSessionId(this.sessionDbId, systemMsg.session_id);
        }
      }
      // Handle assistant messages
      else if (message.type === 'assistant') {
        const content = message.message.content;
        // Extract text content from message
        const textContent = Array.isArray(content)
          ? content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n')
          : typeof content === 'string' ? content : '';

        console.error('[claude-mem worker] SDK agent response received', {
          sessionDbId: this.sessionDbId,
          sdkSessionId: this.sdkSessionId,
          contentLength: textContent.length,
          contentPreview: textContent.substring(0, 200)
        });
        // Parse and store observations from agent response
        this.handleAgentMessage(textContent);
      }
    }
  }

  /**
   * Create async message generator for SDK streaming input
   * Now pulls from socket messages instead of polling database
   */
  private async* createMessageGenerator(): AsyncIterable<SDKUserMessage> {
    // Yield initial prompt
    const claudeSessionId = `session-${this.sessionDbId}`;
    const initPrompt = buildInitPrompt(this.project, claudeSessionId, this.userPrompt);
    console.error('[claude-mem worker] Yielding initial prompt to SDK agent', {
      sessionDbId: this.sessionDbId,
      claudeSessionId,
      project: this.project,
      promptLength: initPrompt.length
    });
    yield {
      type: 'user',
      session_id: this.sdkSessionId || claudeSessionId,
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content: initPrompt
      }
    };

    // Process messages as they arrive via socket
    while (!this.isFinalized) {
      // Wait for messages to arrive
      if (this.pendingMessages.length === 0) {
        await this.sleep(100); // Short sleep, just to yield control
        continue;
      }

      // Process all pending messages
      while (this.pendingMessages.length > 0) {
        const message = this.pendingMessages.shift()!;

        if (message.type === 'finalize') {
          console.error('[claude-mem worker] Processing FINALIZE message in generator', {
            sessionDbId: this.sessionDbId,
            sdkSessionId: this.sdkSessionId
          });
          this.isFinalized = true;
          const session = await this.loadSession();
          if (session) {
            const finalizePrompt = buildSummaryPrompt(session);
            console.error('[claude-mem worker] Yielding finalize prompt to SDK agent', {
              sessionDbId: this.sessionDbId,
              sdkSessionId: this.sdkSessionId,
              promptLength: finalizePrompt.length,
              promptPreview: finalizePrompt.substring(0, 300)
            });
            yield {
              type: 'user',
              session_id: this.sdkSessionId || claudeSessionId,
              parent_tool_use_id: null,
              message: {
                role: 'user',
                content: finalizePrompt
              }
            };
          } else {
            console.error('[claude-mem worker] Failed to load session for finalize prompt', {
              sessionDbId: this.sessionDbId
            });
          }
          break;
        }

        if (message.type === 'observation') {
          // Build observation prompt
          const observationPrompt = buildObservationPrompt({
            id: 0, // Not needed for prompt generation
            tool_name: message.tool_name,
            tool_input: message.tool_input,
            tool_output: message.tool_output,
            created_at_epoch: Date.now()
          });
          console.error('[claude-mem worker] Yielding observation prompt to SDK agent', {
            sessionDbId: this.sessionDbId,
            toolName: message.tool_name,
            promptLength: observationPrompt.length
          });
          yield {
            type: 'user',
            session_id: this.sdkSessionId || claudeSessionId,
            parent_tool_use_id: null,
            message: {
              role: 'user',
              content: observationPrompt
            }
          };
        }
      }
    }
  }

  /**
   * Handle agent message and parse observations/summaries
   */
  private handleAgentMessage(content: string): void {
    console.error('[claude-mem worker] Parsing agent message for observations and summary', {
      sessionDbId: this.sessionDbId,
      sdkSessionId: this.sdkSessionId,
      contentLength: content.length
    });

    // Parse observations
    const observations = parseObservations(content);
    console.error('[claude-mem worker] Observations parsed from response', {
      sessionDbId: this.sessionDbId,
      sdkSessionId: this.sdkSessionId,
      observationCount: observations.length
    });

    for (const obs of observations) {
      if (this.sdkSessionId) {
        console.error('[claude-mem worker] Storing observation in database', {
          sessionDbId: this.sessionDbId,
          sdkSessionId: this.sdkSessionId,
          project: this.project,
          observationType: obs.type,
          observationTextLength: obs.text?.length || 0
        });
        this.db.storeObservation(this.sdkSessionId, this.project, obs.type, obs.text);
      } else {
        console.error('[claude-mem worker] Cannot store observation - no SDK session ID', {
          sessionDbId: this.sessionDbId,
          observationType: obs.type
        });
      }
    }

    // Parse summary (if present)
    console.error('[claude-mem worker] Attempting to parse summary from response', {
      sessionDbId: this.sessionDbId,
      sdkSessionId: this.sdkSessionId
    });

    const summary = parseSummary(content);
    if (summary && this.sdkSessionId) {
      console.error('[claude-mem worker] Summary parsed successfully', {
        sessionDbId: this.sessionDbId,
        sdkSessionId: this.sdkSessionId,
        project: this.project,
        hasRequest: !!summary.request,
        hasInvestigated: !!summary.investigated,
        hasLearned: !!summary.learned,
        hasCompleted: !!summary.completed,
        filesReadCount: summary.files_read?.length || 0,
        filesEditedCount: summary.files_edited?.length || 0
      });

      // Convert file arrays to JSON strings
      const summaryWithArrays = {
        request: summary.request,
        investigated: summary.investigated,
        learned: summary.learned,
        completed: summary.completed,
        next_steps: summary.next_steps,
        files_read: JSON.stringify(summary.files_read),
        files_edited: JSON.stringify(summary.files_edited),
        notes: summary.notes
      };

      console.error('[claude-mem worker] Storing summary in database', {
        sessionDbId: this.sessionDbId,
        sdkSessionId: this.sdkSessionId,
        project: this.project
      });

      this.db.storeSummary(this.sdkSessionId, this.project, summaryWithArrays);

      console.error('[claude-mem worker] Summary stored successfully in database', {
        sessionDbId: this.sessionDbId,
        sdkSessionId: this.sdkSessionId,
        project: this.project
      });
    } else if (summary && !this.sdkSessionId) {
      console.error('[claude-mem worker] Summary parsed but cannot store - no SDK session ID', {
        sessionDbId: this.sessionDbId
      });
    } else {
      console.error('[claude-mem worker] No summary found in response', {
        sessionDbId: this.sessionDbId,
        sdkSessionId: this.sdkSessionId
      });
    }
  }

  /**
   * Cleanup socket server and socket file
   */
  private cleanup(): void {
    console.error('[claude-mem worker] Cleaning up worker resources', {
      sessionDbId: this.sessionDbId,
      socketPath: this.socketPath,
      hasServer: !!this.server,
      socketExists: existsSync(this.socketPath)
    });

    if (this.server) {
      this.server.close();
    }
    if (existsSync(this.socketPath)) {
      unlinkSync(this.socketPath);
    }

    console.error('[claude-mem worker] Cleanup complete', {
      sessionDbId: this.sessionDbId
    });
  }

  /**
   * Sleep helper
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Run if executed directly
if (import.meta.main) {
  main().catch((error) => {
    console.error('[SDK Worker] Fatal error:', error);
    process.exit(1);
  });
}
