#!/usr/bin/env bun
/**
 * SDK Worker Process
 * Background agent that processes tool observations and generates session summaries
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import { HooksDatabase } from '../services/sqlite/HooksDatabase.js';
import { buildInitPrompt, buildObservationPrompt, buildFinalizePrompt } from './prompts.js';
import { parseObservations, parseSummary } from './parser.js';
import type { Observation, SDKSession } from './prompts.js';

const POLL_INTERVAL_MS = 1000; // 1 second
const MODEL = 'claude-sonnet-4-5';
const DISALLOWED_TOOLS = ['Glob', 'Grep', 'ListMcpResourcesTool', 'WebSearch'];

/**
 * Main worker process entry point
 */
async function main() {
  const sessionDbId = parseInt(process.argv[2], 10);

  if (!sessionDbId) {
    console.error('[SDK Worker] Missing session ID argument');
    process.exit(1);
  }

  const worker = new SDKWorker(sessionDbId);
  await worker.run();
}

/**
 * SDK Worker class - handles the full lifecycle of observation processing
 */
class SDKWorker {
  private sessionDbId: number;
  private db: HooksDatabase;
  private sdkSessionId: string | null = null;
  private project: string = '';
  private userPrompt: string = '';
  private abortController: AbortController;
  private isFinalized = false;

  constructor(sessionDbId: number) {
    this.sessionDbId = sessionDbId;
    this.db = new HooksDatabase();
    this.abortController = new AbortController();
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

      // Run SDK agent with streaming input
      await this.runSDKAgent();

      // Mark session as completed
      this.db.markSessionCompleted(this.sessionDbId);
      this.db.close();

    } catch (error: any) {
      console.error('[SDK Worker] Error:', error.message);
      this.db.markSessionFailed(this.sessionDbId);
      this.db.close();
      process.exit(1);
    }
  }

  /**
   * Load session from database
   */
  private async loadSession(): Promise<SDKSession | null> {
    // Query session by ID
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
    const messageGenerator = this.createMessageGenerator();

    await query({
      model: MODEL,
      messages: messageGenerator,
      disallowedTools: DISALLOWED_TOOLS,
      signal: this.abortController.signal,
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
    });
  }

  /**
   * Create async message generator for SDK streaming input
   */
  private async* createMessageGenerator(): AsyncIterable<{ role: 'user'; content: string }> {
    // Yield initial prompt
    const claudeSessionId = `session-${this.sessionDbId}`;
    const initPrompt = buildInitPrompt(this.project, claudeSessionId, this.userPrompt);
    yield { role: 'user', content: initPrompt };

    // Poll observation queue
    while (!this.isFinalized) {
      await this.sleep(POLL_INTERVAL_MS);

      if (!this.sdkSessionId) {
        continue; // Wait for SDK session ID to be captured
      }

      // Get pending observations
      const observations = this.db.getPendingObservations(this.sdkSessionId, 10);

      for (const obs of observations) {
        // Check for FINALIZE message
        if (this.isFinalizationMessage(obs)) {
          this.isFinalized = true;
          const session = await this.loadSession();
          if (session) {
            const finalizePrompt = buildFinalizePrompt(session);
            yield { role: 'user', content: finalizePrompt };
          }
          this.db.markObservationProcessed(obs.id);
          break;
        }

        // Send observation to SDK
        const observationPrompt = buildObservationPrompt(obs);
        yield { role: 'user', content: observationPrompt };

        // Mark as processed
        this.db.markObservationProcessed(obs.id);
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
   * Check if observation is a FINALIZE message
   */
  private isFinalizationMessage(obs: Observation): boolean {
    return obs.tool_name === 'FINALIZE';
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
