
import { CorpusStore } from './CorpusStore.js';
import { CorpusRenderer } from './CorpusRenderer.js';
import type { CorpusFile, QueryResult } from './types.js';
import { logger } from '../../../utils/logger.js';
import { SettingsDefaultsManager } from '../../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../../shared/paths.js';
import { buildIsolatedEnvWithFreshOAuth } from '../../../shared/EnvManager.js';
import { findClaudeExecutable } from '../../../shared/find-claude-executable.js';
import { sanitizeEnv } from '../../../supervisor/env-sanitizer.js';
import { resolveTierAlias } from '../model-aliases.js';

// @ts-ignore - Agent SDK types may not be available
import { query } from '@anthropic-ai/claude-agent-sdk';
import { buildHardenedSdkOptions } from '../../../sdk/hardened-options.js';

/**
 * The exact stderr line the Claude Code CLI prints when `--resume <id>` names a
 * session it has no transcript for. The Agent SDK surfaces it inside
 * `Claude Code process exited with code N. stderr: <tail>` (sdk.mjs
 * `formatStderrTail`); the line itself lives in the CLI binary
 * (@anthropic-ai/claude-agent-sdk-darwin-arm64/claude, SDK 0.3.288).
 */
const SDK_SESSION_RESUME_FAILURE_PATTERN = /No conversation found with session ID/;

/**
 * True only for the SDK's explicit "this session cannot be resumed" failure.
 * Anything else (auth, network, a generic "not found", an abort) must surface
 * as-is rather than silently paying for a fresh prime.
 */
export function isSessionResumeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return SDK_SESSION_RESUME_FAILURE_PATTERN.test(message);
}

/** Per-call options. `abortController` is passed to the Agent SDK's `Options.abortController` (sdk.d.ts). */
export interface KnowledgeAgentCallOptions {
  abortController?: AbortController;
}

export class KnowledgeAgent {
  private renderer: CorpusRenderer;

  constructor(
    private corpusStore: CorpusStore
  ) {
    this.renderer = new CorpusRenderer();
  }

  async prime(corpus: CorpusFile, callOptions: KnowledgeAgentCallOptions = {}): Promise<string> {
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

    const claudePath = findClaudeExecutable('WORKER');
    const isolatedEnv = sanitizeEnv(await buildIsolatedEnvWithFreshOAuth());

    const queryResult = query({
      prompt: primePrompt,
      options: buildHardenedSdkOptions({
        source: 'KnowledgeAgent',
        project: corpus.name,
        model: this.getModelId(),
        env: isolatedEnv,
        pathToClaudeCodeExecutable: claudePath,
        abortController: callOptions.abortController,
      }),
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
      if (callOptions.abortController?.signal.aborted) throw error;
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

    // Never persist a session whose prime the caller abandoned, even if the SDK ended quietly.
    callOptions.abortController?.signal.throwIfAborted();

    if (!sessionId) {
      throw new Error(`Failed to capture session_id while priming corpus "${corpus.name}"`);
    }

    corpus.session_id = sessionId;
    this.corpusStore.write(corpus);

    return sessionId;
  }

  async query(corpus: CorpusFile, question: string, callOptions: KnowledgeAgentCallOptions = {}): Promise<QueryResult> {
    if (!corpus.session_id) {
      throw new Error(`Corpus "${corpus.name}" has no session — call prime first`);
    }

    try {
      const result = await this.executeQuery(corpus, question, callOptions);
      if (result.session_id !== corpus.session_id) {
        corpus.session_id = result.session_id;
        this.corpusStore.write(corpus);
      }
      return result;
    } catch (error) {
      // The caller walked away; the route logs that once. Not a query failure.
      if (callOptions.abortController?.signal.aborted) throw error;
      if (!isSessionResumeError(error)) {
        if (error instanceof Error) {
          logger.error('WORKER', `Query failed for corpus "${corpus.name}"`, {}, error);
        } else {
          logger.error('WORKER', `Query failed for corpus "${corpus.name}" (non-Error thrown)`, { thrownValue: String(error) });
        }
        throw error;
      }
      logger.info('WORKER', `Session expired for corpus "${corpus.name}", auto-repriming...`);
      await this.prime(corpus, callOptions);
      const refreshedCorpus = this.corpusStore.read(corpus.name);
      if (!refreshedCorpus || !refreshedCorpus.session_id) {
        throw new Error(`Auto-reprime failed for corpus "${corpus.name}"`);
      }
      const result = await this.executeQuery(refreshedCorpus, question, callOptions);
      if (result.session_id !== refreshedCorpus.session_id) {
        refreshedCorpus.session_id = result.session_id;
        this.corpusStore.write(refreshedCorpus);
      }
      return result;
    }
  }

  async reprime(corpus: CorpusFile, callOptions: KnowledgeAgentCallOptions = {}): Promise<string> {
    corpus.session_id = null;
    return this.prime(corpus, callOptions);
  }

  private async executeQuery(corpus: CorpusFile, question: string, callOptions: KnowledgeAgentCallOptions): Promise<QueryResult> {
    const claudePath = findClaudeExecutable('WORKER');
    const isolatedEnv = sanitizeEnv(await buildIsolatedEnvWithFreshOAuth());

    const queryResult = query({
      prompt: question,
      options: buildHardenedSdkOptions({
        source: 'KnowledgeAgent',
        project: corpus.name,
        model: this.getModelId(),
        env: isolatedEnv,
        pathToClaudeCodeExecutable: claudePath,
        resume: corpus.session_id!,
        abortController: callOptions.abortController,
      }),
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
      if (callOptions.abortController?.signal.aborted) throw error;
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

  private getModelId(): string {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    // Resolve $TIER:<fast|smart|simple|summary> aliases at request time (#2289).
    return resolveTierAlias(settings.CLAUDE_MEM_MODEL, settings);
  }

}
