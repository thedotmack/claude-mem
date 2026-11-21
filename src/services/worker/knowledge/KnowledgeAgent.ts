
import { CorpusStore } from './CorpusStore.js';
import { CorpusRenderer } from './CorpusRenderer.js';
import type { CorpusFile, KnowledgeAgentCallOptions, QueryResult } from './types.js';
import { logger } from '../../../utils/logger.js';
import { SettingsDefaultsManager } from '../../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../../shared/paths.js';
import { buildIsolatedEnvWithFreshOAuth } from '../../../shared/EnvManager.js';
import { findClaudeExecutable, isClaudeExecutableUnspawnable } from '../../../shared/find-claude-executable.js';
import { sanitizeEnv } from '../../../supervisor/env-sanitizer.js';
import { resolveTierAlias } from '../model-aliases.js';
import { AppError } from '../../server/ErrorHandler.js';
import { isAuthFailureObserverOutput, isOrgDisabledSubscriptionObserverOutput } from '../../../sdk/output-classifier.js';

// @ts-ignore - Agent SDK types may not be available
import { query } from '@anthropic-ai/claude-agent-sdk';
import { buildHardenedSdkOptions } from '../../../sdk/hardened-options.js';

/**
 * The exact line the Claude Code CLI prints when `--resume <id>` names a
 * session it has no transcript for. In stream-json mode it arrives first as the
 * `errors` entry of an `error_during_execution` result, which
 * `errorFromUnsuccessfulResult` keeps in its message; the Agent SDK can also
 * repeat it inside `Claude Code process exited with code N. stderr: <tail>`
 * (sdk.mjs `formatStderrTail`). The line itself lives in the CLI binary
 * (@anthropic-ai/claude-agent-sdk-darwin-arm64/claude, SDK 0.3.289).
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

/**
 * The error for a terminal SDK result that did not succeed, carrying the
 * result's own text: `errors` on the error subtypes, `result` on an `is_error`
 * success (an API error). The SDK builds its "Claude Code returned an error
 * result" error the same way (sdk.mjs). Keeping that text is what lets
 * `isSessionResumeError` see an expired session, so `query` still reprimes.
 */
function errorFromUnsuccessfulResult(
  action: 'prime' | 'query',
  resultMessage: { subtype?: string; result?: unknown; errors?: unknown }
): Error {
  const details = resultMessage.subtype === 'success'
    ? (typeof resultMessage.result === 'string' ? resultMessage.result.trim() : '')
    : (Array.isArray(resultMessage.errors)
      ? resultMessage.errors.map((entry) => String(entry).trim()).filter(Boolean).join('; ')
      : '');
  if (isAuthFailureObserverOutput(details)) {
    // A signed-out CLI or a refused key is the user's setup state, not a worker
    // fault: a 4xx keeps it out of the error sink and tells the caller what to fix.
    const remedy = isOrgDisabledSubscriptionObserverOutput(details) ? '' : ' Run /login in Claude Code, then retry.';
    return new AppError(`Knowledge ${action} failed: Claude Code is not authenticated (${details}).${remedy}`, 401, 'CLAUDE_NOT_AUTHENTICATED');
  }
  return new Error(`Knowledge ${action} failed (${resultMessage.subtype})${details ? `: ${details}` : ''}`);
}

/**
 * `findClaudeExecutable`, with its setup failures (no CLI, every CLI too old,
 * a bad CLAUDE_CODE_PATH, the desktop app) as a 424 `AppError`. The user must
 * fix their machine, so the route logs a warning and does not send the error
 * to error tracking. An unspawnable CLI stays a server fault: only a worker
 * restart fixes it.
 */
async function findClaudeExecutableForKnowledge(): Promise<string> {
  try {
    return await findClaudeExecutable('WORKER');
  } catch (error) {
    if (isClaudeExecutableUnspawnable(error) || !(error instanceof Error)) throw error;
    throw new AppError(error.message, 424, 'CLAUDE_CLI_SETUP_REQUIRED');
  }
}

/** Per-call options. `abortController` is passed to the Agent SDK's `Options.abortController` (sdk.d.ts). */
export type { KnowledgeAgentCallOptions } from './types.js';

/** Max silence between Agent SDK messages before a knowledge call is aborted as stalled. */
export const DEFAULT_KNOWLEDGE_STREAM_IDLE_TIMEOUT_MS = 120_000;

