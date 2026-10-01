import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import type { ActiveSession, ConversationMessage, PendingMessageWithId } from '../worker-types.js';
import { OpenAICompatibleProvider, type ProviderQueryResult } from './OpenAICompatibleProvider.js';
import {
  CODEX_ISOLATION_UNATTESTED_CODE,
  CODEX_NO_AGENT_MESSAGE_CODE,
  CODEX_SETUP_REQUIRED_CODE,
  type CodexAppServerTurnResult,
} from './CodexAppServerClient.js';
import { CodexAppServerPool, boundedInteger } from './CodexAppServerPool.js';
import { ClassifiedProviderError, CODEX_COOLDOWN_REFUSAL_CODE, isClassified } from './provider-errors.js';
import { resolveLlmTimeoutMs, withRetry } from './retry.js';
import {
  clearQuotaCooldown,
  getQuotaCooldown,
  isQuotaCooldownActive,
  recordAuthCooldown,
  recordQuotaExhausted,
  type QuotaCooldownState,
} from '../../shared/quota-cooldown.js';
import {
  CODEX_CLI_SETUP_RECHECK_COOLDOWN_MS,
  clearDependencyStatus,
  getDependencyStatus,
  isDependencyStatusInCooldown,
  recordCodexCliSetupRequired,
} from '../../shared/dependency-health.js';
import { OBS_PROMPT_FIELD_MAX_CHARS, type ObservationPromptParts } from '../../sdk/prompts.js';
import { observationMetadata, queuedObservationPrompt, boundObservationPrompt, sameObservationContext } from './codex-observation-batch.js';
import { logger } from '../../utils/logger.js';

interface CodexConfig {
  apiKey: string;
  model: string;
  codexPath: string;
  reasoningEffort: string | null;
  signal?: AbortSignal;
  /** The session this config serves, for per-session fault counting. */
  sessionDbId?: number;
}

type CodexErrorKind = ConstructorParameters<typeof ClassifiedProviderError>[1]['kind'];

/**
 * Every reasoning effort a Codex release has accepted. The app-server passes
 * the value through untyped, so the settings boundary checks it; an older CLI
 * or a model that serves fewer refuses the rest, which is classified as setup.
 */
export const CODEX_REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;

export function isCodexReasoningEffort(value: string): boolean {
  return (CODEX_REASONING_EFFORTS as readonly string[]).includes(value);
}

/**
 * A 4xx Codex answers the same way every time: the model, the effort, or the
 * shape of the request is wrong for this account or this CLI.
 */
const CODEX_REFUSED_REQUEST = 'refused_request';

const CODEX_ERROR_INFO_KINDS: Record<string, CodexErrorKind | typeof CODEX_REFUSED_REQUEST> = {
  usageLimitExceeded: 'quota_exhausted',
  unauthorized: 'auth_invalid',
  rateLimitExceeded: 'rate_limit',
  contextWindowExceeded: 'context_overflow',
  badRequest: CODEX_REFUSED_REQUEST,
  // Refusals of this request's content: the next batch may well pass, so
  // drop this one instead of holding every Codex request behind it.
  cyberPolicy: 'unrecoverable',
  misalignmentPolicyViolation: 'unrecoverable',
};

/**
 * Refused by the app-server or the CLI itself before any model saw the
 * request: a JSON-RPC rejection of its shape (-32600 invalid request, -32601
 * method not found, -32602 invalid params), or an older CLI rejecting our
 * flags.
 */
const CODEX_PROTOCOL_REFUSAL = /RPC error -3260[0-2]\b|unexpected argument|unrecognized subcommand|unknown variant/i;

/**
 * The app-server's own JSON-RPC faults (-32603 internal error, -32700 parse
 * error): nothing about the request or the account to act on, whatever the
 * text quotes, so they stay transient.
 */
const CODEX_SERVER_FAULT = /RPC error -(?:32603|32700)\b/;

/** Sessions whose run of app-server faults is tracked at once (oldest dropped). */
const MAX_TRACKED_FAULT_SESSIONS = 256;

const CODEX_REQUEST_REMEDY =
  'Check CLAUDE_MEM_CODEX_MODEL and CLAUDE_MEM_CODEX_REASONING_EFFORT in ~/.claude-mem/settings.json '
  + "(leave them empty for Codex's defaults) and update the Codex CLI.";

const CODEX_ISOLATION_REMEDY =
  'Codex loaded instructions or MCP servers that the memory observer cannot switch off. Remove them from '
  + 'your Codex configuration, update the Codex CLI, or choose another observer provider.';

