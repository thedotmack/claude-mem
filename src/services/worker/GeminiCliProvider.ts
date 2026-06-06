
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { DatabaseManager } from './DatabaseManager.js';
import { SessionManager } from './SessionManager.js';
import { logger } from '../../utils/logger.js';
import { buildInitPrompt, buildObservationPrompt, buildSummaryPrompt, buildContinuationPrompt } from '../../sdk/prompts.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { getCredential } from '../../shared/EnvManager.js';
import { GEMINI_CLI_SESSIONS_DIR, ensureDir, paths } from '../../shared/paths.js';
import type { ActiveSession } from '../worker-types.js';
import { ModeManager } from '../domain/ModeManager.js';
import { processAgentResponse, isAbortError, type WorkerRef } from './agents/index.js';
import { ClassifiedProviderError } from './provider-errors.js';
import { findGeminiExecutable, hasGeminiExecutable } from '../../shared/find-gemini-executable.js';

/**
 * GeminiCliProvider drives the user-installed `gemini` CLI (@google/gemini-cli)
 * as an observation-generation backend, the same role ClaudeProvider plays for
 * the Claude Agent SDK. Unlike GeminiProvider (which calls the Gemini REST API
 * and needs an API key), this provider piggybacks on the gemini CLI's existing
 * OAuth login — so users on the free/subscription tier need no API key.
 *
 * Each claude-mem session maps to one native gemini session: the first turn
 * starts a new CLI session and captures the returned `session_id`; every later
 * turn resumes it (`--resume <uuid>`), letting gemini hold the conversation
 * context (and reuse its prompt cache) across separate subprocess invocations.
 *
 * Hardening:
 *   - `--approval-mode plan`  → read-only; the model cannot run tools or write
 *     files, so generation has no side effects on disk.
 *   - `--skip-trust`          → required for headless runs in untrusted dirs.
 *   - `--output-format json`  → clean `{ session_id, response, stats }` on
 *     stdout (warnings go to stderr and are ignored).
 *   - prompt is piped via stdin (with `-p ""`) to sidestep ARG_MAX on large
 *     observation payloads.
 */

const DEFAULT_TIMEOUT_MS = 120_000;

interface GeminiCliJson {
  session_id?: string;
  response?: string;
  stats?: {
    models?: Record<string, { tokens?: { total?: number } }>;
  };
}

/** Sum total tokens across all models reported in the CLI stats block. */
function extractTokens(stats: GeminiCliJson['stats']): number {
  let total = 0;
  const models = stats?.models;
  if (models) {
    for (const m of Object.values(models)) {
      total += m?.tokens?.total ?? 0;
    }
  }
  return total;
}

/** True when a `--resume` failure means the session no longer exists. */
function isSessionNotFoundError(stderr: string): boolean {
  const lower = stderr.toLowerCase();
  return (
    lower.includes('no session') ||
    lower.includes('session not found') ||
    lower.includes('does not exist') ||
    lower.includes('could not find session') ||
    (lower.includes('session') && lower.includes('not found'))
  );
}

function buildGeminiCliEnv(): NodeJS.ProcessEnv {
  const savedGeminiApiKey = getCredential('GEMINI_API_KEY');
  if (!savedGeminiApiKey || process.env.GEMINI_API_KEY) return process.env;
  return { ...process.env, GEMINI_API_KEY: savedGeminiApiKey };
}

/**
 * Classify a gemini CLI failure into a ClassifiedProviderError so the worker's
 * retry/backoff logic treats it consistently with the other providers.
 */
