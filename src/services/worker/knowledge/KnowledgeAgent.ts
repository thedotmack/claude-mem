/**
 * KnowledgeAgent - Manages Agent SDK sessions for knowledge corpora
 *
 * Uses the V1 Agent SDK query() API to:
 * 1. Prime a session with a full corpus (all observations loaded into context)
 * 2. Query the primed session with follow-up questions (via session resume)
 * 3. Reprime to create a fresh session (clears accumulated Q&A context)
 *
 * Knowledge agents are Q&A only - all 12 tools are blocked.
 */

import { execSync } from 'child_process';
import { CorpusStore } from './CorpusStore.js';
import { CorpusRenderer } from './CorpusRenderer.js';
import type { CorpusFile, QueryResult } from './types.js';
import { logger } from '../../../utils/logger.js';
import { SettingsDefaultsManager } from '../../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH, OBSERVER_SESSIONS_DIR, ensureDir } from '../../../shared/paths.js';
import { buildIsolatedEnv } from '../../../shared/EnvManager.js';
import { sanitizeEnv } from '../../../supervisor/env-sanitizer.js';

// Import Agent SDK (V1 API — same pattern as SDKAgent.ts)
// @ts-ignore - Agent SDK types may not be available
import { query } from '@anthropic-ai/claude-agent-sdk';

// Knowledge agent is Q&A only — all 12 tools blocked
// Copied from SDKAgent.ts:55-67
const KNOWLEDGE_AGENT_DISALLOWED_TOOLS = [
  'Bash',           // Prevent infinite loops
  'Read',           // No file reading
  'Write',          // No file writing
  'Edit',           // No file editing
  'Grep',           // No code searching
  'Glob',           // No file pattern matching
  'WebFetch',       // No web fetching
  'WebSearch',      // No web searching
  'Task',           // No spawning sub-agents
  'NotebookEdit',   // No notebook editing
  'AskUserQuestion',// No asking questions
  'TodoWrite'       // No todo management
];

export class KnowledgeAgent {
  private renderer: CorpusRenderer;

  constructor(
    private corpusStore: CorpusStore
  ) {
    this.renderer = new CorpusRenderer();
  }

  /**
   * Prime a knowledge agent session by sending the full corpus as context.
   * Creates a new SDK session, feeds it all observations, and stores the session_id.
   *
   * @returns The session_id for future resume queries
   */
  async prime(corpus: CorpusFile): Promise<string> {
    const renderedCorpus = this.renderer.renderCorpus(corpus);

    const primePrompt = [
      corpus.system_prompt,
      '',
      'Here is your complete knowledge base:',
      '',
      renderedCorpus,
      '',
      'Acknowledge what you\'ve received. Summarize the key themes and topics you can answer questions about.'
    ].join('\n');

    ensureDir(OBSERVER_SESSIONS_DIR);
    const claudePath = this.findClaudeExecutable();
    const isolatedEnv = sanitizeEnv(buildIsolatedEnv());

    const queryResult = query({
      prompt: primePrompt,
      options: {
        model: this.getModelId(),
        cwd: OBSERVER_SESSIONS_DIR,
        disallowedTools: KNOWLEDGE_AGENT_DISALLOWED_TOOLS,
        pathToClaudeCodeExecutable: claudePath,
        env: isolatedEnv,
        mcpServers: {},
        // Same SDK-boundary isolation as SDKAgent. Closes #2155, #2159, #2171, #2194.
        settingSources: [],
        strictMcpConfig: true,
      }
    });

    let sessionId: string | undefined;
    try {
      for await (const msg of queryResult) {
        if (msg.session_id) sessionId = msg.session_id;
        if (msg.type === 'result') {
          logger.info('WORKER', `Knowledge agent primed for corpus "${corpus.name}"`);
        }
      }
    } catch (error) {
      // The SDK may throw after yielding all messages when the Claude process
      // exits with a non-zero code. If we already captured a session_id,
      // treat this as success — the session was created and primed.
      if (sessionId) {
        if (error instanceof Error) {
          logger.debug('WORKER', `SDK process exited after priming corpus "${corpus.name}" — session captured, continuing`, {}, error);
        } else {
          logger.debug('WORKER', `SDK process exited after priming corpus "${corpus.name}" — session captured, continuing (non-Error thrown)`, { thrownValue: String(error) });
        }
      } else {
        throw error;
      }
    }

    if (!sessionId) {
      throw new Error(`Failed to capture session_id while priming corpus "${corpus.name}"`);
    }

    corpus.session_id = sessionId;
    this.corpusStore.write(corpus);

    return sessionId;
  }

