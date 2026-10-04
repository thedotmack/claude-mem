/**
 * The "secret stream" for OpenAI-shaped `/chat/completions` providers
 * (OpenRouter, openai-compatible): the request is sent with `stream: true`, so
 * the backend proves it is alive with every token and every `:` ping, and a
 * silence — not a guessed wall-clock deadline — is what ends a request. The
 * streamed deltas are assembled back into the non-streamed `chat.completion`
 * shape, so callers parse exactly what they parsed before.
 *
 * Outcomes ("never pay twice", retry.ts):
 *  - transport failure (network, idle timeout, stream ended early) before any
 *    output: ambiguous, flagged `failedBeforeOutput` so withRetry may resend it
 *    once against the batch's PaidSendBudget;
 *  - the same failure after output started, or an unreadable chunk: an output
 *    failure, never resent;
 *  - an `{error}` object inside the stream: classified exactly like a 200 that
 *    carried one before output started, an output failure after.
 *
 * A backend that ignores `stream: true` and answers with one JSON body is read
 * as before. A strict backend that refuses the streaming fields with a 400 (a
 * refusal before work, so free) is resent once without them, and that endpoint
 * is not asked to stream again for the life of the process. The cmem gateway is
 * never asked to stream (it streams nothing upstream) and keeps withRetry's
 * per-attempt deadline.
 */

import { readSseEvents } from '../../shared/sse-reader.js';
import { fetchStreamWithIdleTimeout } from '../../shared/worker-utils.js';
import { isCmemGatewayUrl } from '../../shared/cmem-gateway.js';
import { isMaxCompletionTokensCompatibilityError } from '../../shared/openrouter-token-compatibility.js';
import { ClassifiedProviderError, MAX_ERROR_BODY_BYTES } from './provider-errors.js';
import { MAX_LLM_TIMEOUT_MS } from './retry.js';
import { logger } from '../../utils/logger.js';

/** Silence after which a streamed LLM request is given up (no token, no ping). */
export const DEFAULT_LLM_STREAM_IDLE_TIMEOUT_MS = 90_000;

/** `code` on a streamed reply that broke off after output had started. */
export const STREAM_INTERRUPTED_CODE = 'stream_interrupted';

/** The streamed-request body fields: usage arrives on the final chunk. */
export const STREAMED_REQUEST_FIELDS = { stream: true, stream_options: { include_usage: true } } as const;

/**
 * Endpoints that refused `stream` / `stream_options` with a 400 during this
 * process. They are sent the plain non-streamed body from then on.
 */
const endpointsThatRefuseStreaming = new Set<string>();

/** Endpoints already warned about for a stream with no usage chunk; warned once each. */
const endpointsWarnedForMissingStreamUsage = new Set<string>();

/** A 400 body naming the streaming fields: the endpoint does not accept them. */
const STREAMING_FIELD_REFUSAL_PATTERN = /\b(stream|stream_options|include_usage)\b/i;

export function isStreamingFieldRefusal(status: number, bodyText: string): boolean {
  return status === 400 && STREAMING_FIELD_REFUSAL_PATTERN.test(bodyText);
}

/** Test hook: forget which endpoints refused streaming and which were warned about. */
export function resetStreamingEndpointMemoryForTests(): void {
  endpointsThatRefuseStreaming.clear();
  endpointsWarnedForMissingStreamUsage.clear();
}

/**
 * Whether requests to this endpoint are streamed. The cmem gateway calls its
 * upstream with stream:false and answers with one JSON body after the whole
 * reply, so an idle timer there would only measure its latency. An endpoint
 * that refused the streaming fields earlier in this process is not streamed.
 */
export function streamsChatCompletion(apiUrl: string): boolean {
  return !isCmemGatewayUrl(apiUrl) && !endpointsThatRefuseStreaming.has(apiUrl);
}

function withoutStreamingFields(body: Record<string, unknown>): Record<string, unknown> {
  const { stream: _ignoredStream, stream_options: _ignoredStreamOptions, ...plainBody } = body;
  return plainBody;
}

export interface StreamLiveness {
  idleTimeoutMs: number;
  absoluteCapMs: number;
}

/**
 * Liveness for one streamed request. A caller racing its own deadline (the
 * field pass) passes it as the absolute cap; otherwise the cap is the largest
 * value CLAUDE_MEM_LLM_TIMEOUT_MS may take — a ceiling, not a guess.
 */