export function classifyGeminiCliError(input: {
  exitCode: number | null;
  stderr: string;
  cause: unknown;
}): ClassifiedProviderError {
  const stderr = input.stderr ?? '';
  const lower = stderr.toLowerCase();

  // Spawn-level failures — unrecoverable.
  if (lower.includes('enoent') || lower.includes('not found: gemini') || lower.includes('command not found')) {
    return new ClassifiedProviderError(`Gemini CLI not found: ${stderr.slice(0, 200)}`, { kind: 'unrecoverable', cause: input.cause });
  }

  // Quota — RESOURCE_EXHAUSTED / "quota".
  if (lower.includes('quota') || lower.includes('resource_exhausted')) {
    return new ClassifiedProviderError('Gemini CLI quota exhausted', { kind: 'quota_exhausted', cause: input.cause });
  }

  // Rate limit.
  if (lower.includes('429') || lower.includes('rate limit') || lower.includes('too many requests')) {
    return new ClassifiedProviderError('Gemini CLI rate limited', { kind: 'rate_limit', cause: input.cause });
  }

  // Auth — invalid credentials / re-auth required.
  if (
    lower.includes('api key not valid') ||
    lower.includes('api_key_invalid') ||
    lower.includes('unauthenticated') ||
    lower.includes('permission_denied') ||
    lower.includes('please sign in') ||
    lower.includes('re-authenticate') ||
    lower.includes('login')
  ) {
    return new ClassifiedProviderError(`Gemini CLI auth error: ${stderr.slice(0, 200)}`, { kind: 'auth_invalid', cause: input.cause });
  }

  // Upstream 5xx / overloaded — transient.
  if (lower.includes('503') || lower.includes('500') || lower.includes('overloaded') || lower.includes('unavailable')) {
    return new ClassifiedProviderError(`Gemini CLI upstream error: ${stderr.slice(0, 200)}`, { kind: 'transient', cause: input.cause });
  }

  // Default: transient (preserves retry-everything behavior for unknowns).
  return new ClassifiedProviderError(
    `Gemini CLI error (exit ${input.exitCode}): ${stderr.slice(0, 200)}`,
    { kind: 'transient', cause: input.cause },
  );
}

interface RunOptions {
  executable: string;
  cwd: string;
  model: string;
  prompt: string;
  resumeId?: string;    // --resume (continue existing)
  signal: AbortSignal;
  timeoutMs: number;
}

interface RunResult {
  sessionId: string;
  response: string;
  tokensUsed: number;
}

/**
 * Spawn one headless gemini turn. Resolves with the parsed result, or rejects
 * with a ClassifiedProviderError (or an AbortError-named error on abort).
 */
function runGeminiCli(opts: RunOptions): Promise<RunResult> {
  return new Promise<RunResult>((resolve, reject) => {
    if (opts.signal.aborted) {
      reject(Object.assign(new Error('Gemini CLI aborted before spawn'), { name: 'AbortError' }));
      return;
    }

    const args: string[] = [];
    if (opts.resumeId) {
      args.push('--resume', opts.resumeId);
    }
    args.push(
      '--skip-trust',
      '--approval-mode', 'plan',
      '--output-format', 'json',
      '-m', opts.model,
      '-p', '',
    );

    const child = spawn(opts.executable, args, {
      cwd: opts.cwd,
      env: buildGeminiCliEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      opts.signal.removeEventListener('abort', onAbort);
    };
    const resolveOnce = (val: RunResult) => { if (!settled) { settled = true; cleanup(); resolve(val); } };
    const rejectOnce = (err: unknown) => { if (!settled) { settled = true; cleanup(); reject(err); } };

    const onAbort = () => {
      try { child.kill('SIGTERM'); } catch { /* best-effort */ }
      rejectOnce(Object.assign(new Error('Gemini CLI aborted'), { name: 'AbortError' }));
    };

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* best-effort */ }
      rejectOnce(classifyGeminiCliError({
        exitCode: null,
        stderr: `gemini CLI timed out after ${opts.timeoutMs}ms`,
        cause: new Error('gemini CLI timeout'),
      }));
    }, opts.timeoutMs);

    opts.signal.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('error', (err) => {
      rejectOnce(classifyGeminiCliError({ exitCode: null, stderr: err.message, cause: err }));
    });

    child.stdin.on('error', (err) => {
      rejectOnce(classifyGeminiCliError({ exitCode: null, stderr: err.message, cause: err }));
    });

    child.on('close', (code) => {
      if (code !== 0) {
        // A resume against a vanished session is recoverable by falling back to
        // a fresh init — surface that distinctly so runTurn can react.
        if (opts.resumeId && isSessionNotFoundError(stderr)) {
          rejectOnce(new ClassifiedProviderError('gemini session not found', { kind: 'session_not_found', cause: new Error(stderr.slice(0, 200)) }));
          return;
        }
        rejectOnce(classifyGeminiCliError({
          exitCode: code,
          stderr,
          cause: new Error(`gemini exited ${code}: ${stderr.slice(0, 500)}`),
        }));
        return;
      }

      // stdout is pure JSON, but slice from the first brace defensively in case
      // a stray line ever leaks onto stdout.
      const start = stdout.indexOf('{');
      const jsonText = start >= 0 ? stdout.slice(start) : stdout;
      let parsed: GeminiCliJson;
      try {
        parsed = JSON.parse(jsonText) as GeminiCliJson;
      } catch (e) {
        rejectOnce(classifyGeminiCliError({
          exitCode: code,
          stderr: `unparseable gemini JSON: ${stdout.slice(0, 300)}`,
          cause: e,
        }));
        return;
      }

      resolveOnce({
        sessionId: parsed.session_id ?? '',
        response: parsed.response ?? '',
        tokensUsed: extractTokens(parsed.stats),
      });
    });

    // Prompt is delivered on stdin; `-p ""` flips the CLI into headless mode.
    try {
      child.stdin.end(opts.prompt);
    } catch (err: unknown) {
      rejectOnce(classifyGeminiCliError({ exitCode: null, stderr: err instanceof Error ? err.message : String(err), cause: err }));
    }
  });
}