/** Hard wall-clock ceiling for an entire knowledge prime() or query() (including auto-reprime). */
export const DEFAULT_KNOWLEDGE_ABSOLUTE_CAP_MS = 10 * 60_000;

export interface KnowledgeAgentOptions {
  /** Max silence between SDK messages before aborting the stream and failing with 504. */
  streamIdleTimeoutMs?: number;
  /** Hard wall-clock ceiling for an entire prime() or query() (including auto-reprime). */
  absoluteCapMs?: number;
}

function createKnowledgeTimeoutError(action: 'prime' | 'query', corpusName: string, detail: string): AppError {
  const code = action === 'prime' ? 'KNOWLEDGE_PRIME_TIMEOUT' : 'KNOWLEDGE_QUERY_TIMEOUT';
  return new AppError(`Knowledge ${action} timed out for corpus "${corpusName}" (${detail})`, 504, code);
}

function isKnowledgeTimeoutError(error: unknown): boolean {
  return error instanceof AppError && error.statusCode === 504;
}

interface BoundedStreamOptions {
  action: 'prime' | 'query';
  corpusName: string;
  sdkAbortController: AbortController;
  callerSignal?: AbortSignal;
  idleTimeoutMs: number;
  deadlineAt: number;
}

/**
 * Consume an Agent SDK async iterable under both an idle watchdog (reset on
 * every message) and an absolute wall-clock deadline. On timeout or caller
 * abort, aborts `sdkAbortController` so the SDK terminates its Claude CLI
 * child process and settles immediately even if the iterator never yields.
 */
async function consumeBoundedSdkStream(
  stream: AsyncIterable<any>,
  options: BoundedStreamOptions,
  onMessage: (msg: any) => void
): Promise<void> {
  const { action, corpusName, sdkAbortController, callerSignal, idleTimeoutMs, deadlineAt } = options;

  callerSignal?.throwIfAborted();
  const remainingCapMs = deadlineAt - Date.now();
  if (remainingCapMs <= 0) {
    const expired = createKnowledgeTimeoutError(action, corpusName, 'exceeded deadline');
    sdkAbortController.abort(expired);
    throw expired;
  }

  let disposed = false;
  let timeoutError: AppError | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let capTimer: ReturnType<typeof setTimeout> | null = null;
  let rejectAbort!: (reason: unknown) => void;

  const abortPromise = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  // Prevent an unhandled rejection if the stream finishes or throws before abortPromise is awaited.
  abortPromise.catch(() => {});

  const clearIdleTimer = (): void => {
    if (idleTimer !== null) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };

  const tripTimeout = (detail: string): void => {
    if (disposed || timeoutError) return;
    disposed = true;
    clearIdleTimer();
    if (capTimer !== null) {
      clearTimeout(capTimer);
      capTimer = null;
    }
    timeoutError = createKnowledgeTimeoutError(action, corpusName, detail);
    if (!sdkAbortController.signal.aborted) {
      sdkAbortController.abort(timeoutError);
    }
    rejectAbort(timeoutError);
  };

  const onCallerAbort = (): void => {
    if (disposed) return;
    disposed = true;
    clearIdleTimer();
    if (capTimer !== null) {
      clearTimeout(capTimer);
      capTimer = null;
    }
    const reason = callerSignal?.reason ?? new Error(`Knowledge ${action} aborted`);
    if (!sdkAbortController.signal.aborted) {
      sdkAbortController.abort(reason);
    }
    rejectAbort(reason);
  };

  const armIdleTimer = (): void => {
    if (disposed) return;
    clearIdleTimer();
    idleTimer = setTimeout(() => tripTimeout(`no SDK message for ${idleTimeoutMs}ms`), idleTimeoutMs);
  };

  callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
  // Watch the combined signal as well in case callerSignal aborted between the check and addEventListener.
  const combinedSignal = callerSignal
    ? AbortSignal.any([callerSignal, sdkAbortController.signal])
    : sdkAbortController.signal;
  if (combinedSignal.aborted) {
    onCallerAbort();
  }

  capTimer = setTimeout(() => tripTimeout(`exceeded ${remainingCapMs}ms deadline`), remainingCapMs);

  const iterator = stream[Symbol.asyncIterator]();
  let iteratorDone = false;
  try {
    while (true) {
      armIdleTimer();
      const nextPromise = iterator.next();
      // Prevent an unhandled rejection if a stalled iterator rejects after we already timed out or aborted.
      nextPromise.catch(() => {});
      const step = await Promise.race([nextPromise, abortPromise]);
      clearIdleTimer();
      if (step.done) {
        iteratorDone = true;
        break;
      }
      onMessage(step.value);
    }
  } catch (error) {
    if (timeoutError) throw timeoutError;
    throw error;
  } finally {
    disposed = true;
    clearIdleTimer();
    if (capTimer !== null) {
      clearTimeout(capTimer);
      capTimer = null;
    }
    callerSignal?.removeEventListener('abort', onCallerAbort);
    if (!iteratorDone && typeof iterator.return === 'function') {
      // Release generator resources without blocking on a stuck iterator.
      void Promise.resolve(iterator.return()).catch(() => {});
    }
  }
}

