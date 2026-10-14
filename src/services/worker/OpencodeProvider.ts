/**
 * Observer provider that shells out to the `opencode` CLI, so observation
 * turns run on the user's Zen login (e.g. a free-tier model) instead of an
 * HTTP API key.
 *
 * Why a CLI spawn rather than HTTP: the Zen gateway answers every
 * third-party-shaped HTTP call with 403 FreeTierError, but the CLI's own
 * requests (same account) return 200. Each query() is one
 * `opencode run -m <model> --format json --title claude-mem-observer` in the
 * fixed observer directory, reusing one archived server-minted session
 * (`-s <id>` continue path, 200). The create path (`-s <custom-id>`) and
 * custom `--agent` both trip the fingerprint (403), so there is no custom
 * zero-tool agent: tool silence comes from the sentinel line in every prompt
 * plus the worker/plugin skips (see opencode-observer.ts).
 *
 * stdout is JSONL: {type:step_start}, {type:text,part:{text}}, {type:error},
 * {type:step_finish,part:{tokens:{input,output}}}. Assistant text is the
 * concatenation of the text parts and feeds the shared processAgentResponse
 * pipeline exactly like an HTTP provider's reply.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { DatabaseManager } from './DatabaseManager.js';
import { SessionManager } from './SessionManager.js';
import { logger } from '../../utils/logger.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { DEFAULT_LLM_TIMEOUT_MS } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { OBSERVER_PROMPT_SENTINEL } from '../../shared/observer-sentinel.js';
import { OBSERVER_SESSION_TITLE } from '../../shared/observer-sentinel.js';
import type { ActiveSession, ConversationMessage } from '../worker-types.js';
import {
  OpenAICompatibleProvider,
  type ProviderQueryResult,
} from './OpenAICompatibleProvider.js';
import { ClassifiedProviderError, DEADLINE_EXCEEDED_CODE } from './provider-errors.js';
import type { PaidSendBudget } from './paid-send-budget.js';
import type { ObserverRequestLabel } from './OpenAICompatibleProvider.js';
import {
  observerDir,
  readArchivedSessionId,
  writeArchivedSessionId,
  findOpencodeBinary,
  isOpencodeBinaryOnPath,
  isArchivedSessionClean,
  withObserverRunLock,
  cleanupObserverSessions,
} from './opencode-observer.js';

export const DEFAULT_OPENCODE_MODEL = 'opencode/muse-spark-1.3-contributor-free';

const CHARS_PER_TOKEN_ESTIMATE = 4;

interface OpencodeConfig {
  apiKey: string;
  model: string;
  plainText?: boolean;
}

interface RunEvent {
  type?: string;
  sessionID?: string;
  part?: { type?: string; text?: string; tokens?: { input?: number; output?: number } };
  error?: { type?: string; message?: string; status?: number };
}

/** Pure parse of one `opencode run --format json` JSONL stdout, for tests. */
export interface CollectedRunOutput {
  sessionId: string;
  text: string;
  inputTokens?: number;
  outputTokens?: number;
  /** True when the stream carried event types outside the known chat set. */
  sawUnknownEventType: boolean;
  error?: { message: string; status?: number };
}

export function collectRunOutput(stdout: string): CollectedRunOutput {
  let sessionId = '';
  const texts: string[] = [];
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let sawUnknownEventType = false;
  let error: CollectedRunOutput['error'];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: RunEvent;
    try {
      event = JSON.parse(trimmed) as RunEvent;
    } catch {
      continue;
    }
    if (typeof event.sessionID === 'string' && event.sessionID) sessionId = event.sessionID;
    switch (event.type) {
      case 'step_start':
        break;
      case 'text':
        if (typeof event.part?.text === 'string') texts.push(event.part.text);
        break;
      case 'step_finish': {
        const tokens = event.part?.tokens;
        if (typeof tokens?.input === 'number') inputTokens = tokens.input;
        if (typeof tokens?.output === 'number') outputTokens = tokens.output;
        break;
      }
      case 'error':
        error = {
          message: event.error?.message ?? 'opencode run failed',
          ...(event.error?.status !== undefined ? { status: event.error.status } : {}),
        };
        break;
      default:
        sawUnknownEventType = true;
        break;
    }
  }
  return {
    sessionId,
    text: texts.join('\n'),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    sawUnknownEventType,
    ...(error ? { error } : {}),
  };
}