export class GeminiCliProvider {
  private dbManager: DatabaseManager;
  private sessionManager: SessionManager;

  constructor(dbManager: DatabaseManager, sessionManager: SessionManager) {
    this.dbManager = dbManager;
    this.sessionManager = sessionManager;
  }

  async startSession(session: ActiveSession, worker?: WorkerRef): Promise<void> {
    const executable = findGeminiExecutable('SDK');
    const { model } = this.getConfig();
    const cwd = GEMINI_CLI_SESSIONS_DIR;
    ensureDir(cwd);

    // forceInit (context overflow / crash recovery): abandon the old gemini
    // session and start a brand-new one.
    if (session.forceInit) {
      logger.info('SDK', 'forceInit set — starting fresh Gemini CLI session', {
        sessionDbId: session.sessionDbId,
        previousMemorySessionId: session.memorySessionId,
      });
      session.memorySessionId = null;
      this.dbManager.getSessionStore().updateMemorySessionId(session.sessionDbId, null);
      session.forceInit = false;
    }

    const mode = ModeManager.getInstance().getActiveMode();
    const firstPrompt = session.lastPromptNumber === 1
      ? buildInitPrompt(session.project, session.contentSessionId, session.userPrompt, mode)
      : buildContinuationPrompt(session.userPrompt, session.lastPromptNumber, session.contentSessionId, mode);

    session.conversationHistory.push({ role: 'user', content: firstPrompt });

    let first: RunResult;
    try {
      first = await this.runTurn(session, firstPrompt, executable, cwd, model);
    } catch (error: unknown) {
      return this.handleError(error, session);
    }

    if (first.response) {
      session.conversationHistory.push({ role: 'assistant', content: first.response });
      this.accountTokens(session, first.tokensUsed);
      await processAgentResponse(first.response, session, this.dbManager, this.sessionManager, worker, first.tokensUsed, null, 'GeminiCli', undefined, model);
    } else {
      // Expected, not an error: the init turn only primes context (observer
      // role + output format) and captures the memorySessionId — there is no
      // tool observation to record yet, so an empty response is the normal
      // case. ClaudeProvider treats its equivalent empty priming response the
      // same way (it never logs an error for a zero-length init response).
      logger.debug('SDK', 'Gemini CLI init turn returned no observation (expected — priming turn)', { sessionId: session.sessionDbId, model });
    }

    try {
      await this.processMessageLoop(session, worker, executable, cwd, model);
    } catch (error: unknown) {
      return this.handleError(error, session);
    }

    const sessionDuration = Date.now() - session.startTime;
    logger.success('SDK', 'Gemini CLI agent completed', {
      sessionId: session.sessionDbId,
      duration: `${(sessionDuration / 1000).toFixed(1)}s`,
      memorySessionId: session.memorySessionId ?? undefined,
    });
  }