/** Maps the app-server's structured CodexErrorInfo, which is more stable than its display text. */
function classifyCodexErrorInfo(info: unknown): CodexErrorKind | typeof CODEX_REFUSED_REQUEST | null {
  if (typeof info === 'string') return CODEX_ERROR_INFO_KINDS[info] ?? null;
  if (!info || typeof info !== 'object') return null;
  const [detail] = Object.values(info as Record<string, unknown>);
  const status = (detail as { httpStatusCode?: unknown } | null)?.httpStatusCode;
  if (typeof status !== 'number') return null;
  if (status === 401 || status === 403) return 'auth_invalid';
  if (status === 429) return 'rate_limit';
  // A request timeout is the one 4xx a retry can clear.
  if (status >= 400 && status < 500 && status !== 408) return CODEX_REFUSED_REQUEST;
  return null;
}

export function classifyCodexError(cause: unknown): ClassifiedProviderError {
  const message = cause instanceof Error ? cause.message : String(cause);
  const code = (cause as { code?: unknown } | null)?.code;
  const structuredKind = classifyCodexErrorInfo((cause as { codexErrorInfo?: unknown } | null)?.codexErrorInfo);
  let kind: CodexErrorKind = 'transient';
  let action: string | undefined;
  if (code === CODEX_NO_AGENT_MESSAGE_CODE) {
    // Its diagnostic counts must not be read as an HTTP status.
    kind = 'transient';
  } else if (code === CODEX_ISOLATION_UNATTESTED_CODE) {
    kind = 'setup_required';
    action = CODEX_ISOLATION_REMEDY;
  } else if (structuredKind && structuredKind !== CODEX_REFUSED_REQUEST) {
    kind = structuredKind;
  } else if (CODEX_SERVER_FAULT.test(message)) {
    // Whatever its text quotes (a usage limit, a login, a parser), a fault of
    // the app-server neither arms the account breaker nor holds capture
    // behind the setup gate.
    kind = 'transient';
  } else if (code === CODEX_SETUP_REQUIRED_CODE || code === 'ENOENT' || /executable not found|command not found|ENOENT/i.test(message)) {
    // Fixed on this machine (install the CLI, `codex login`), never by retrying.
    kind = 'setup_required';
  } else if (/not logged in|codex login|unauthorized|authentication|ChatGPT auth|requires Codex CLI|\b40[13]\b/i.test(message)) {
    kind = 'auth_invalid';
  } else if (/usage limit|quota|insufficient credits|plan limit|billing/i.test(message)) {
    kind = 'quota_exhausted';
  } else if (/rate limit|\b429\b/i.test(message)) {
    kind = 'rate_limit';
  } else if (/context (length|window)|prompt (is )?too long/i.test(message)) {
    kind = 'context_overflow';
  } else if (structuredKind === CODEX_REFUSED_REQUEST || CODEX_PROTOCOL_REFUSAL.test(message)) {
    // Refused the same way until the settings or the CLI change: a setup
    // failure, held behind the codex_cli gate and shown at SessionStart,
    // never a transport blip resumed forever.
    kind = 'setup_required';
    action = CODEX_REQUEST_REMEDY;
  }
  return new ClassifiedProviderError(`Codex: ${message.slice(0, 500)}`, { kind, cause, ...(action ? { action } : {}) });
}

/**
 * The refusal an armed Codex breaker stands for, so a request it withholds
 * pauses its session exactly as the request that armed it did.
 */
function cooldownRefusal(cooldown: QuotaCooldownState): ClassifiedProviderError {
  const kind: CodexErrorKind = cooldown.cause === 'auth'
    ? 'auth_invalid'
    : cooldown.window === 'rate_limit' ? 'rate_limit' : 'quota_exhausted';
  return new ClassifiedProviderError(cooldown.message, { kind, cause: null, code: CODEX_COOLDOWN_REFUSAL_CODE });
}

/**
 * Arm the shared breaker (or the codex_cli setup gate) before the app-server
 * releases its queue, so a request another session queued behind this one is
 * withheld instead of earning the same refusal. The session runner books the
 * failure again when it reaches it; re-arming within the same moment is a
 * no-op in effect.
 */
function publishCodexFailure(error: ClassifiedProviderError): void {
  if (error.code === CODEX_COOLDOWN_REFUSAL_CODE) return;
  switch (error.kind) {
    case 'quota_exhausted':
      recordQuotaExhausted('codex', error.message);
      logger.warn('SDK', 'Codex usage limit reached; pausing Codex requests until a quota probe succeeds', {
        message: error.message,
      });
      break;
    case 'auth_invalid':
      recordAuthCooldown('codex', error.message);
      logger.warn('SDK', 'Codex refused the ChatGPT login; pausing Codex requests until a probe succeeds', {
        message: error.message,
      });
      break;
    case 'setup_required':
      recordCodexCliSetupRequired(error.message, error.action);
      logger.warn('SDK', 'Codex CLI or login is not set up; pausing Codex starts until a recovery probe succeeds', {
        message: error.message,
      });
      break;
  }
}