export function resolveStreamLiveness(
  callerDeadlineMs: number | undefined,
  idleTimeoutMs: number = DEFAULT_LLM_STREAM_IDLE_TIMEOUT_MS,
): StreamLiveness {
  return { idleTimeoutMs, absoluteCapMs: callerDeadlineMs ?? MAX_LLM_TIMEOUT_MS };
}

export interface ChatCompletionClassifyInput {
  status?: number;
  bodyText?: string;
  headers?: Headers;
  cause: unknown;
}

export interface ChatCompletionRequest {
  url: string;
  headers: Record<string, string>;
  /** The request body without the output cap; `max_tokens` is added here. */
  body: Record<string, unknown>;
  maxOutputTokens: number;
  signal: AbortSignal;
  /**
   * Set: stream under these liveness rules (withRetry arms no deadline). Null:
   * one JSON body under withRetry's per-attempt deadline. Decide it once per
   * query, so every attempt of one withRetry loop is bounded the same way.
   */
  liveness: StreamLiveness | null;
  /** Names the provider in error messages. */
  label: string;
  /** The provider's classifier, for HTTP errors, network errors and in-stream error objects. */
  classify: (input: ChatCompletionClassifyInput) => ClassifiedProviderError;
}

/** The non-streamed `chat.completion` shape a streamed reply is assembled into. */
export interface AssembledChatCompletion {
  id?: string;
  model?: string;
  choices: Array<{
    message: { role: 'assistant'; content: string };
    finish_reason?: string;
  }>;
  usage?: Record<string, unknown>;
}

export interface ChatCompletionExchange {
  status: number;
  headers: Headers;
  /** The parsed JSON reply, or the stream assembled into the same shape. */
  body: Record<string, unknown>;
  streamed: boolean;
}

interface OpenedExchange {
  status: number;
  ok: boolean;
  headers: Headers;
  chunks: AsyncIterable<Uint8Array>;
}

interface StreamChunk {
  id?: unknown;
  model?: unknown;
  usage?: unknown;
  error?: { code?: unknown; message?: unknown } | null;
  choices?: Array<{
    delta?: { content?: unknown; reasoning?: unknown; reasoning_content?: unknown; tool_calls?: unknown } | null;
    finish_reason?: unknown;
  }>;
}

const STREAM_DONE_SENTINEL = '[DONE]';

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function isEventStream(headers: Headers): boolean {
  return (headers.get('content-type') ?? '').toLowerCase().includes('text/event-stream');
}

/** The text of a content delta: a string, or OpenAI-style text blocks. */
function deltaText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part): part is { type: 'text'; text: string } =>
      part !== null && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string')
    .map(part => part.text)
    .join('');
}

function isNonEmpty(value: unknown): boolean {
  if (typeof value === 'string') return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return value !== null && value !== undefined;
}

function outputFailure(message: string, cause: unknown, code?: string): ClassifiedProviderError {
  return new ClassifiedProviderError(message, {
    kind: 'unrecoverable',
    paidSendOutcome: 'output_failure',
    cause,
    ...(code ? { code } : {}),
  });
}

async function* responseChunks(response: Response): AsyncGenerator<Uint8Array> {
  if (!response.body) return;
  const reader = response.body.getReader();
  let finished = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) { finished = true; return; }
      yield value;
    }
  } finally {
    if (!finished) await reader.cancel();
    reader.releaseLock();
  }
}

/**
 * Send one request. A failure before any response is classified here. A
 * non-streamed send for a caller that owns the deadline (an endpoint that
 * refused streaming) gets no idle window — a JSON reply is silent until done —
 * only the absolute cap.
 */
async function openExchange(
  request: ChatCompletionRequest,
  body: Record<string, unknown>,
  streamThisSend: boolean,
): Promise<OpenedExchange> {
  const init: RequestInit = {
    method: 'POST',
    headers: request.headers,
    body: JSON.stringify(body),
    signal: request.signal,
  };
  try {
    if (request.liveness) {
      const liveness = streamThisSend
        ? request.liveness
        : { idleTimeoutMs: request.liveness.absoluteCapMs, absoluteCapMs: request.liveness.absoluteCapMs };
      return await fetchStreamWithIdleTimeout(request.url, init, liveness);
    }
    // Called on globalThis, so a runtime whose fetch needs its receiver gets it.
    const response = await globalThis.fetch(request.url, init);
    return { status: response.status, ok: response.ok, headers: response.headers, chunks: responseChunks(response) };
  } catch (networkError: unknown) {
    const classified = request.classify({ cause: asError(networkError) });
    if (streamThisSend && !request.signal.aborted) classified.failedBeforeOutput = true;
    throw classified;
  }
}