  /**
   * Run one conversation turn. Resumes the session when we already hold a
   * memorySessionId; otherwise (or when resume finds no session) creates a new
   * one and captures its UUID as the memorySessionId.
   */
  private async runTurn(
    session: ActiveSession,
    promptText: string,
    executable: string,
    cwd: string,
    model: string,
  ): Promise<RunResult> {
    const signal = session.abortController.signal;
    const timeoutMs = this.getTimeoutMs();

    if (session.memorySessionId) {
      try {
        return await runGeminiCli({ executable, cwd, model, prompt: promptText, resumeId: session.memorySessionId, signal, timeoutMs });
      } catch (error: unknown) {
        if (isAbortError(error)) throw error;
        const notFound = error instanceof ClassifiedProviderError && error.kind === 'session_not_found';
        if (!notFound) throw error;
        logger.warn('SDK', 'Gemini CLI resume failed (session not found) — re-priming a fresh session', {
          sessionId: session.sessionDbId,
          staleMemorySessionId: session.memorySessionId,
        });
        session.memorySessionId = null;

        // A vanished gemini session takes its whole conversation with it,
        // including the init turn that established the observer role and the
        // structured output format. promptText here is an observation/summary
        // prompt that assumes that context; a brand-new session handed only
        // this prompt would emit unstructured text that processAgentResponse
        // silently discards. So prime the fresh session exactly as startSession
        // would, then resume it with the real prompt — mirroring the normal
        // init→turn flow.
        const mode = ModeManager.getInstance().getActiveMode();
        const primingPrompt = buildContinuationPrompt(session.userPrompt, session.lastPromptNumber, session.contentSessionId, mode);
        const primed = await this.runFreshTurn(session, primingPrompt, executable, cwd, model, signal, timeoutMs);
        return await runGeminiCli({ executable, cwd, model, prompt: promptText, resumeId: primed.sessionId, signal, timeoutMs });
      }
    }

    return this.runFreshTurn(session, promptText, executable, cwd, model, signal, timeoutMs);
  }