export class KnowledgeAgent {
  private renderer: CorpusRenderer;
  private readonly streamIdleTimeoutMs: number;
  private readonly absoluteCapMs: number;

  constructor(
    private corpusStore: CorpusStore,
    options: KnowledgeAgentOptions = {}
  ) {
    this.renderer = new CorpusRenderer();
    this.streamIdleTimeoutMs = options.streamIdleTimeoutMs ?? DEFAULT_KNOWLEDGE_STREAM_IDLE_TIMEOUT_MS;
    this.absoluteCapMs = options.absoluteCapMs ?? DEFAULT_KNOWLEDGE_ABSOLUTE_CAP_MS;
  }

  async prime(corpus: CorpusFile, callOptions: KnowledgeAgentCallOptions = {}): Promise<string> {
    return this.primeWithDeadline(corpus, callOptions, Date.now() + this.absoluteCapMs);
  }

  private async primeWithDeadline(
    corpus: CorpusFile,
    callOptions: KnowledgeAgentCallOptions,
    deadlineAt: number
  ): Promise<string> {
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

    callOptions.abortController?.signal.throwIfAborted();
    if (deadlineAt - Date.now() <= 0) {
      throw createKnowledgeTimeoutError('prime', corpus.name, 'exceeded deadline');
    }

    const claudePath = await findClaudeExecutableForKnowledge();
    const isolatedEnv = sanitizeEnv(await buildIsolatedEnvWithFreshOAuth());

    callOptions.abortController?.signal.throwIfAborted();
    const sdkAbortController = new AbortController();

    const queryResult = query({
      prompt: primePrompt,
      options: buildHardenedSdkOptions({
        source: 'KnowledgeAgent',
        project: corpus.name,
        model: this.getModelId(),
        env: isolatedEnv,
        pathToClaudeCodeExecutable: claudePath,
        abortController: sdkAbortController,
      }),
    });

    let sessionId: string | undefined;
    let successfulResult = false;
    try {
      await consumeBoundedSdkStream(
        queryResult,
        {
          action: 'prime',
          corpusName: corpus.name,
          sdkAbortController,
          callerSignal: callOptions.abortController?.signal,
          idleTimeoutMs: this.streamIdleTimeoutMs,
          deadlineAt,
        },
        (msg) => {
          if (msg.session_id) sessionId = msg.session_id;
          if (msg.type === 'result') {
            successfulResult = msg.is_error !== true && msg.subtype === 'success';
            if (!successfulResult) throw errorFromUnsuccessfulResult('prime', msg);
            logger.info('WORKER', `Knowledge agent primed for corpus "${corpus.name}"`);
          }
        }
      );
    } catch (error) {
      if (callOptions.abortController?.signal.aborted || isKnowledgeTimeoutError(error)) throw error;
      if (sessionId && successfulResult) {
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

    if (!successfulResult) {
      throw new Error(`Knowledge prime ended without a successful result for corpus "${corpus.name}"`);
    }
    if (!sessionId) {
      throw new Error(`Failed to capture session_id while priming corpus "${corpus.name}"`);
    }

    corpus.session_id = sessionId;
    this.corpusStore.write(corpus);

    return sessionId;
  }

  async query(corpus: CorpusFile, question: string, callOptions: KnowledgeAgentCallOptions = {}): Promise<QueryResult> {
    if (!corpus.session_id) {
      throw new AppError(`Corpus "${corpus.name}" has no session — call prime first`, 409, 'CORPUS_NOT_PRIMED');
    }

    const deadlineAt = Date.now() + this.absoluteCapMs;

    try {
      const result = await this.executeQuery(corpus, question, callOptions, deadlineAt);
      // The SDK may end quietly after cancellation, including after a success
      // result. Check at the commit boundary before changing the saved session.
      callOptions.abortController?.signal.throwIfAborted();
      if (result.session_id !== corpus.session_id) {
        corpus.session_id = result.session_id;
        this.corpusStore.write(corpus);
      }
      return result;
    } catch (error) {
      // The caller walked away; the route logs that once. Not a query failure.
      if (callOptions.abortController?.signal.aborted) throw error;
      if (!isSessionResumeError(error)) {
        if (error instanceof AppError && error.statusCode < 500) {
          logger.warn('WORKER', `Query rejected for corpus "${corpus.name}"`, {}, error);
        } else if (error instanceof Error) {
          logger.error('WORKER', `Query failed for corpus "${corpus.name}"`, {}, error);
        } else {
          logger.error('WORKER', `Query failed for corpus "${corpus.name}" (non-Error thrown)`, { thrownValue: String(error) });
        }
        throw error;
      }
      logger.info('WORKER', `Session expired for corpus "${corpus.name}", auto-repriming...`);
      await this.primeWithDeadline(corpus, callOptions, deadlineAt);
      const refreshedCorpus = this.corpusStore.read(corpus.name);
      if (!refreshedCorpus || !refreshedCorpus.session_id) {
        throw new Error(`Auto-reprime failed for corpus "${corpus.name}"`);
      }
      const result = await this.executeQuery(refreshedCorpus, question, callOptions, deadlineAt);
      callOptions.abortController?.signal.throwIfAborted();
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

  private async executeQuery(
    corpus: CorpusFile,
    question: string,
    callOptions: KnowledgeAgentCallOptions,
    deadlineAt: number
  ): Promise<QueryResult> {
    callOptions.abortController?.signal.throwIfAborted();
    if (deadlineAt - Date.now() <= 0) {
      throw createKnowledgeTimeoutError('query', corpus.name, 'exceeded deadline');
    }

    const claudePath = await findClaudeExecutableForKnowledge();
    const isolatedEnv = sanitizeEnv(await buildIsolatedEnvWithFreshOAuth());

    callOptions.abortController?.signal.throwIfAborted();
    const sdkAbortController = new AbortController();

    const queryResult = query({
      prompt: question,
      options: buildHardenedSdkOptions({
        source: 'KnowledgeAgent',
        project: corpus.name,
        model: this.getModelId(),
        env: isolatedEnv,
        pathToClaudeCodeExecutable: claudePath,
        resume: corpus.session_id!,
        abortController: sdkAbortController,
      }),
    });

    let answer = '';
    let newSessionId = corpus.session_id!;
    let successfulResult = false;
    try {
      await consumeBoundedSdkStream(
        queryResult,
        {
          action: 'query',
          corpusName: corpus.name,
          sdkAbortController,
          callerSignal: callOptions.abortController?.signal,
          idleTimeoutMs: this.streamIdleTimeoutMs,
          deadlineAt,
        },
        (msg) => {
          if (msg.session_id) newSessionId = msg.session_id;
          if (msg.type === 'result') {
            successfulResult = msg.is_error !== true && msg.subtype === 'success';
            if (!successfulResult) throw errorFromUnsuccessfulResult('query', msg);
          }
          if (msg.type === 'assistant') {
            const text = msg.message.content
              .filter((b: any) => b.type === 'text')
              .map((b: any) => b.text)
              .join('');
            // The SDK emits one assistant message per completed content block.
            // Later text extends the answer; non-text blocks do not erase it.
            answer += text;
          }
        }
      );
    } catch (error) {
      if (callOptions.abortController?.signal.aborted || isKnowledgeTimeoutError(error)) throw error;
      if (answer && successfulResult) {
        if (error instanceof Error) {
          logger.debug('WORKER', `SDK process exited after query — answer captured, continuing`, {}, error);
        } else {
          logger.debug('WORKER', `SDK process exited after query — answer captured, continuing (non-Error thrown)`, { thrownValue: String(error) });
        }
      } else {
        throw error;
      }
    }

    if (!successfulResult) {
      throw new Error(`Knowledge query ended without a successful result for corpus "${corpus.name}"`);
    }
    return { answer, session_id: newSessionId };
  }

  private getModelId(): string {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    // Resolve $TIER:<fast|smart|simple|summary> aliases at request time (#2289).
    return resolveTierAlias(settings.CLAUDE_MEM_MODEL, settings);
  }

}
