import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import type { ActiveSession, ConversationMessage } from '../worker-types.js';
import { OpenAICompatibleProvider, type ProviderQueryResult } from './OpenAICompatibleProvider.js';
import { CodexAppServerClient } from './CodexAppServerClient.js';
import { ClassifiedProviderError } from './provider-errors.js';
import { withRetry } from './retry.js';
import { clearQuotaCooldown, getQuotaCooldown, recordQuotaExhausted } from '../../shared/quota-cooldown.js';
import { logger } from '../../utils/logger.js';

interface CodexConfig {
  apiKey: string;
  model: string;
  codexPath: string;
  reasoningEffort: string | null;
  timeoutMs: number;
  signal?: AbortSignal;
  quotaProbeClaimId?: number | null;
  setupProbeClaimId?: number | null;
}

const CODEX_ERROR_INFO_KINDS: Record<string, ConstructorParameters<typeof ClassifiedProviderError>[1]['kind']> = {
  usageLimitExceeded: 'quota_exhausted',
  unauthorized: 'auth_invalid',
  rateLimitExceeded: 'rate_limit',
  contextWindowExceeded: 'context_overflow',
};

/** Maps the app-server's structured CodexErrorInfo, which is more stable than its display text. */
function classifyCodexErrorInfo(info: unknown): ConstructorParameters<typeof ClassifiedProviderError>[1]['kind'] | null {
  if (typeof info === 'string') return CODEX_ERROR_INFO_KINDS[info] ?? null;
  if (!info || typeof info !== 'object') return null;
  const [detail] = Object.values(info as Record<string, unknown>);
  const status = (detail as { httpStatusCode?: unknown } | null)?.httpStatusCode;
  if (status === 401 || status === 403) return 'auth_invalid';
  if (status === 429) return 'rate_limit';
  return null;
}

export function classifyCodexError(cause: unknown): ClassifiedProviderError {
  const message = cause instanceof Error ? cause.message : String(cause);
  const code = (cause as { code?: unknown } | null)?.code;
  const structuredKind = classifyCodexErrorInfo((cause as { codexErrorInfo?: unknown } | null)?.codexErrorInfo);
  let kind: ConstructorParameters<typeof ClassifiedProviderError>[1]['kind'] = 'transient';
  if (structuredKind) {
    kind = structuredKind;
  } else if (code === 'ENOENT' || /executable not found|command not found|ENOENT/i.test(message)) {
    kind = 'unrecoverable';
  } else if (/not logged in|codex login|unauthorized|authentication|ChatGPT auth|requires Codex CLI|\b40[13]\b/i.test(message)) {
    kind = 'auth_invalid';
  } else if (/usage limit|quota|insufficient credits|plan limit|billing/i.test(message)) {
    kind = 'quota_exhausted';
  } else if (/rate limit|\b429\b/i.test(message)) {
    kind = 'rate_limit';
  } else if (/context (length|window)|prompt (is )?too long/i.test(message)) {
    kind = 'context_overflow';
  }
  return new ClassifiedProviderError(`Codex: ${message.slice(0, 500)}`, { kind, cause });
}

/** Native subscription transport using the existing observer session lifecycle. */
export class CodexProvider extends OpenAICompatibleProvider<CodexConfig> {
  protected readonly providerName = 'Codex';
  protected readonly syntheticIdPrefix = 'codex';
  protected readonly forwardEmptyMessageResponse = true;
  private readonly appServer = new CodexAppServerClient();

  async close(): Promise<void> {
    await this.appServer.close();
  }

  protected getConfig(): CodexConfig {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    const codexPath = settings.CLAUDE_MEM_CODEX_PATH.trim() || 'codex';
    if (process.platform === 'win32' && /[\0\r\n&|<>()^%!\"]/.test(codexPath)) {
      throw new Error('CLAUDE_MEM_CODEX_PATH contains unsafe shell characters');
    }
    const timeout = Number(settings.CLAUDE_MEM_CODEX_TIMEOUT_MS);
    return {
      // The shared lifecycle expects a credential marker; auth stays in Codex CLI.
      apiKey: 'codex-subscription',
      model: settings.CLAUDE_MEM_CODEX_MODEL.trim(),
      codexPath,
      reasoningEffort: settings.CLAUDE_MEM_CODEX_REASONING_EFFORT.trim() || null,
      timeoutMs: Number.isSafeInteger(timeout) && timeout > 0 ? timeout : 120_000,
    };
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
    config.quotaProbeClaimId = session.quotaProbeClaimId;
    config.setupProbeClaimId = session.codexSetupProbeClaimId;
    session.lastModelId = config.model || 'codex-default';
  }

  protected async query(history: ConversationMessage[], config: CodexConfig, callerSignal?: AbortSignal): Promise<ProviderQueryResult> {
    const abortSignal = config.signal && callerSignal
      ? AbortSignal.any([config.signal, callerSignal])
      : callerSignal ?? config.signal;
    const prompt = [
      'You are the claude-mem memory compression worker. Use only the supplied conversation; do not call tools.',
      'Follow the latest user request: XML for observations/summaries, plain text for payload compression.',
      ...history.map(message => `${message.role.toUpperCase()}:\n${message.content}`),
    ].join('\n\n');
    try {
      const result = await withRetry(async signal => {
        try {
          return await this.appServer.runTurn({
            codexPath: config.codexPath,
            model: config.model,
            reasoningEffort: config.reasoningEffort,
            timeoutMs: config.timeoutMs,
            prompt,
            signal,
            beforeSend: () => {
              signal.throwIfAborted();
              const setup = getQuotaCooldown('codex-setup');
              if (setup && (setup.probeClaimId == null || setup.probeClaimId !== config.setupProbeClaimId)) {
                throw new ClassifiedProviderError('Codex setup cooldown is active', { kind: 'setup_paused', cause: null });
              }
              const cooldown = getQuotaCooldown('codex');
              if (cooldown && (cooldown.probeClaimId == null || cooldown.probeClaimId !== config.quotaProbeClaimId)) {
                throw new ClassifiedProviderError('Codex quota cooldown is active', { kind: 'quota_paused', cause: null });
              }
            },
            onFailure: error => {
              if (signal.aborted) return;
              const classified = error instanceof ClassifiedProviderError ? error : classifyCodexError(error);
              if (classified.kind === 'unrecoverable' || classified.kind === 'auth_invalid') {
                recordQuotaExhausted('codex-setup', classified.message);
                logger.warn('SDK', 'Codex setup failure; pausing Codex requests until a recovery probe succeeds', {
                  kind: classified.kind,
                  message: classified.message,
                });
              }
            },
          });
        } catch (error) {
          if (signal.aborted || error instanceof ClassifiedProviderError) throw error;
          throw classifyCodexError(error);
        }
      }, { label: 'Codex', maxRetries: 1, perAttemptTimeoutMs: config.timeoutMs, abortSignal });
      clearQuotaCooldown('codex');
      clearQuotaCooldown('codex-setup');
      return result;
    } catch (error) {
      if (error instanceof ClassifiedProviderError && error.kind === 'quota_exhausted') {
        recordQuotaExhausted('codex', error.message);
        logger.warn('SDK', 'Codex usage limit reached; pausing Codex requests until a quota probe succeeds', {
          message: error.message,
        });
      }
      throw error;
    }
  }
}

export function isCodexSelected(): boolean {
  return SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH).CLAUDE_MEM_PROVIDER === 'codex';
}
