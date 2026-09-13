/**
 * OpenRouter chat client with tool-calling.
 *
 * This is the OpenAI-compatible /chat/completions surface, the same one
 * claude-mem's OpenRouterProvider uses, extended with `tools`/`tool_calls`
 * (the observation provider is single-shot text; the SWE-bench agent needs a
 * multi-turn tool loop). Headers, usage accounting, and error classification
 * mirror the plugin so behavior against openrouter.ai and custom gateways is
 * consistent.
 */
import type {
  ChatCompletion,
  ChatMessage,
  ChatProvider,
  TokenUsage,
  ToolCall,
  ToolDefinition,
} from './types.ts';
import type { OpenRouterConfig } from './config.ts';

interface RawChoice {
  message?: {
    role?: string;
    content?: string | null;
    tool_calls?: ToolCall[];
  };
  finish_reason?: string;
}

interface RawResponse {
  model?: string;
  choices?: RawChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    cost?: number;
    cost_details?: { upstream_inference_cost?: number };
  };
  error?: { message?: string; code?: string | number };
}

export class OpenRouterError extends Error {
  constructor(
    message: string,
    readonly kind: 'auth' | 'rate_limit' | 'quota' | 'bad_request' | 'transient' | 'unrecoverable',
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'OpenRouterError';
  }
}

/** Boundary classifier — same taxonomy as the plugin's classifyOpenRouterError. */
export function classifyError(status: number | undefined, bodyText: string, retryAfter?: string | null): OpenRouterError {
  const lower = bodyText.toLowerCase();
  const retryAfterMs = parseRetryAfterMs(retryAfter);
  if (lower.includes('quota exceeded') || lower.includes('insufficient credits') || lower.includes('insufficient_quota')) {
    return new OpenRouterError(`OpenRouter quota exhausted (status ${status ?? '?'})`, 'quota', status);
  }
  if (status === 429) return new OpenRouterError('OpenRouter rate limit (429)', 'rate_limit', 429, retryAfterMs);
  if (status === 401 || status === 403) return new OpenRouterError(`OpenRouter auth error (status ${status})`, 'auth', status);
  if (status === 400 || status === 404) return new OpenRouterError(`OpenRouter bad request (status ${status}): ${bodyText.slice(0, 200)}`, 'bad_request', status);
  if (status !== undefined && status >= 500) return new OpenRouterError(`OpenRouter upstream error (status ${status})`, 'transient', status);
  if (status === undefined) return new OpenRouterError(`OpenRouter network error: ${bodyText.slice(0, 200)}`, 'transient');
  return new OpenRouterError(`OpenRouter API error (status ${status}): ${bodyText.slice(0, 200)}`, 'unrecoverable', status);
}

export function parseRetryAfterMs(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const asSeconds = Number(value);
  if (Number.isFinite(asSeconds)) return Math.max(0, asSeconds * 1000);
  const asDate = Date.parse(value);
  if (Number.isFinite(asDate)) return Math.max(0, asDate - Date.now());
  return undefined;
}

export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_RETRY: RetryOptions = { maxAttempts: 5, baseDelayMs: 2000 };

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class OpenRouterProvider implements ChatProvider {
  readonly modelName: string;

  constructor(
    private readonly config: OpenRouterConfig,
    private readonly retry: RetryOptions = DEFAULT_RETRY,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.modelName = config.model;
  }

  async complete(input: { messages: ChatMessage[]; tools: ToolDefinition[]; signal?: AbortSignal }): Promise<ChatCompletion> {
    if (!this.config.apiKey) {
      throw new OpenRouterError(
        'OpenRouter API key not configured. Set CLAUDE_MEM_OPENROUTER_API_KEY (or OPENROUTER_API_KEY).',
        'auth',
      );
    }
    const body = JSON.stringify({
      model: this.config.model,
      messages: input.messages,
      ...(input.tools.length > 0 ? { tools: input.tools, tool_choice: 'auto' } : {}),
      temperature: this.config.temperature,
      max_tokens: this.config.maxTokens,
      ...(this.config.apiUrl.includes('openrouter.ai') ? { usage: { include: true } } : {}),
    });

    const sleep = this.retry.sleep ?? defaultSleep;
    let lastError: OpenRouterError | undefined;

    for (let attempt = 1; attempt <= this.retry.maxAttempts; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(this.config.apiUrl, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
            'HTTP-Referer': this.config.siteUrl,
            'X-Title': this.config.appName,
            'Content-Type': 'application/json',
          },
          body,
          signal: input.signal,
        });
      } catch (networkError) {
        lastError = classifyError(undefined, networkError instanceof Error ? networkError.message : String(networkError));
        if (attempt < this.retry.maxAttempts) { await sleep(this.retry.baseDelayMs * 2 ** (attempt - 1)); continue; }
        throw lastError;
      }

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const err = classifyError(res.status, text, res.headers.get('retry-after'));
        lastError = err;
        if ((err.kind === 'transient' || err.kind === 'rate_limit') && attempt < this.retry.maxAttempts) {
          await sleep(err.retryAfterMs ?? this.retry.baseDelayMs * 2 ** (attempt - 1));
          continue;
        }
        throw err;
      }

      const data = (await res.json()) as RawResponse;
      if (data.error) {
        const err = classifyError(res.status, `${data.error.code ?? ''} ${data.error.message ?? ''}`);
        lastError = err;
        if (err.kind === 'transient' && attempt < this.retry.maxAttempts) {
          await sleep(this.retry.baseDelayMs * 2 ** (attempt - 1));
          continue;
        }
        throw err;
      }

      return this.toCompletion(data);
    }

    throw lastError ?? new OpenRouterError('OpenRouter request failed after retries', 'transient');
  }

  private toCompletion(data: RawResponse): ChatCompletion {
    const choice = data.choices?.[0];
    const rawMsg = choice?.message ?? {};
    const message: ChatMessage = {
      role: 'assistant',
      content: rawMsg.content ?? null,
      ...(rawMsg.tool_calls && rawMsg.tool_calls.length > 0 ? { tool_calls: rawMsg.tool_calls } : {}),
    };
    const usage: TokenUsage = {
      inputTokens: data.usage?.prompt_tokens ?? 0,
      outputTokens: data.usage?.completion_tokens ?? 0,
      totalTokens: data.usage?.total_tokens ?? 0,
      ...(computeCost(data) !== undefined ? { costUsd: computeCost(data) } : {}),
    };
    return { message, finishReason: choice?.finish_reason ?? 'stop', usage };
  }
}

function computeCost(data: RawResponse): number | undefined {
  const or = typeof data.usage?.cost === 'number' ? data.usage.cost : undefined;
  const upstream = typeof data.usage?.cost_details?.upstream_inference_cost === 'number'
    ? data.usage.cost_details.upstream_inference_cost
    : undefined;
  if (or === undefined && upstream === undefined) return undefined;
  return (or ?? 0) + (upstream ?? 0);
}

export function emptyUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  const costA = a.costUsd ?? 0;
  const costB = b.costUsd ?? 0;
  const hasCost = a.costUsd !== undefined || b.costUsd !== undefined;
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    ...(hasCost ? { costUsd: costA + costB } : {}),
  };
}