export function classifyOpencodeRunError(input: {
  message: string;
  status?: number;
  cause: unknown;
}): ClassifiedProviderError {
  const { message, status, cause } = input;
  const lower = message.toLowerCase();
  if (status === 429 || lower.includes('rate limit') || lower.includes('tpm limit')) {
    return new ClassifiedProviderError(message, { kind: 'rate_limit', cause });
  }
  if (status === 402 || lower.includes('quota exceeded') || lower.includes('allowance')) {
    return new ClassifiedProviderError(message, { kind: 'quota_exhausted', cause });
  }
  // The free tier refusing this account (FreeTierError): pause with the
  // gateway's own words and re-probe later, like a spent allowance.
  if (status === 403 || status === 401 || lower.includes('freetiererror') || lower.includes('free tier')) {
    return new ClassifiedProviderError(message, {
      kind: status === 401 ? 'auth_invalid' : 'quota_exhausted',
      cause,
    });
  }
  if (
    lower.includes('context window') ||
    lower.includes('prompt is too long') ||
    lower.includes('too long')
  ) {
    return new ClassifiedProviderError(message, { kind: 'context_overflow', cause });
  }
  if (
    message.includes('ENOENT') ||
    message.startsWith('spawn ') ||
    lower.includes('opencode executable not found')
  ) {
    return new ClassifiedProviderError(message, { kind: 'setup_required', cause });
  }
  if (typeof status === 'number' && status >= 500 && status < 600) {
    return new ClassifiedProviderError(message, { kind: 'transient', cause });
  }
  return new ClassifiedProviderError(message, { kind: 'transient', cause });
}

export class OpencodeProvider extends OpenAICompatibleProvider<OpencodeConfig> {
  protected readonly providerName = 'Opencode';
  protected readonly syntheticIdPrefix = 'opencode';
  protected readonly forwardEmptyMessageResponse = true;

  constructor(dbManager: DatabaseManager, sessionManager: SessionManager) {
    super(dbManager, sessionManager);
  }

  protected getConfig(): OpencodeConfig {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    const raw = settings.CLAUDE_MEM_OPENCODE_MODEL;
    const model = typeof raw === 'string' && raw.trim() ? raw.trim() : DEFAULT_OPENCODE_MODEL;
    return { apiKey: '', model };
  }

  protected missingApiKeyError(): Error {
    return new ClassifiedProviderError(
      'Opencode provider is not configured. Set CLAUDE_MEM_OPENCODE_MODEL in settings (default opencode/muse-spark-1.3-contributor-free) and ensure the opencode CLI is on PATH with a Zen login (`opencode auth login`).',
      { kind: 'setup_required', cause: new Error('opencode not configured') },
    );
  }

  /** The Zen login lives in the CLI, never in a key setting. */
  protected requiresApiKey(_config: OpencodeConfig): boolean {
    return false;
  }

  protected prepareSessionExtras(session: ActiveSession, _config: OpencodeConfig): void {
    session.endpointClass = 'custom';
  }

  protected estimateTokens(text: string): number {
    return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
  }

  protected buildLastUsage(result: ProviderQueryResult): ActiveSession['lastUsage'] {
    if (typeof result.inputTokens !== 'number' || typeof result.outputTokens !== 'number') {
      return null;
    }
    return { input: result.inputTokens, output: result.outputTokens };
  }

  protected async query(
    history: ConversationMessage[],
    config: OpencodeConfig,
    _signal?: AbortSignal,
    perAttemptTimeoutMs?: number,
    _paidSendBudget?: PaidSendBudget,
    label?: ObserverRequestLabel,
  ): Promise<ProviderQueryResult> {
    // One reused opencode session at a time: concurrent generators must not
    // interleave prompts in it (see withObserverRunLock).
    return withObserverRunLock(async () => {
      const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
      const timeoutMs =
        perAttemptTimeoutMs ??
        (parseInt(settings.CLAUDE_MEM_LLM_TIMEOUT_MS, 10) || DEFAULT_LLM_TIMEOUT_MS);

      const latest = [...history].reverse().find((m) => m.content.trim())?.content ?? '(context unavailable)';
      const scopedPrompt = `${OBSERVER_PROMPT_SENTINEL}\nConsider only the latest user message below; earlier conversation is background.\n\n${latest}`;
      const fullPrompt = `${OBSERVER_PROMPT_SENTINEL}\n${this.conversationToOpenAIMessages(history)
        .map((m) => `${m.role}: ${m.content}`)
        .join('\n\n')}`;

      const binary = await findOpencodeBinary();
      if (!binary) throw this.missingApiKeyError();

      const dir = observerDir();
      await cleanupObserverSessions(await readArchivedSessionId());

      const archived = await readArchivedSessionId();
      if (archived && (await isArchivedSessionClean(archived))) {
        const reuse = await this.runOnce(binary, config.model, dir, timeoutMs, scopedPrompt, archived, label);
        if (reuse.ok) {
          logger.info('SDK', 'Opencode observer session reused', { sessionId: reuse.sessionId || archived, kind: label?.kind });
          return this.toQueryResult(reuse, config.model);
        }
        logger.warn('SDK', 'Opencode session reuse failed; rotating to a fresh session', {
          archived,
          error: reuse.errorText,
        });
      } else if (archived) {
        logger.warn('SDK', 'Opencode archived session abandoned (polluted); rotating to a fresh session', { archived });
      }

      const fresh = await this.runOnce(binary, config.model, dir, timeoutMs, fullPrompt, null, label);
      if (!fresh.ok) {
        if (fresh.timedOut) {
          throw new ClassifiedProviderError(fresh.errorText, {
            kind: 'transient',
            code: DEADLINE_EXCEEDED_CODE,
            cause: new Error(fresh.errorText),
          });
        }
        throw classifyOpencodeRunError({ message: fresh.errorText, status: fresh.errorStatus, cause: new Error(fresh.errorText) });
      }
      if (fresh.sessionId) {
        await writeArchivedSessionId(fresh.sessionId);
        await cleanupObserverSessions(fresh.sessionId);
      }
      return this.toQueryResult(fresh, config.model);
    });
  }

