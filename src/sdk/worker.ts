#!/usr/bin/env bun
/**
 * SDK Worker Process
 * Background server that processes tool observations via Unix socket
 */

import net from 'net';
import { unlinkSync, existsSync } from 'fs';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { HooksDatabase } from '../services/sqlite/HooksDatabase.js';
import { getWorkerSocketPath } from '../shared/paths.js';
import { buildInitPrompt, buildObservationPrompt, buildFinalizePrompt } from './prompts.js';
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
  private db: HooksDatabase;
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
    this.db = new HooksDatabase();
    this.abortController = new AbortController();
    this.socketPath = getWorkerSocketPath(sessionDbId);
  }

  /**
   * Main run loop
   */
  async run(): Promise<void> {
    try {
      // Load session info
      const session = await this.loadSession();
      if (!session) {
        console.error('[SDK Worker] Session not found');
        process.exit(1);
      }

      this.project = session.project;
      this.userPrompt = session.user_prompt;

      // Start Unix socket server
      await this.startSocketServer();
      console.error(`[SDK Worker] Socket server listening: ${this.socketPath}`);

      // Run SDK agent with streaming input
      await this.runSDKAgent();

      // Mark session as completed
      this.db.markSessionCompleted(this.sessionDbId);
      this.db.close();
      this.cleanup();

    } catch (error: any) {
      console.error('[SDK Worker] Error:', error.message);
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
        let buffer = '';

        socket.on('data', (chunk) => {
          buffer += chunk.toString();

          // Try to parse complete JSON messages (separated by newlines)
          const lines = buffer.split('\n');
          buffer = lines.pop() || ''; // Keep incomplete line in buffer

          for (const line of lines) {
            if (line.trim()) {
              try {
                const message: WorkerMessage = JSON.parse(line);
                this.handleMessage(message);
              } catch (err) {
                console.error('[SDK Worker] Invalid message:', line);
              }
            }
          }
        });

        socket.on('error', (err) => {
          console.error('[SDK Worker] Socket connection error:', err.message);
        });
      });

      this.server.on('error', (err: any) => {
        if (err.code === 'EADDRINUSE') {
          console.error(`[SDK Worker] Socket already in use: ${this.socketPath}`);
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
    this.pendingMessages.push(message);

    if (message.type === 'finalize') {
      this.isFinalized = true;
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

    await query({
      prompt: this.createMessageGenerator(),
      options: {
        model: MODEL,
        disallowedTools: DISALLOWED_TOOLS,
        abortController: this.abortController,
        pathToClaudeCodeExecutable: claudePath,
        onSystemInitMessage: (msg) => {
          // Capture SDK session ID from init message
          if (msg.session_id) {
            this.sdkSessionId = msg.session_id;
            this.db.updateSDKSessionId(this.sessionDbId, msg.session_id);
          }
        },
        onAgentMessage: (msg) => {
          // Parse and store observations from agent response
          this.handleAgentMessage(msg.content);
        }
      }
    });
  }

  /**
   * Create async message generator for SDK streaming input
   * Now pulls from socket messages instead of polling database
   */
  private async* createMessageGenerator(): AsyncIterable<{ type: 'user'; message: { role: 'user'; content: string } }> {
    // Yield initial prompt
    const claudeSessionId = `session-${this.sessionDbId}`;
    const initPrompt = buildInitPrompt(this.project, claudeSessionId, this.userPrompt);
    yield {
      type: 'user',
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
          this.isFinalized = true;
          const session = await this.loadSession();
          if (session) {
            const finalizePrompt = buildFinalizePrompt(session);
            yield {
              type: 'user',
              message: {
                role: 'user',
                content: finalizePrompt
              }
            };
          }
          break;
        }

        if (message.type === 'observation') {
          // Build observation prompt
          const observationPrompt = buildObservationPrompt({
            tool_name: message.tool_name,
            tool_input: message.tool_input,
            tool_output: message.tool_output
          });
          yield {
            type: 'user',
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
    // Parse observations
    const observations = parseObservations(content);
    for (const obs of observations) {
      if (this.sdkSessionId) {
        this.db.storeObservation(this.sdkSessionId, this.project, obs.type, obs.text);
      }
    }

    // Parse summary (if present)
    const summary = parseSummary(content);
    if (summary && this.sdkSessionId) {
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

      this.db.storeSummary(this.sdkSessionId, this.project, summaryWithArrays);
    }
  }

  /**
   * Cleanup socket server and socket file
   */
  private cleanup(): void {
    if (this.server) {
      this.server.close();
    }
    if (existsSync(this.socketPath)) {
      unlinkSync(this.socketPath);
    }
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