/** Native subscription transport using the existing observer session lifecycle. */
export class CodexProvider extends OpenAICompatibleProvider<CodexConfig> {
  protected readonly providerName = 'Codex';
  protected readonly syntheticIdPrefix = 'codex';
  protected readonly forwardEmptyMessageResponse = true;
  /** Per session: app-server faults since its last served request (see query). */
  private readonly serverFaultsBySession = new Map<number, number>();
  private readonly appServer = new CodexAppServerPool(boundedInteger(
    SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH).CLAUDE_MEM_CODEX_MAX_CONCURRENT_AGENTS, 2, 8,
  ));

  async close(): Promise<void> {
    await this.appServer.close();
  }

  protected getConfig(): CodexConfig {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    const codexPath = settings.CLAUDE_MEM_CODEX_PATH.trim() || 'codex';
    if (process.platform === 'win32' && /[\0\r\n&|<>()^%!\"]/.test(codexPath)) {
      throw new Error('CLAUDE_MEM_CODEX_PATH contains unsafe shell characters');
    }
    return {
      // The shared lifecycle expects a credential marker; auth stays in Codex CLI.
      apiKey: 'codex-subscription',
      model: settings.CLAUDE_MEM_CODEX_MODEL.trim(),
      codexPath,
      reasoningEffort: settings.CLAUDE_MEM_CODEX_REASONING_EFFORT.trim() || null,
    };
  }

  protected override readonly rejectAbortedObservation = true;

  /**
   * A Codex backlog would pay one round trip, and one full history replay on
   * a fresh ephemeral thread, per observation. Claim the queued observations
   * already at the FIFO head that share this one's prompt number, agent and
   * cwd into the same turn, within a count and character budget, without
   * waiting for more. The claimed ids ride on the session, so the normal
   * confirm/reset acknowledges or preserves the whole batch.
   */
  protected override observationTurnPrompt(session: ActiveSession, first: PendingMessageWithId, prompt: ObservationPromptParts): string {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    const count = boundedInteger(settings.CLAUDE_MEM_CODEX_OBSERVATION_BATCH_SIZE, 8, 32);
    const configuredChars = boundedInteger(settings.CLAUDE_MEM_CODEX_OBSERVATION_BATCH_MAX_CHARS, 32_000, 128_000);
    const maxChars = configuredChars >= 4_000 ? configuredChars : 32_000;
    let combined = boundObservationPrompt(prompt, maxChars, observationMetadata(first));
    for (let size = 1; size < count; size++) {
      let addition = '';
      const next = this.sessionManager.claimNextObservation(session.sessionDbId, candidate => {
        if (!sameObservationContext(first, candidate)) return false;
        // Do not add an oversized field that would need its own compression pass.
        if ([candidate.tool_input, candidate.tool_response].some(field =>
          (JSON.stringify(field, null, 2) ?? '').length > OBS_PROMPT_FIELD_MAX_CHARS)) return false;
        const rawChars = JSON.stringify([candidate.tool_input, candidate.tool_response]).length;
        addition = queuedObservationPrompt(candidate);
        return Math.max(rawChars, addition.length) + combined.length + 2 <= maxChars;
      });
      if (!next) break;
      combined += '\n\n' + addition;
    }
    return combined;
  }

  protected missingApiKeyError(): Error {
    return new Error('Sign in to Codex CLI with codex login');
  }

  protected estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  protected buildLastUsage(result: ProviderQueryResult): ActiveSession['lastUsage'] {
    return {
      input: result.inputTokens ?? 0,
      output: result.outputTokens ?? 0,
    };
  }

  protected prepareSessionExtras(session: ActiveSession, config: CodexConfig): void {
    config.signal = session.abortController.signal;
    config.sessionDbId = session.sessionDbId;
    session.lastModelId = config.model || 'codex-default';
  }

  /**
   * One request on the persistent app-server. `signal` (a field condensation
   * racing its own deadline) is honoured alongside the session's, and the
   * per-attempt deadline is the observer's CLAUDE_MEM_LLM_TIMEOUT_MS unless
   * the caller passes its own (the field pass does).
   */
  protected async query(
    history: ConversationMessage[],
    config: CodexConfig,
    signal?: AbortSignal,
    perAttemptTimeoutMs?: number,
  ): Promise<ProviderQueryResult> {
    const abortSignal = config.signal && signal
      ? AbortSignal.any([config.signal, signal])
      : signal ?? config.signal;
    const timeoutMs = perAttemptTimeoutMs ?? resolveLlmTimeoutMs();
    const prompt = [
      'You are the claude-mem memory compression worker. Use only the supplied conversation; do not call tools.',
      'Follow the latest user request: XML for observations/summaries, plain text for payload compression.',
      ...history.map(message => `${message.role.toUpperCase()}:\n${message.content}`),
    ].join('\n\n');
    // Pool slots run concurrently: a success may only clear the breaker or
    // setup status it was admitted under, never a newer failure another slot
    // recorded meanwhile (each record installs a new object).
    const admittedQuota = getQuotaCooldown('codex');
    const admittedSetup = getDependencyStatus('codex_cli');
    let result: CodexAppServerTurnResult;
    try {
      result = await this.runTurnWithRetry(prompt, config, timeoutMs, abortSignal);
    } catch (error) {
      this.noteServerFault(error, config.sessionDbId);
      // A turn that completes without any agent message gets withRetry's one
      // retry. A second one is passed on as an empty reply, for the skip
      // contract to settle, rather than pausing the batch as a transport fault
      // again and again.
      if (!isClassified(error) || (error.cause as { code?: unknown } | null)?.code !== CODEX_NO_AGENT_MESSAGE_CODE) {
        throw error;
      }
      logger.warn('SDK', 'Codex completed twice without an agent message; passing an empty reply on', {
        message: error.message,
      });
      return { content: '' };
    }
    if (config.sessionDbId !== undefined) this.serverFaultsBySession.delete(config.sessionDbId);
    // A served request is the recovery probe succeeding.
    const quota = getQuotaCooldown('codex');
    if (quota && quota === admittedQuota) clearQuotaCooldown('codex');
    if (getDependencyStatus('codex_cli') === admittedSetup) clearDependencyStatus('codex_cli');
    return result;
  }

  /**
   * An app-server internal fault is transient: the session resumes on the
   * transport backoff, which has no cap off the cmem gateway. From the second
   * in a row for the same session, say at WARN what keeps failing and how many
   * times, so a fault that never clears is not lost among routine retry lines.
   * Counted per session: another session's served request does not hide one
   * whose own requests keep failing.
   */
  private noteServerFault(error: unknown, sessionDbId: number | undefined): void {
    if (sessionDbId === undefined) return;
    if (!isClassified(error) || error.kind !== 'transient' || !CODEX_SERVER_FAULT.test(error.message)) return;
    const consecutive = (this.serverFaultsBySession.get(sessionDbId) ?? 0) + 1;
    this.serverFaultsBySession.delete(sessionDbId);
    this.serverFaultsBySession.set(sessionDbId, consecutive);
    if (this.serverFaultsBySession.size > MAX_TRACKED_FAULT_SESSIONS) {
      const oldest = this.serverFaultsBySession.keys().next().value;
      if (oldest !== undefined) this.serverFaultsBySession.delete(oldest);
    }
    if (consecutive < 2) return;
    logger.warn('SDK', 'Codex app-server keeps failing with an internal error; retrying on the transport backoff', {
      sessionId: sessionDbId,
      consecutive,
      message: error.message,
    });
  }

  private runTurnWithRetry(
    prompt: string,
    config: CodexConfig,
    timeoutMs: number,
    abortSignal: AbortSignal | undefined,
  ): Promise<CodexAppServerTurnResult> {
    return withRetry(async attemptSignal => {
      try {
        return await this.appServer.runTurn({
          codexPath: config.codexPath,
          model: config.model,
          reasoningEffort: config.reasoningEffort,
          timeoutMs,
          prompt,
          signal: attemptSignal,
          // Rechecked after the wait for the serialized app-server: the request
          // this one queued behind may have found setup broken or armed the
          // breaker.
          beforeSend: () => {
            attemptSignal.throwIfAborted();
            const setup = getDependencyStatus('codex_cli');
            if (setup && isDependencyStatusInCooldown(setup, CODEX_CLI_SETUP_RECHECK_COOLDOWN_MS)) {
              throw new ClassifiedProviderError(setup.message, {
                kind: 'setup_required', cause: null, code: CODEX_COOLDOWN_REFUSAL_CODE,
              });
            }
            const cooldown = getQuotaCooldown('codex');
            if (cooldown && isQuotaCooldownActive('codex')) throw cooldownRefusal(cooldown);
          },
          onFailure: error => {
            if (attemptSignal.aborted) return;
            publishCodexFailure(isClassified(error) ? error : classifyCodexError(error));
          },
        });
      } catch (error) {
        if (attemptSignal.aborted || isClassified(error)) throw error;
        throw classifyCodexError(error);
      }
    }, { label: 'Codex', maxRetries: 1, perAttemptTimeoutMs: timeoutMs, abortSignal });
  }
}

export function isCodexSelected(): boolean {
  return SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH).CLAUDE_MEM_PROVIDER === 'codex';
}
