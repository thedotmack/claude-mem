import { randomUUID } from 'crypto';
import { spawn } from 'child_process';
import { existsSync, readFileSync, unlinkSync } from 'fs';
import { isAbsolute, join } from 'path';
import { DatabaseManager } from './DatabaseManager.js';
import { SessionManager } from './SessionManager.js';
import { logger } from '../../utils/logger.js';
import { buildInitPrompt, buildObservationPrompt, buildSummaryPrompt, buildContinuationPrompt } from '../../sdk/prompts.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { AGY_CLI_SESSIONS_DIR, ensureDir, paths } from '../../shared/paths.js';
import type { ActiveSession } from '../worker-types.js';
import { ModeManager } from '../domain/ModeManager.js';
import { processAgentResponse, isAbortError, type WorkerRef } from './agents/index.js';
import { ClassifiedProviderError } from './provider-errors.js';
import { findAgyExecutable, hasAgyExecutable } from '../../shared/find-agy-executable.js';
import { sanitizeEnv } from '../../supervisor/env-sanitizer.js';

const DEFAULT_TIMEOUT_MS = 300_000;
const ABORT_KILL_GRACE_MS = 1_000;
const CONVERSATION_ID_PATTERN = /Created conversation\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

export function extractAgyConversationId(logText: string): string | null {
  return CONVERSATION_ID_PATTERN.exec(logText)?.[1] ?? null;
}

function isConversationNotFound(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes('conversation not found') ||
    lower.includes('conversation does not exist') ||
    lower.includes('could not find conversation') ||
    (lower.includes('conversation') && lower.includes('not found'))
  );
}

export function classifyAgyCliError(input: {
  exitCode: number | null;
  stderr: string;
  logText?: string;
  cause: unknown;
}): ClassifiedProviderError {
  const detail = `${input.stderr ?? ''}\n${input.logText ?? ''}`.trim();
  const lower = detail.toLowerCase();

  if (isConversationNotFound(detail)) {
    return new ClassifiedProviderError('Agy CLI conversation not found', { kind: 'session_not_found', cause: input.cause });
  }
  if (lower.includes('enoent') || lower.includes('command not found') || lower.includes('agy cli executable not found')) {
    return new ClassifiedProviderError(`Agy CLI not found: ${detail.slice(0, 200)}`, { kind: 'unrecoverable', cause: input.cause });
  }
  if (lower.includes('quota') || lower.includes('resource_exhausted')) {
    return new ClassifiedProviderError('Agy CLI quota exhausted', { kind: 'quota_exhausted', cause: input.cause });
  }
  if (lower.includes('429') || lower.includes('rate limit') || lower.includes('too many requests')) {
    return new ClassifiedProviderError('Agy CLI rate limited', { kind: 'rate_limit', cause: input.cause });
  }
  if (
    lower.includes('authentication failed') ||
    lower.includes('silent auth failed') ||
    lower.includes('please sign in') ||
    lower.includes('permission denied') ||
    lower.includes('permission_denied') ||
    lower.includes('unauthenticated')
  ) {
    return new ClassifiedProviderError(`Agy CLI auth error: ${detail.slice(0, 200)}`, { kind: 'auth_invalid', cause: input.cause });
  }

  return new ClassifiedProviderError(
    `Agy CLI error (exit ${input.exitCode}): ${detail.slice(0, 200)}`,
    { kind: 'transient', cause: input.cause },
  );
}

interface RunOptions {
  executable: string;
  cwd: string;
  model: string;
  prompt: string;
  resumeId?: string;
  signal: AbortSignal;
  timeoutMs: number;
  sessionDbId: number;
}

interface RunResult {
  sessionId: string;
  response: string;
  tokensUsed: number;
}

function estimateTokens(prompt: string, response: string): number {
  return Math.max(1, Math.ceil((prompt.length + response.length) / 4));
}

function readLog(logPath: string): string {
  try {
    return readFileSync(logPath, 'utf8');
  } catch {
    return '';
  }
}