/** Read a non-streamed body: capped for an error, whole for a JSON reply. */
async function readBodyText(chunks: AsyncIterable<Uint8Array>, maxBytes: number): Promise<string> {
  const decoder = new TextDecoder();
  let text = '';
  let bytesRead = 0;
  for await (const chunk of chunks) {
    const remainingBytes = maxBytes - bytesRead;
    const part = chunk.byteLength > remainingBytes ? chunk.subarray(0, remainingBytes) : chunk;
    bytesRead += part.byteLength;
    text += decoder.decode(part, { stream: true });
    if (bytesRead >= maxBytes) break;
  }
  return text + decoder.decode();
}

/**
 * POST a chat-completions request and return its reply in the non-streamed
 * shape. Resends once with `max_completion_tokens` when the endpoint refuses
 * `max_tokens` (#4003), exactly as fetchWithOpenRouterTokenCompatibility does
 * for a JSON request, and once without `stream` / `stream_options` when the
 * endpoint refuses those. Both refusals are 400s: refused before work, free.
 */
export async function sendChatCompletion(request: ChatCompletionRequest): Promise<ChatCompletionExchange> {
  const { max_tokens: _ignoredCap, ...bodyWithoutCap } = request.body;
  const bodies = [
    { ...bodyWithoutCap, max_tokens: request.maxOutputTokens },
    { ...bodyWithoutCap, max_completion_tokens: request.maxOutputTokens },
  ];
  // Re-read per send: another query may have learned the endpoint refuses streaming.
  let streamThisSend = request.liveness !== null && streamsChatCompletion(request.url);

  for (let bodyIndex = 0; bodyIndex < bodies.length; bodyIndex++) {
    const body = streamThisSend ? bodies[bodyIndex] : withoutStreamingFields(bodies[bodyIndex]);
    const opened = await openExchange(request, body, streamThisSend);
    if (opened.ok && isEventStream(opened.headers)) {
      return { status: opened.status, headers: opened.headers, body: { ...await assembleStream(opened, request) }, streamed: true };
    }

    let bodyText: string;
    try {
      bodyText = await readBodyText(opened.chunks, opened.ok ? Number.POSITIVE_INFINITY : MAX_ERROR_BODY_BYTES);
    } catch (readError: unknown) {
      if (request.signal.aborted) throw readError;
      if (!opened.ok) throw request.classify({ status: opened.status, bodyText: '', headers: opened.headers, cause: asError(readError) });
      // The response arrived, so the work ran and was billed; only reading its
      // body failed. Never resent.
      throw outputFailure(`${request.label} response body could not be read: ${asError(readError).message}`, readError);
    }

    if (streamThisSend && isStreamingFieldRefusal(opened.status, bodyText)) {
      rememberEndpointRefusesStreaming(request, opened.status, bodyText);
      streamThisSend = false;
      bodyIndex--;
      continue;
    }

    const isLastBody = bodyIndex === bodies.length - 1;
    if (!isLastBody && isMaxCompletionTokensCompatibilityError(opened.status, bodyText)) continue;

    if (!opened.ok) {
      throw request.classify({
        status: opened.status,
        bodyText,
        headers: opened.headers,
        cause: new Error(`${request.label} API error: ${opened.status} - ${bodyText}`),
      });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText);
    } catch (parseError: unknown) {
      throw outputFailure(`${request.label} response body could not be read: ${asError(parseError).message}`, parseError);
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw outputFailure(`${request.label} response body is not a JSON object`, new Error(bodyText.substring(0, 300)));
    }
    return { status: opened.status, headers: opened.headers, body: parsed as Record<string, unknown>, streamed: false };
  }
  // Unreachable: the last body always returns or throws above.
  throw new Error(`${request.label} request produced no reply`);
}

function rememberEndpointRefusesStreaming(request: ChatCompletionRequest, status: number, bodyText: string): void {
  if (endpointsThatRefuseStreaming.has(request.url)) return;
  endpointsThatRefuseStreaming.add(request.url);
  logger.info('SDK', `${request.label} endpoint refused streamed requests; sending it non-streamed for the rest of this process`, {
    url: request.url,
    status,
    body: bodyText.substring(0, 300),
  });
}