  /**
   * Query a primed knowledge agent by resuming its session.
   * The agent answers from the corpus context loaded during prime().
   *
   * If the session has expired, auto-reprimes and retries the query.
   */
  async query(corpus: CorpusFile, question: string): Promise<QueryResult> {
    if (!corpus.session_id) {
      throw new Error(`Corpus "${corpus.name}" has no session — call prime first`);
    }

    try {
      const result = await this.executeQuery(corpus, question);
      if (result.session_id !== corpus.session_id) {
        corpus.session_id = result.session_id;
        this.corpusStore.write(corpus);
      }
      return result;
    } catch (error) {
      if (!this.isSessionResumeError(error)) {
        if (error instanceof Error) {
          logger.error('WORKER', `Query failed for corpus "${corpus.name}"`, {}, error);
        } else {
          logger.error('WORKER', `Query failed for corpus "${corpus.name}" (non-Error thrown)`, { thrownValue: String(error) });
        }
        throw error;
      }
      // Session expired or invalid — auto-reprime and retry
      logger.info('WORKER', `Session expired for corpus "${corpus.name}", auto-repriming...`);
      await this.prime(corpus);
      // Re-read corpus to get the new session_id written by prime()
      const refreshedCorpus = this.corpusStore.read(corpus.name);
      if (!refreshedCorpus || !refreshedCorpus.session_id) {
        throw new Error(`Auto-reprime failed for corpus "${corpus.name}"`);
      }
      const result = await this.executeQuery(refreshedCorpus, question);
      if (result.session_id !== refreshedCorpus.session_id) {
        refreshedCorpus.session_id = result.session_id;
        this.corpusStore.write(refreshedCorpus);
      }
      return result;
    }
  }

  /**
   * Reprime a corpus — creates a fresh session, clearing prior Q&A context.
   *
   * @returns The new session_id
   */
  async reprime(corpus: CorpusFile): Promise<string> {
    corpus.session_id = null;  // Clear old session
    return this.prime(corpus);
  }

  /**
   * Detect whether an error indicates an expired or invalid session resume.
   * Only these errors trigger auto-reprime; all others are rethrown.
   */
  private isSessionResumeError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /session|resume|expired|invalid.*session|not found/i.test(message);
  }

  /**
   * Execute a single query against a primed session via V1 SDK resume.
   */
  private async executeQuery(corpus: CorpusFile, question: string): Promise<QueryResult> {
    ensureDir(OBSERVER_SESSIONS_DIR);
    const claudePath = this.findClaudeExecutable();
    const isolatedEnv = sanitizeEnv(buildIsolatedEnv());

    const queryResult = query({
      prompt: question,
      options: {
        model: this.getModelId(),
        resume: corpus.session_id!,
        cwd: OBSERVER_SESSIONS_DIR,
        disallowedTools: KNOWLEDGE_AGENT_DISALLOWED_TOOLS,
        pathToClaudeCodeExecutable: claudePath,
        env: isolatedEnv,
        mcpServers: {},
        // Same SDK-boundary isolation as SDKAgent. Closes #2155, #2159, #2171, #2194.
        settingSources: [],
        strictMcpConfig: true,
      }
    });

    let answer = '';
    let newSessionId = corpus.session_id!;
    try {
      for await (const msg of queryResult) {
        if (msg.session_id) newSessionId = msg.session_id;
        if (msg.type === 'assistant') {
          const text = msg.message.content
            .filter((b: any) => b.type === 'text')
            .map((b: any) => b.text)
            .join('');
          answer = text;
        }
      }
    } catch (error) {
      // Same as prime() — SDK may throw after all messages are yielded.
      // If we captured an answer, treat as success.
      if (answer) {
        if (error instanceof Error) {
          logger.debug('WORKER', `SDK process exited after query — answer captured, continuing`, {}, error);
        } else {
          logger.debug('WORKER', `SDK process exited after query — answer captured, continuing (non-Error thrown)`, { thrownValue: String(error) });
        }
      } else {
        throw error;
      }
    }

    return { answer, session_id: newSessionId };
  }

  /**
   * Get model ID from user settings — same as SDKAgent.getModelId()
   */
  private getModelId(): string {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    return settings.CLAUDE_MEM_MODEL;
  }

  /**
   * Find the Claude executable path.
   * Mirrors SDKAgent.findClaudeExecutable() logic.
   */
  private findClaudeExecutable(): string {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);

    // 1. Check configured path
    if (settings.CLAUDE_CODE_PATH) {
      const { existsSync } = require('fs');
      if (!existsSync(settings.CLAUDE_CODE_PATH)) {
        throw new Error(`CLAUDE_CODE_PATH is set to "${settings.CLAUDE_CODE_PATH}" but the file does not exist.`);
      }
      return settings.CLAUDE_CODE_PATH;
    }

    // 2. On Windows, prefer "claude.cmd" via PATH
    if (process.platform === 'win32') {
      try {
        execSync('where claude.cmd', { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
        return 'claude.cmd';
      } catch {
        // Fall through to generic detection
      }
    }

    // 3. Auto-detection
    try {
      const claudePath = execSync(
        process.platform === 'win32' ? 'where claude' : 'which claude',
        { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }
      ).trim().split('\n')[0].trim();

      if (claudePath) return claudePath;
    } catch (error) {
      if (error instanceof Error) {
        logger.debug('WORKER', 'Claude executable auto-detection failed', {}, error);
      } else {
        logger.debug('WORKER', 'Claude executable auto-detection failed (non-Error thrown)', { thrownValue: String(error) });
      }
    }

    throw new Error('Claude executable not found. Please either:\n1. Add "claude" to your system PATH, or\n2. Set CLAUDE_CODE_PATH in ~/.claude-mem/settings.json');
  }
}