function runAgyCli(opts: RunOptions): Promise<RunResult> {
  return new Promise<RunResult>((resolve, reject) => {
    if (opts.signal.aborted) {
      reject(Object.assign(new Error('Agy CLI aborted before spawn'), { name: 'AbortError' }));
      return;
    }

    ensureDir(AGY_CLI_SESSIONS_DIR);
    const logPath = join(AGY_CLI_SESSIONS_DIR, `turn-${opts.sessionDbId}-${Date.now()}-${randomUUID()}.log`);
    const args = ['--add-dir', opts.cwd];
    if (opts.resumeId) args.push('--conversation', opts.resumeId);
    if (opts.model) args.push('--model', opts.model);
    args.push(
      '--print', opts.prompt,
      '--print-timeout', `${Math.max(1, Math.ceil(opts.timeoutMs / 1000))}s`,
      '--log-file', logPath,
    );

    const child = spawn(opts.executable, args, {
      cwd: opts.cwd,
      env: sanitizeEnv(process.env),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let terminationError: unknown = null;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    let timer: ReturnType<typeof setTimeout>;

    const cleanup = () => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      opts.signal.removeEventListener('abort', onAbort);
      try {
        if (existsSync(logPath)) unlinkSync(logPath);
      } catch {
        // Best-effort cleanup; the next run uses a unique path.
      }
    };
    const resolveOnce = (value: RunResult) => {
      if (!settled) {
        settled = true;
        cleanup();
        resolve(value);
      }
    };
    const rejectOnce = (error: unknown) => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(error);
      }
    };
    const requestTermination = (error: unknown, signal: NodeJS.Signals) => {
      if (settled || terminationError) return;
      terminationError = error;
      try { child.kill(signal); } catch { /* close/error will settle if the process already exited */ }
      if (signal === 'SIGTERM') {
        killTimer = setTimeout(() => {
          if (settled) return;
          try { child.kill('SIGKILL'); } catch { /* best-effort escalation */ }
        }, ABORT_KILL_GRACE_MS);
      }
    };
    const onAbort = () => {
      requestTermination(Object.assign(new Error('Agy CLI aborted'), { name: 'AbortError' }), 'SIGTERM');
    };
    timer = setTimeout(() => {
      requestTermination(classifyAgyCliError({
        exitCode: null,
        stderr: `Agy CLI timed out after ${opts.timeoutMs}ms`,
        logText: readLog(logPath),
        cause: new Error('agy CLI timeout'),
      }), 'SIGKILL');
    }, opts.timeoutMs);

    opts.signal.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => {
      if (terminationError) {
        rejectOnce(terminationError);
        return;
      }
      rejectOnce(classifyAgyCliError({ exitCode: null, stderr: error.message, logText: readLog(logPath), cause: error }));
    });
    child.on('close', (code) => {
      if (terminationError) {
        rejectOnce(terminationError);
        return;
      }
      const logText = readLog(logPath);
      if (code !== 0) {
        rejectOnce(classifyAgyCliError({ exitCode: code, stderr, logText, cause: new Error(`agy exited ${code}`) }));
        return;
      }

      const sessionId = opts.resumeId ?? extractAgyConversationId(logText) ?? '';
      if (!sessionId) {
        rejectOnce(new ClassifiedProviderError(
          'Agy CLI completed without reporting a conversation ID',
          { kind: 'transient', cause: new Error('missing conversation ID') },
        ));
        return;
      }
      const response = stdout.trim();
      resolveOnce({ sessionId, response, tokensUsed: estimateTokens(opts.prompt, response) });
    });
  });
}

export class AgyCliProvider {
  constructor(
    private dbManager: DatabaseManager,
    private sessionManager: SessionManager,
  ) {}

  async startSession(session: ActiveSession, worker?: WorkerRef): Promise<void> {
    const executable = findAgyExecutable('SDK');
    const { model } = this.getConfig();
    const cwd = this.getWorkspace(session);
    ensureDir(cwd);
    const mode = ModeManager.getInstance().getActiveMode();

    if (session.forceInit) {
      logger.info('SDK', 'forceInit set — starting fresh Agy CLI conversation', {
        sessionDbId: session.sessionDbId,
        previousMemorySessionId: session.memorySessionId,
      });
      session.memorySessionId = null;
      this.dbManager.getSessionStore().updateMemorySessionId(session.sessionDbId, null);
      session.forceInit = false;
    }

    const firstPrompt = session.lastPromptNumber === 1
      ? buildInitPrompt(session.project, session.contentSessionId, session.userPrompt, mode)
      : buildContinuationPrompt(session.userPrompt, session.lastPromptNumber, session.contentSessionId, mode);
    session.conversationHistory.push({ role: 'user', content: firstPrompt });

    try {
      const first = await this.runTurn(session, firstPrompt, executable, cwd, model);
      await this.emitResult(first, session, worker, null, undefined, model, 'init');
      await this.processMessageLoop(session, worker, executable, cwd, model);
      const duration = Date.now() - session.startTime;
      logger.success('SDK', 'Agy CLI agent completed', {
        sessionId: session.sessionDbId,
        duration: `${(duration / 1000).toFixed(1)}s`,
        memorySessionId: session.memorySessionId ?? undefined,
      });
    } catch (error: unknown) {
      return this.handleError(error, session);
    }
  }