  /**
   * Spawn a brand-new gemini session (no `--resume`), capture and register the
   * `session_id` it returns as the session's memorySessionId, and return the
   * turn result. Used for the first turn of a session and to re-establish a
   * session after a `--resume` finds none.
   */
  private async runFreshTurn(
    session: ActiveSession,
    promptText: string,
    executable: string,
    cwd: string,
    model: string,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<RunResult> {
    const result = await runGeminiCli({ executable, cwd, model, prompt: promptText, signal, timeoutMs });
    const captured = result.sessionId;
    if (!captured) {
      throw new ClassifiedProviderError('Gemini CLI did not return a session_id', { kind: 'transient', cause: new Error('missing session_id') });
    }
    session.memorySessionId = captured;
    this.dbManager.getSessionStore().ensureMemorySessionIdRegistered(session.sessionDbId, captured);
    logger.info('SESSION', `MEMORY_ID_CAPTURED | sessionDbId=${session.sessionDbId} | provider=GeminiCli | memorySessionId=${captured}`, {
      sessionId: session.sessionDbId,
      memorySessionId: captured,
    });
    return result;
  }

  private async processMessageLoop(
    session: ActiveSession,
    worker: WorkerRef | undefined,
    executable: string,
    cwd: string,
    model: string,
  ): Promise<void> {
    let lastCwd: string | undefined;

    for await (const message of this.sessionManager.getMessageIterator(session.sessionDbId)) {
      session.pendingAgentId = message.agentId ?? null;
      session.pendingAgentType = message.agentType ?? null;

      if (message.cwd) {
        lastCwd = message.cwd;
      }
      const originalTimestamp = session.earliestPendingTimestamp;

      if (message.type === 'observation') {
        if (message.prompt_number !== undefined) {
          session.lastPromptNumber = message.prompt_number;
        }
        const obsPrompt = buildObservationPrompt({
          id: 0,
          tool_name: message.tool_name!,
          tool_input: JSON.stringify(message.tool_input),
          tool_output: JSON.stringify(message.tool_response),
          created_at_epoch: originalTimestamp ?? Date.now(),
          cwd: message.cwd,
        });
        session.conversationHistory.push({ role: 'user', content: obsPrompt });
        const result = await this.runTurn(session, obsPrompt, executable, cwd, model);
        await this.emitResult(result, session, worker, originalTimestamp, lastCwd, model, 'observation');
      } else if (message.type === 'summarize') {
        const summaryPrompt = buildSummaryPrompt({
          id: session.sessionDbId,
          memory_session_id: session.memorySessionId,
          project: session.project,
          user_prompt: session.userPrompt,
          last_assistant_message: message.last_assistant_message || '',
        }, ModeManager.getInstance().getActiveMode());
        session.conversationHistory.push({ role: 'user', content: summaryPrompt });
        const result = await this.runTurn(session, summaryPrompt, executable, cwd, model);
        await this.emitResult(result, session, worker, originalTimestamp, lastCwd, model, 'summary');
      }
    }
  }

  private async emitResult(
    result: RunResult,
    session: ActiveSession,
    worker: WorkerRef | undefined,
    originalTimestamp: number | null,
    lastCwd: string | undefined,
    model: string,
    kind: 'observation' | 'summary',
  ): Promise<void> {
    if (result.response) {
      session.conversationHistory.push({ role: 'assistant', content: result.response });
      this.accountTokens(session, result.tokensUsed);
      await processAgentResponse(result.response, session, this.dbManager, this.sessionManager, worker, result.tokensUsed, originalTimestamp, 'GeminiCli', lastCwd, model);
    } else {
      logger.warn('SDK', `Empty Gemini CLI ${kind} response — message already consumed, nothing recorded`, {
        sessionId: session.sessionDbId,
      });
    }
  }

  /** Split reported tokens 70/30 input/output, matching GeminiProvider. */
  private accountTokens(session: ActiveSession, tokensUsed: number): void {
    session.cumulativeInputTokens += Math.floor(tokensUsed * 0.7);
    session.cumulativeOutputTokens += Math.floor(tokensUsed * 0.3);
  }

  private handleError(error: unknown, session: ActiveSession): never {
    if (isAbortError(error)) {
      logger.warn('SDK', 'Gemini CLI agent aborted', { sessionId: session.sessionDbId });
      throw error;
    }
    logger.failure('SDK', 'Gemini CLI agent error', { sessionDbId: session.sessionDbId }, error instanceof Error ? error : new Error(String(error)));
    throw error;
  }

  private getTimeoutMs(): number {
    const settings = SettingsDefaultsManager.loadFromFile(paths.settings());
    const raw = parseInt(settings.CLAUDE_MEM_GEMINI_CLI_TIMEOUT_MS, 10);
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
  }

  private getConfig(): { model: string } {
    const settings = SettingsDefaultsManager.loadFromFile(paths.settings());
    const model = settings.CLAUDE_MEM_GEMINI_CLI_MODEL || 'auto';
    return { model };
  }
}

/** Whether the gemini-cli provider is the configured CLAUDE_MEM_PROVIDER. */
export function isGeminiCliSelected(): boolean {
  const settings = SettingsDefaultsManager.loadFromFile(paths.settings());
  return settings.CLAUDE_MEM_PROVIDER === 'gemini-cli';
}

/**
 * Available when the `gemini` binary resolves AND the CLI is authenticated
 * (OAuth creds on disk, or a GEMINI_API_KEY the CLI can fall back to).
 */
export function isGeminiCliAvailable(): boolean {
  if (!hasGeminiExecutable()) return false;
  const oauthCreds = join(homedir(), '.gemini', 'oauth_creds.json');
  if (existsSync(oauthCreds)) return true;
  return !!getCredential('GEMINI_API_KEY');
}