  private toQueryResult(
    run: { text: string; inputTokens?: number; outputTokens?: number; sawToolUse: boolean; sessionId: string },
    model: string,
  ): ProviderQueryResult {
    if (run.sawToolUse) {
      logger.warn('SDK', 'Opencode observer turn used tools despite the no-tools sentinel; worker skips still apply', {
        sessionId: run.sessionId,
        model,
      });
    }
    const { inputTokens, outputTokens } = run;
    const tokensUsed =
      inputTokens !== undefined || outputTokens !== undefined
        ? (inputTokens ?? 0) + (outputTokens ?? 0)
        : undefined;
    return {
      content: run.text,
      ...(tokensUsed !== undefined ? { tokensUsed } : {}),
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
      servedModel: model,
    };
  }

  private runOnce(
    binary: string,
    model: string,
    cwd: string,
    timeoutMs: number,
    prompt: string,
    sessionId: string | null,
    label?: ObserverRequestLabel,
  ): Promise<
    | { ok: true; text: string; sessionId: string; inputTokens?: number; outputTokens?: number; sawToolUse: boolean }
    | { ok: false; errorText: string; errorStatus?: number; timedOut?: boolean }
  > {
    return new Promise((resolve) => {
      const args = ['run', '-m', model, '--format', 'json', '--title', OBSERVER_SESSION_TITLE];
      if (sessionId) args.push('-s', sessionId);
      args.push(prompt);
      logger.debug('SDK', `Spawning opencode run (${model})`, {
        ...(sessionId ? { reuseSession: sessionId } : { freshSession: true }),
        kind: label?.kind,
        promptChars: prompt.length,
      });
      let child: ChildProcess;
      try {
        child = spawn(binary, args, { cwd, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (error) {
        resolve({ ok: false, errorText: error instanceof Error ? error.message : String(error) });
        return;
      }
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill('SIGKILL');
        } catch {
          // already gone
        }
      }, timeoutMs);
      child.on('error', (error) => {
        clearTimeout(timer);
        resolve({ ok: false, errorText: error.message });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        // Our own deadline, not a backend failure: the shared code books it
        // with its remedy in observer-health, like withRetry's deadline.
        if (timedOut) {
          resolve({ ok: false, errorText: `Opencode run timed out after ${timeoutMs}ms`, timedOut: true });
          return;
        }
        const collected = collectRunOutput(stdout);
        if (code !== 0 || collected.error) {
          const errorText =
            collected.error?.message ??
            (stderr.trim() || stdout.trim() || `opencode run exited with code ${code}`);
          resolve({
            ok: false,
            errorText,
            ...(collected.error?.status !== undefined ? { errorStatus: collected.error.status } : {}),
          });
          return;
        }
        resolve({
          ok: true,
          text: collected.text,
          sessionId: collected.sessionId,
          ...(collected.inputTokens !== undefined ? { inputTokens: collected.inputTokens } : {}),
          ...(collected.outputTokens !== undefined ? { outputTokens: collected.outputTokens } : {}),
          sawToolUse: collected.sawUnknownEventType,
        });
      });
    });
  }
}

export function isOpencodeSelected(settingsPath?: string): boolean {
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath ?? USER_SETTINGS_PATH);
  return settings.CLAUDE_MEM_PROVIDER === 'opencode';
}

/** Sync (dispatch calls it per generator start): model set + binary on PATH. */
export function isOpencodeAvailable(): boolean {
  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
  const raw = settings.CLAUDE_MEM_OPENCODE_MODEL;
  if (typeof raw === 'string' && !raw.trim()) return false;
  return isOpencodeBinaryOnPath();
}