  private async runTurn(
    session: ActiveSession,
    prompt: string,
    executable: string,
    cwd: string,
    model: string,
  ): Promise<RunResult> {
    const signal = session.abortController.signal;
    const timeoutMs = this.getTimeoutMs();

    if (session.memorySessionId) {
      try {
        return await runAgyCli({
          executable, cwd, model, prompt, resumeId: session.memorySessionId,
          signal, timeoutMs, sessionDbId: session.sessionDbId,
        });
      } catch (error: unknown) {
        if (isAbortError(error)) throw error;
        const notFound = error instanceof ClassifiedProviderError && error.kind === 'session_not_found';
        if (!notFound) throw error;
        logger.warn('SDK', 'Agy CLI resume failed (conversation not found) — creating a fresh conversation', {
          sessionId: session.sessionDbId,
          staleMemorySessionId: session.memorySessionId,
        });
        session.memorySessionId = null;
        this.dbManager.getSessionStore().updateMemorySessionId(session.sessionDbId, null);

        const mode = ModeManager.getInstance().getActiveMode();
        const primingPrompt = buildContinuationPrompt(
          session.userPrompt,
          session.lastPromptNumber,
          session.contentSessionId,
          mode,
        );
        const primed = await this.runFreshTurn(session, primingPrompt, executable, cwd, model, signal, timeoutMs);
        return runAgyCli({
          executable, cwd, model, prompt, resumeId: primed.sessionId,
          signal, timeoutMs, sessionDbId: session.sessionDbId,
        });
      }
    }

    return this.runFreshTurn(session, prompt, executable, cwd, model, signal, timeoutMs);
  }

  private async runFreshTurn(
    session: ActiveSession,
    prompt: string,
    executable: string,
    cwd: string,
    model: string,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<RunResult> {
    const result = await runAgyCli({
      executable, cwd, model, prompt, signal, timeoutMs, sessionDbId: session.sessionDbId,
    });
    session.memorySessionId = result.sessionId;
    this.dbManager.getSessionStore().ensureMemorySessionIdRegistered(session.sessionDbId, result.sessionId);
    logger.info('SESSION', `MEMORY_ID_CAPTURED | sessionDbId=${session.sessionDbId} | provider=AgyCli | memorySessionId=${result.sessionId}`, {
      sessionId: session.sessionDbId,
      memorySessionId: result.sessionId,
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
      if (message.cwd) lastCwd = message.cwd;
      const originalTimestamp = session.earliestPendingTimestamp;

      if (message.type === 'observation') {
        if (message.prompt_number !== undefined) session.lastPromptNumber = message.prompt_number;
        const observationPrompt = buildObservationPrompt({
          id: 0,
          tool_name: message.tool_name!,
          tool_input: JSON.stringify(message.tool_input),
          tool_output: JSON.stringify(message.tool_response),
          created_at_epoch: originalTimestamp ?? Date.now(),
          cwd: message.cwd,
        });
        session.conversationHistory.push({ role: 'user', content: observationPrompt });
        const result = await this.runTurn(session, observationPrompt, executable, cwd, model);
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
    kind: 'init' | 'observation' | 'summary',
  ): Promise<void> {
    if (!result.response) {
      logger.warn('SDK', `Empty Agy CLI ${kind} response — message already consumed, nothing recorded`, {
        sessionId: session.sessionDbId,
      });
      return;
    }

    session.conversationHistory.push({ role: 'assistant', content: result.response });
    this.accountTokens(session, result.tokensUsed);
    await processAgentResponse(
      result.response,
      session,
      this.dbManager,
      this.sessionManager,
      worker,
      result.tokensUsed,
      originalTimestamp,
      'AgyCli',
      lastCwd,
      model || 'default',
    );
  }

  private accountTokens(session: ActiveSession, total: number): void {
    session.cumulativeInputTokens += Math.floor(total * 0.7);
    session.cumulativeOutputTokens += Math.ceil(total * 0.3);
  }

  private handleError(error: unknown, session: ActiveSession): never {
    if (isAbortError(error)) {
      logger.warn('SDK', 'Agy CLI agent aborted', { sessionId: session.sessionDbId });
      throw error;
    }
    logger.failure('SDK', 'Agy CLI agent error', { sessionDbId: session.sessionDbId }, error instanceof Error ? error : new Error(String(error)));
    throw error;
  }

  private getTimeoutMs(): number {
    const settings = SettingsDefaultsManager.loadFromFile(paths.settings());
    const raw = parseInt(settings.CLAUDE_MEM_AGY_CLI_TIMEOUT_MS, 10);
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
  }

  private getConfig(): { model: string } {
    const settings = SettingsDefaultsManager.loadFromFile(paths.settings());
    return { model: settings.CLAUDE_MEM_AGY_CLI_MODEL || '' };
  }

  private getWorkspace(session: ActiveSession): string {
    if (typeof session.project === 'string' && isAbsolute(session.project) && existsSync(session.project)) {
      return session.project;
    }
    ensureDir(AGY_CLI_SESSIONS_DIR);
    return AGY_CLI_SESSIONS_DIR;
  }
}

export function isAgyCliSelected(): boolean {
  const settings = SettingsDefaultsManager.loadFromFile(paths.settings());
  return settings.CLAUDE_MEM_PROVIDER === 'agy-cli';
}

export function isAgyCliAvailable(): boolean {
  return hasAgyExecutable();
}