/** Read the SSE reply to the end and assemble it into one chat.completion. */
async function assembleStream(opened: OpenedExchange, request: ChatCompletionRequest): Promise<AssembledChatCompletion> {
  let content = '';
  let outputStarted = false;
  let finishReason: string | undefined;
  let usage: Record<string, unknown> | undefined;
  let model: string | undefined;
  let id: string | undefined;
  let sawDone = false;

  try {
    for await (const event of readSseEvents(opened.chunks)) {
      if (event.data === STREAM_DONE_SENTINEL) { sawDone = true; break; }
      if (!event.data) continue;

      let chunk: StreamChunk;
      try {
        chunk = JSON.parse(event.data) as StreamChunk;
      } catch (parseError: unknown) {
        throw outputFailure(`${request.label} stream chunk could not be read: ${asError(parseError).message}`, parseError, STREAM_INTERRUPTED_CODE);
      }
      if (chunk === null || typeof chunk !== 'object') continue;

      if (chunk.error) {
        const errorCode = chunk.error.code;
        const errorMessage = chunk.error.message;
        const classified = request.classify({
          status: opened.status,
          bodyText: JSON.stringify({ error: chunk.error }),
          headers: opened.headers,
          cause: new Error(`${request.label} stream error: ${String(errorCode)} - ${String(errorMessage)}`),
        });
        if (!outputStarted) throw classified;
        throw new ClassifiedProviderError(`${classified.message} (after the reply had started)`, {
          kind: 'unrecoverable',
          paidSendOutcome: 'output_failure',
          cause: classified,
          code: classified.code ?? STREAM_INTERRUPTED_CODE,
          ...(classified.requestId ? { requestId: classified.requestId } : {}),
        });
      }

      if (id === undefined && typeof chunk.id === 'string' && chunk.id) id = chunk.id;
      if (model === undefined && typeof chunk.model === 'string' && chunk.model) model = chunk.model;
      if (chunk.usage && typeof chunk.usage === 'object') usage = chunk.usage as Record<string, unknown>;

      const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
      if (!choice) continue;
      const delta = choice.delta ?? undefined;
      const text = deltaText(delta?.content);
      content += text;
      // Reasoning and tool-call deltas are billed output too: once any arrived,
      // a resend would pay for them again.
      if (text || isNonEmpty(delta?.reasoning) || isNonEmpty(delta?.reasoning_content) || isNonEmpty(delta?.tool_calls)) {
        outputStarted = true;
      }
      if (typeof choice.finish_reason === 'string' && choice.finish_reason) finishReason = choice.finish_reason;
    }
  } catch (streamError: unknown) {
    if (streamError instanceof ClassifiedProviderError) throw streamError;
    if (request.signal.aborted) throw streamError;
    throw transportFailure(streamError, outputStarted, opened, request);
  }

  // A server that closes without `[DONE]` but after a finish_reason finished
  // its reply; one that closes before either broke off.
  if (!sawDone && finishReason === undefined) {
    throw transportFailure(new Error('stream ended before the reply finished'), outputStarted, opened, request);
  }

  // Some OpenAI-compatible servers ignore stream_options.include_usage. The
  // reply is still good; token counts and cost are just unknown (never estimated).
  if (!usage && !endpointsWarnedForMissingStreamUsage.has(request.url)) {
    endpointsWarnedForMissingStreamUsage.add(request.url);
    logger.warn('SDK', `${request.label} streamed reply carried no usage chunk; token counts and cost for this endpoint are not recorded`, {
      url: request.url,
      ...(model ? { model } : {}),
    });
  }

  return {
    ...(id ? { id } : {}),
    ...(model ? { model } : {}),
    choices: [{
      message: { role: 'assistant', content },
      ...(finishReason ? { finish_reason: finishReason } : {}),
    }],
    ...(usage ? { usage } : {}),
  };
}

/**
 * A stream that broke off (idle timeout, reset, early end). Before any output
 * it is classified like a network error and may be resent once; after output
 * started the work ran and was billed, so it is an output failure.
 */
function transportFailure(
  cause: unknown,
  outputStarted: boolean,
  opened: OpenedExchange,
  request: ChatCompletionRequest,
): ClassifiedProviderError {
  const error = asError(cause);
  if (outputStarted) {
    return outputFailure(`${request.label} stream broke off after the reply had started: ${error.message}`, error, STREAM_INTERRUPTED_CODE);
  }
  const classified = request.classify({ cause: error, headers: opened.headers });
  classified.failedBeforeOutput = true;
  return classified;
}
