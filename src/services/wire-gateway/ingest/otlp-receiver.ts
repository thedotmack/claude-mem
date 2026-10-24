// SPDX-License-Identifier: Apache-2.0
//
// The OTLP/HTTP JSON receiver `POST /v1/traces` (plan Phase 13 task 2,
// report 07 §2.7–2.8). magpie users and OpenTelemetry GenAI emitters feed
// claude-mem by pointing their exporter here; protobuf is answered 415.
//
// Each span is one of:
// - magpie bodies (`langfuse.observation.input` / `.output`). magpie sets
//   them in two places, verified in source at e297a8ab2 (plan §0.8):
//   * its gateway's per-attempt span (internal/gateway/otel.go:109-151,
//     usage/otel_wire.go:66-110): kind CLIENT, `gen_ai.request.model`,
//     `gen_ai.provider.name`, `magpie.agent`, `http.response.status_code`,
//     the request body as sent and the reply (a stream reduced to its text
//     by `otelReplyText`, usage/otel_wire.go:275-324), each scrubbed and
//     ending "\n… (cut here by magpie)" when cut. No session id: the
//     session comes from the body, as on the wire (resolve-identity.ts).
//   * its session poller's spans (usage/otel_sessions.go:84-98, 109-171;
//     sessions/traces.go:134-141, 394-411; otel_wire.go:146-178): kind
//     INTERNAL, `magpie.agent`, `langfuse.session.id` (the agent's own
//     session), `langfuse.observation.type` = `span` (a whole interaction:
//     the user's prompt in, the final answer out), `generation` (a model
//     reply in that interaction) or `tool` (the span's name is the tool,
//     input its arguments, output its result). These are not protocol
//     bodies; they map to the assembler directly.
// - GenAI semantic-convention messages (`gen_ai.input.messages` /
//   `gen_ai.output.messages`, and the deprecated `gen_ai.prompt` /
//   `gen_ai.completion`, whole or as indexed `gen_ai.prompt.<n>.role|content`
//   attributes): parts `text`, `tool_call`, `tool_call_response`,
//   `reasoning`. The agent is the resource's `service.name`, the session
//   `gen_ai.conversation.id`.
// - anything else: metadata only, counted and ignored.
//
// A span whose bodies cannot be read is rejected: the answer is 200 with
// `partialSuccess{rejectedSpans, errorMessage}`, which a client must not retry.
// A fault in claude-mem itself is logged and answered 503, which it retries.

import { logger } from '../../../utils/logger.js';
import { DEFAULT_REQUEST_BODY_IDLE_TIMEOUT_MS, decodeRequestBodyCopy, readBoundedRequestBody } from '../relay/request-body.js';
import type { WireProtocol } from '../relay/protocols.js';
import { WireRequestParseError, parseWireRequest } from '../ir/request-parsers.js';
import { JsonScanError } from '../json/scanner.js';
import { collectWireReply } from '../ir/reply-collectors.js';
import type { WireReply, WireRequest } from '../ir/types.js';
import { foreignExchangeOf, parseJsonText, type ForeignMessage, type ForeignPart } from './foreign-exchange.js';
import {
  claudeMemAgentIdOfMagpieAgent,
  type CaptureSourceRuleOptions,
  type OtherCaptureSourceCheck,
  type WireForeignCapture,
} from './foreign-capture.js';

/** The OTLP spec's recommended request limit; a larger body gets 413 (report 07 §2.7, opentelemetry-proto specification "OTLP/HTTP Throttling"). */
export const OTLP_MAX_BODY_BYTES = 64 * 1024 * 1024;

/** What protobuf (or any other content type) is told (plan Phase 13 task 2). */
export const OTLP_PROTOBUF_REFUSAL = 'send OTLP/HTTP JSON (OTEL_EXPORTER_OTLP_PROTOCOL=http/json)';

/** How magpie ends a body it kept only the start of (magpie usage/otel_wire.go:327 `BodyCut`). */
export const MAGPIE_BODY_CUT_SUFFIX = '\n… (cut here by magpie)';

/** google.rpc.Code INVALID_ARGUMENT, the status of a request that is not an OTLP JSON export (report 07 §2.7, "Failure"). */
const RPC_CODE_INVALID_ARGUMENT = 3;
/** google.rpc.Code UNAVAILABLE, the status of a request the receiver could not take for now. */
const RPC_CODE_UNAVAILABLE = 14;

// ---------------------------------------------------------------------------
// OTLP JSON shapes (opentelemetry-proto trace.proto, common.proto)

interface OtlpKeyValue { key?: unknown; value?: unknown }
interface OtlpSpan {
  traceId?: unknown;
  spanId?: unknown;
  name?: unknown;
  kind?: unknown;
  attributes?: unknown;
  status?: { code?: unknown };
}

/** An AnyValue as plain JS: kvlists become objects, arrays arrays, int64 strings numbers (report 07 §2.7). */
export function anyValueToJs(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return undefined;
  const anyValue = value as Record<string, unknown>;
  if ('stringValue' in anyValue) return typeof anyValue.stringValue === 'string' ? anyValue.stringValue : undefined;
  if ('boolValue' in anyValue) return anyValue.boolValue === true;
  if ('intValue' in anyValue) {
    const parsed = Number(anyValue.intValue);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  if ('doubleValue' in anyValue) {
    const parsed = Number(anyValue.doubleValue);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  if ('arrayValue' in anyValue) {
    const values = (anyValue.arrayValue as { values?: unknown } | null)?.values;
    return Array.isArray(values) ? values.map(anyValueToJs) : [];
  }
  if ('kvlistValue' in anyValue) {
    const values = (anyValue.kvlistValue as { values?: unknown } | null)?.values;
    return attributesToMap(values).asObject();
  }
  if ('bytesValue' in anyValue) return typeof anyValue.bytesValue === 'string' ? anyValue.bytesValue : undefined;
  return undefined;
}

class Attributes {
  constructor(private readonly values: Map<string, unknown>) {}
  get(key: string): unknown { return this.values.get(key); }
  string(key: string): string | undefined {
    const value = this.values.get(key);
    return typeof value === 'string' && value !== '' ? value : undefined;
  }
  number(key: string): number | undefined {
    const value = this.values.get(key);
    return typeof value === 'number' ? value : undefined;
  }
  has(key: string): boolean { return this.values.has(key); }
  keys(): IterableIterator<string> { return this.values.keys(); }
  asObject(): Record<string, unknown> { return Object.fromEntries(this.values); }
}

function attributesToMap(list: unknown): Attributes {
  const values = new Map<string, unknown>();
  if (Array.isArray(list)) {
    for (const entry of list as OtlpKeyValue[]) {
      if (entry && typeof entry.key === 'string') values.set(entry.key, anyValueToJs(entry.value));
    }
  }
  return new Attributes(values);
}

// ---------------------------------------------------------------------------
// Protocol bodies (magpie's gateway spans)

/**
 * The protocol a request body is in, from its shape: Gemini has `contents`;
 * Responses has `input` (or `instructions` without `messages`); a `messages`
 * body is Anthropic when it carries Anthropic-only things (a top-level
 * `system`, content blocks typed tool_use/tool_result/thinking), else Chat.
 * Null when it is none of these.
 */
export function protocolOfRequestBody(body: unknown, providerHint?: string): WireProtocol | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  if (Array.isArray(record.contents)) return 'gemini';
  if ('input' in record || ('instructions' in record && !('messages' in record))) return 'openai-responses';
  if (!Array.isArray(record.messages)) return null;
  if ('system' in record) return 'anthropic';
  for (const message of record.messages as Array<Record<string, unknown>>) {
    if (message?.role === 'system' || message?.role === 'tool' || message?.role === 'developer' || 'tool_calls' in (message ?? {})) return 'openai-chat';
    if (Array.isArray(message?.content)) {
      for (const block of message.content as Array<Record<string, unknown>>) {
        const type = block?.type;
        if (type === 'tool_use' || type === 'tool_result' || type === 'thinking' || type === 'redacted_thinking') return 'anthropic';
        if (type === 'image_url' || type === 'input_audio') return 'openai-chat';
      }
    }
  }
  return providerHint?.toLowerCase().startsWith('anthropic') ? 'anthropic' : 'openai-chat';
}

function withoutMagpieCut(text: string): { text: string; cut: boolean } {
  return text.endsWith(MAGPIE_BODY_CUT_SUFFIX)
    ? { text: text.slice(0, -MAGPIE_BODY_CUT_SUFFIX.length), cut: true }
    : { text, cut: false };
}

/** A reply body as magpie exports it: a JSON reply, an SSE stream, or the stream's text alone. */
function replyOfMagpieOutput(protocol: WireProtocol, output: string, status: number): { reply: WireReply; cut: boolean } {
  const { text, cut } = withoutMagpieCut(output);
  const bytes = new TextEncoder().encode(text);
  const trimmed = text.trim();
  // Whole JSON is a JSON reply; anything else (a cut body, a stream, its text) is read below.
  if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && parseJsonText(trimmed).ok) {
    return { reply: collectWireReply(protocol, 'application/json', [bytes]), cut };
  }
  if (/^data:/m.test(text)) return { reply: collectWireReply(protocol, 'text/event-stream', [bytes]), cut };
  // otelReplyText reduced the stream to its text: no tool calls, no usage.
  const failed = status >= 400;
  return {
    reply: {
      text, toolCalls: [], thinking: '',
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cacheWrite1hTokens: 0, reasoningTokens: 0 },
      stop: failed || cut ? null : 'stop',
      endedCleanly: !failed && !cut,
      ...(failed && text !== '' ? { error: text } : {}),
    },
    cut,
  };
}

// ---------------------------------------------------------------------------
// GenAI semantic-convention messages

/** Text of a GenAI part's value (`content`, `response`, `arguments`): a string as it is, anything else as JSON. */
function textOf(value: unknown): string {
  if (value === undefined || value === null) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** Messages given as JSON text, structured attributes, or one plain string (deprecated `gen_ai.prompt`). */
function genAiMessagesOf(value: unknown, defaultRole: 'user' | 'assistant'): unknown[] | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') {
    const parsed = parseJsonText(value);
    if (parsed.ok && Array.isArray(parsed.value)) return parsed.value;
    if (parsed.ok && parsed.value !== null && typeof parsed.value === 'object') return [parsed.value];
    // Not JSON messages: a plain prompt string (the deprecated gen_ai.prompt / gen_ai.completion).
    return [{ role: defaultRole, content: value }];
  }
  if (Array.isArray(value)) return value;
  return null;
}

function genAiPartsOf(message: Record<string, unknown>): ForeignPart[] {
  const parts: ForeignPart[] = [];
  if (Array.isArray(message.parts)) {
    for (const raw of message.parts as Array<Record<string, unknown>>) {
      if (!raw || typeof raw !== 'object') continue;
      switch (raw.type) {
        case 'text':
          parts.push({ kind: 'text', text: textOf(raw.content) });
          break;
        case 'reasoning':
          parts.push({ kind: 'thinking', text: textOf(raw.content) });
          break;
        case 'tool_call':
          parts.push({ kind: 'tool_call', name: textOf(raw.name), argsJson: textOf(raw.arguments) || '{}', ...(typeof raw.id === 'string' && raw.id ? { callId: raw.id } : {}) });
          break;
        case 'tool_call_response':
          parts.push({ kind: 'tool_result', text: textOf(raw.response ?? raw.result), ...(typeof raw.id === 'string' && raw.id ? { callId: raw.id } : {}) });
          break;
        case 'blob':
        case 'uri':
        case 'file':
          if (raw.modality === 'image') parts.push({ kind: 'image' });
          break;
        default:
          break;
      }
    }
  } else if (message.content !== undefined) {
    // Older shapes: {role, content} (OpenAI-like), with tool_calls beside.
    const role = message.role;
    if (role === 'tool') parts.push({ kind: 'tool_result', text: textOf(message.content), ...(typeof message.tool_call_id === 'string' ? { callId: message.tool_call_id } : {}) });
    else if (textOf(message.content) !== '') parts.push({ kind: 'text', text: textOf(message.content) });
  }
  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls as Array<Record<string, unknown>>) {
      const fn = (call?.function ?? call) as Record<string, unknown>;
      parts.push({ kind: 'tool_call', name: textOf(fn.name), argsJson: textOf(fn.arguments) || '{}', ...(typeof call?.id === 'string' ? { callId: call.id } : {}) });
    }
  }
  return parts;
}

function foreignMessagesOf(raw: unknown[], defaultRole: 'user' | 'assistant'): ForeignMessage[] {
  const messages: ForeignMessage[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const message = entry as Record<string, unknown>;
    const role = message.role === 'system' || message.role === 'user' || message.role === 'assistant' || message.role === 'tool' ? message.role : defaultRole;
    messages.push({ role, parts: genAiPartsOf(message) });
  }
  return messages;
}

/** The deprecated indexed form: gen_ai.prompt.<n>.role / .content (and gen_ai.completion.<n>.…). */
function indexedGenAiMessages(attributes: Attributes, prefix: 'gen_ai.prompt' | 'gen_ai.completion'): unknown[] | null {
  const byIndex = new Map<number, Record<string, unknown>>();
  const pattern = new RegExp(`^${prefix.replace('.', '\\.')}\\.(\\d+)\\.(role|content|tool_call_id)$`);
  for (const key of attributes.keys()) {
    const match = pattern.exec(key);
    if (!match) continue;
    const index = Number(match[1]);
    const message = byIndex.get(index) ?? {};
    message[match[2]] = attributes.get(key);
    byIndex.set(index, message);
  }
  if (byIndex.size === 0) return null;
  return [...byIndex.entries()].sort(([a], [b]) => a - b).map(([, message]) => message);
}

// ---------------------------------------------------------------------------
// The receiver

/** Content-free counters for `wire status`. */
export const otlpActivity = { postsAnswered: 0, postsFailed: 0, spansCaptured: 0, spansMetadataOnly: 0, spansRejected: 0, spansSkippedOtherSource: 0 };

export interface OtlpExportResult {
  captured: number;
  metadataOnly: number;
  skippedOtherSource: number;
  rejected: number;
  /** Why the first rejected span was rejected. */
  firstRejection?: string;
}

class SpanRejection extends Error {}

interface SpanContext {
  serviceName: string | undefined;
  span: OtlpSpan;
  attributes: Attributes;
}

function statusOf(context: SpanContext): number {
  const status = context.attributes.number('http.response.status_code');
  if (status !== undefined && status >= 100 && status <= 599) return status;
  return Number(context.span.status?.code) === 2 ? 500 : 200;
}

function spanName(span: OtlpSpan): string {
  return typeof span.name === 'string' ? span.name : '';
}

function spanIdOf(span: OtlpSpan): string {
  return typeof span.spanId === 'string' ? span.spanId.toLowerCase() : '';
}

export class OtlpTraceReceiver {
  constructor(
    private readonly capture: WireForeignCapture,
    private readonly captureSourceRule: CaptureSourceRuleOptions = {},
  ) {}

  /** Map an `ExportTraceServiceRequest` (already parsed JSON) into capture. Throws on a body that is not one. */
  export(request: unknown): OtlpExportResult {
    if (request === null || typeof request !== 'object' || Array.isArray(request)) {
      throw new SpanRejection('the body is not an ExportTraceServiceRequest object');
    }
    const result: OtlpExportResult = { captured: 0, metadataOnly: 0, skippedOtherSource: 0, rejected: 0 };
    const otherCaptureSource = this.capture.checkForBatch(this.captureSourceRule);
    const resourceSpans = (request as { resourceSpans?: unknown }).resourceSpans;
    if (resourceSpans === undefined) return result; // an empty export is a success (report 07 §2.7)
    if (!Array.isArray(resourceSpans)) throw new SpanRejection('resourceSpans must be an array');
    for (const resourceSpan of resourceSpans as Array<Record<string, unknown>>) {
      const resourceAttributes = attributesToMap((resourceSpan?.resource as { attributes?: unknown } | undefined)?.attributes);
      const serviceName = resourceAttributes.string('service.name');
      const scopeSpans = resourceSpan?.scopeSpans;
      if (!Array.isArray(scopeSpans)) continue;
      for (const scopeSpan of scopeSpans as Array<Record<string, unknown>>) {
        const spans = scopeSpan?.spans;
        if (!Array.isArray(spans)) continue;
        for (const span of spans as OtlpSpan[]) {
          const context: SpanContext = { serviceName, span, attributes: attributesToMap(span?.attributes) };
          try {
            const outcome = this.exportSpan(context, otherCaptureSource);
            if (outcome === 'captured') result.captured++;
            else if (outcome === 'metadata_only') result.metadataOnly++;
            else result.skippedOtherSource++;
          } catch (error) {
            // Only a span that cannot be read is rejected (and not retried by the client).
            // Anything else is a fault here: it is thrown on, answered 503 so the exporter retries.
            if (!(error instanceof SpanRejection)) throw error;
            result.rejected++;
            result.firstRejection ??= `span ${spanIdOf(span) || spanName(span) || '(unnamed)'}: ${error.message}`;
            // Rejection reasons never quote a body (parseJsonText, JsonScanError and WireRequestParseError say what, not where).
            logger.warn('WIRE', 'OTLP span rejected', { spanId: spanIdOf(span), reason: error.message });
          }
        }
      }
    }
    otlpActivity.spansCaptured += result.captured;
    otlpActivity.spansMetadataOnly += result.metadataOnly;
    otlpActivity.spansRejected += result.rejected;
    otlpActivity.spansSkippedOtherSource += result.skippedOtherSource;
    return result;
  }

  private exportSpan(context: SpanContext, otherCaptureSource: OtherCaptureSourceCheck): 'captured' | 'metadata_only' | 'skipped_other_source' {
    const { attributes } = context;
    if (attributes.has('langfuse.observation.input') || attributes.has('langfuse.observation.output')) {
      // A session span is routed by its kind before anything looks at its input:
      // a tool span's input is the tool's own arguments, which may well hold
      // `input`, `messages` or `contents` (magpie sessions/traces.go:394-400).
      return attributes.string('langfuse.session.id') !== undefined
        ? this.exportLangfuseSessionSpan(context, otherCaptureSource)
        : this.exportLangfuseGatewaySpan(context, otherCaptureSource);
    }
    const genAiInput = genAiMessagesOf(attributes.get('gen_ai.input.messages'), 'user')
      ?? genAiMessagesOf(attributes.get('gen_ai.prompt'), 'user')
      ?? indexedGenAiMessages(attributes, 'gen_ai.prompt');
    const genAiOutput = genAiMessagesOf(attributes.get('gen_ai.output.messages'), 'assistant')
      ?? genAiMessagesOf(attributes.get('gen_ai.completion'), 'assistant')
      ?? indexedGenAiMessages(attributes, 'gen_ai.completion');
    if (genAiInput || genAiOutput) return this.exportGenAiSpan(context, genAiInput ?? [], genAiOutput, otherCaptureSource);
    return 'metadata_only';
  }

  /** The agent a span with langfuse bodies names, and whether magpie sent it (every magpie span carries `magpie.agent`, its resource `service.name` is "magpie": usage/otel_wire.go:35, 51). */
  private langfuseSpanAgent(context: SpanContext): { agentId: string; fromMagpie: boolean } {
    const agentName = context.attributes.string('magpie.agent') ?? context.serviceName;
    if (!agentName) throw new SpanRejection('a span with langfuse bodies names no agent (magpie.agent or service.name)');
    return {
      agentId: claudeMemAgentIdOfMagpieAgent(agentName),
      fromMagpie: context.attributes.has('magpie.agent') || context.serviceName === 'magpie',
    };
  }

  private modelOf(attributes: Attributes): string {
    return attributes.string('gen_ai.request.model') ?? attributes.string('magpie.requested_model') ?? '';
  }

  /** magpie's gateway span: the request body as sent and its reply. */
  private exportLangfuseGatewaySpan(context: SpanContext, otherCaptureSource: OtherCaptureSourceCheck): 'captured' | 'skipped_other_source' {
    const { attributes } = context;
    const { agentId, fromMagpie } = this.langfuseSpanAgent(context);
    const status = statusOf(context);
    const model = this.modelOf(attributes);
    const { text: inputText, cut: inputCut } = withoutMagpieCut(attributes.string('langfuse.observation.input') ?? '');
    const output = attributes.string('langfuse.observation.output') ?? '';
    const parsedInput = parseJsonText(inputText);
    const protocol = parsedInput.ok
      ? protocolOfRequestBody(parsedInput.value, attributes.string('gen_ai.provider.name') ?? attributes.string('gen_ai.system'))
      : null;
    if (!protocol) {
      throw new SpanRejection(inputText.trim() === ''
        ? 'its langfuse bodies have no request and the span names no langfuse.session.id'
        : `its langfuse.observation.input is neither a model request body (${parsedInput.ok ? 'JSON of no known protocol' : parsedInput.error}${inputCut ? ', cut by magpie' : ''}) nor part of a session (no langfuse.session.id)`);
    }
    let request: WireRequest;
    try {
      request = parseWireRequest(protocol, new TextEncoder().encode(inputText));
    } catch (error) {
      // These two say what is wrong without quoting the body; anything else is a bug here, and is thrown on.
      if (error instanceof JsonScanError || error instanceof WireRequestParseError) {
        throw new SpanRejection(`its ${protocol} request body does not parse: ${error.message}`);
      }
      throw error;
    }
    if (!request.model && model) request.model = model;
    const { reply, cut: outputCut } = output === '' ? { reply: null, cut: false } : replyOfMagpieOutput(protocol, output, status);
    const replyIsWhole = reply !== null && status < 400 && !outputCut && reply.endedCleanly && reply.error === undefined;
    return this.capture.observeExchange({
      source: 'otlp',
      channel: fromMagpie ? 'magpie_gateway_span' : 'otlp_other',
      agentId,
      request,
      reply,
      replyIsWhole,
      // A stream reduced to its text hides its tool calls: a reply that says something and calls nothing ends the turn.
      finalReply: replyIsWhole && !inputCut && reply.toolCalls.length === 0 && reply.text !== '',
    }, otherCaptureSource);
  }

  /** magpie's session poller (usage/otel_sessions.go): not protocol bodies, whatever their text looks like. */
  private exportLangfuseSessionSpan(context: SpanContext, otherCaptureSource: OtherCaptureSourceCheck): 'captured' | 'skipped_other_source' {
    const { attributes, span } = context;
    const { agentId, fromMagpie } = this.langfuseSpanAgent(context);
    const sessionId = attributes.string('langfuse.session.id')!;
    const observationType = attributes.string('langfuse.observation.type');
    const channel = fromMagpie ? 'magpie_session_span' : 'otlp_other';
    const { text: inputText, cut: inputCut } = withoutMagpieCut(attributes.string('langfuse.observation.input') ?? '');
    const { text: outputText, cut: outputCut } = withoutMagpieCut(attributes.string('langfuse.observation.output') ?? '');
    if (observationType === 'tool') {
      return this.capture.observeToolRun({
        source: 'otlp',
        channel,
        agentId,
        sessionId,
        // magpie's span ids are derived from the agent's call id (sessions/traces.go traceSpanID), so a span sent twice keeps its id.
        callId: `magpie-${spanIdOf(span) || spanName(span)}`,
        toolName: spanName(span) || 'tool',
        argsText: inputText || '{}',
        resultText: outputText,
      }, otherCaptureSource);
    }
    if (observationType === 'span' || observationType === 'generation') {
      const exchange = foreignExchangeOf({
        system: [],
        messages: inputText === '' ? [] : [{ role: 'user', parts: [{ kind: 'text', text: inputText }] }],
        output: [{ kind: 'text', text: outputText }],
        model: this.modelOf(attributes),
        status: statusOf(context),
        cut: inputCut || outputCut,
        callIdScope: [agentId, sessionId],
        callIdPrefix: 'otlp',
      });
      return this.capture.observeExchange({
        source: 'otlp',
        channel,
        agentId,
        sessionId,
        request: exchange.request,
        reply: exchange.reply,
        replyIsWhole: exchange.replyIsWhole,
        // The interaction span is the turn's end: it is sent once the interaction finished (otel_sessions.go offerSession).
        finalReply: observationType === 'span' && exchange.replyIsWhole,
      }, otherCaptureSource);
    }
    throw new SpanRejection(`langfuse.observation.type ${JSON.stringify(observationType ?? '')} is not one magpie's session spans use (span, generation, tool)`);
  }

  private exportGenAiSpan(context: SpanContext, input: unknown[], output: unknown[] | null, otherCaptureSource: OtherCaptureSourceCheck): 'captured' | 'skipped_other_source' {
    const { attributes } = context;
    const agentId = context.serviceName ?? attributes.string('gen_ai.agent.name');
    if (!agentId) throw new SpanRejection('a GenAI span names no agent: set the resource attribute service.name');
    const sessionId = attributes.string('gen_ai.conversation.id');
    const status = statusOf(context);
    const systemInstructions = genAiMessagesOf(attributes.get('gen_ai.system_instructions'), 'user');
    const system = (systemInstructions ?? []).map(entry => {
      const record = entry as Record<string, unknown>;
      return record?.type === 'text' || record?.content !== undefined ? textOf(record.content) : textOf(entry);
    });
    const outputMessages = output === null ? null : foreignMessagesOf(output, 'assistant');
    const exchange = foreignExchangeOf({
      system,
      messages: foreignMessagesOf(input, 'user'),
      output: outputMessages === null ? null : outputMessages.flatMap(message => message.parts),
      model: attributes.string('gen_ai.response.model') ?? attributes.string('gen_ai.request.model') ?? '',
      status,
      cut: false,
      callIdScope: [agentId, sessionId ?? ''],
      callIdPrefix: 'otlp',
    });
    if (exchange.request.messages.length === 0 && exchange.reply === null) {
      throw new SpanRejection('its GenAI messages hold nothing readable');
    }
    return this.capture.observeExchange({
      source: 'otlp',
      channel: 'otlp_other',
      agentId,
      ...(sessionId ? { sessionId } : {}),
      request: exchange.request,
      reply: exchange.reply,
      replyIsWhole: exchange.replyIsWhole,
      finalReply: exchange.replyIsWhole && exchange.reply !== null && exchange.reply.toolCalls.length === 0,
    }, otherCaptureSource);
  }
}

function otlpFailure(status: number, message: string): Response {
  // google.rpc.Status in its JSON form (report 07 §2.7 "Failure").
  return Response.json({ code: RPC_CODE_INVALID_ARGUMENT, message }, { status });
}

export function createOtlpTracesHandler(options: { receiver: OtlpTraceReceiver; requestBodyIdleTimeoutMs?: number }): (request: Request) => Promise<Response> {
  return async function handleOtlpTraces(request: Request): Promise<Response> {
    if (request.method !== 'POST') return otlpFailure(405, 'POST /v1/traces only');
    const mediaType = (request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (mediaType !== 'application/json') return otlpFailure(415, OTLP_PROTOBUF_REFUSAL);
    const bodyRead = await readBoundedRequestBody(request, {
      maxRequestBytes: OTLP_MAX_BODY_BYTES,
      idleTimeoutMs: options.requestBodyIdleTimeoutMs ?? DEFAULT_REQUEST_BODY_IDLE_TIMEOUT_MS,
    });
    if (bodyRead.kind === 'too_large') return otlpFailure(413, `the export is over ${OTLP_MAX_BODY_BYTES} bytes; send smaller batches`);
    if (bodyRead.kind === 'idle_timeout') return otlpFailure(408, `the body stalled for ${Math.round(bodyRead.idleTimeoutMs / 1000)} s`);
    const decoded = decodeRequestBodyCopy(bodyRead.body, request.headers.get('content-encoding'), OTLP_MAX_BODY_BYTES);
    if (decoded.kind === 'skipped') {
      return decoded.reason === 'decoded_too_large'
        ? otlpFailure(413, `the decoded export is over ${OTLP_MAX_BODY_BYTES} bytes; send smaller batches`)
        : otlpFailure(415, `content-encoding "${decoded.contentEncoding}" could not be decoded (${decoded.reason}); send it uncompressed or gzip`);
    }
    const parsed = parseJsonText(new TextDecoder().decode(decoded.bytes));
    if (!parsed.ok) return otlpFailure(400, `the body is ${parsed.error}`);
    let result: OtlpExportResult;
    try {
      result = options.receiver.export(parsed.value);
    } catch (error) {
      if (error instanceof SpanRejection) return otlpFailure(400, error.message);
      // A fault in claude-mem, not in the export: logged, and answered 503, which
      // OTLP exporters retry (report 07 §2.7 "Retryable Response Codes": 429,
      // 502, 503, 504; a 500 is not retried). Spans of this export captured
      // before the fault are observed again on the retry; the assembler keeps
      // a tool run once per call id, and a turn's summary once per turn.
      logger.error('WIRE', 'OTLP export could not be captured: a fault in claude-mem; answered 503 so the exporter retries', {},
        error instanceof Error ? error : new Error(String(error)));
      otlpActivity.postsFailed++;
      return Response.json({ code: RPC_CODE_UNAVAILABLE, message: 'claude-mem could not capture this export (see its log); retry' }, { status: 503 });
    }
    otlpActivity.postsAnswered++;
    if (result.rejected === 0) return Response.json({});
    // int64 fields are decimal strings in OTLP JSON (report 07 §2.7).
    return Response.json({
      partialSuccess: {
        rejectedSpans: String(result.rejected),
        errorMessage: `${result.rejected} span(s) could not be read; the first: ${result.firstRejection}`,
      },
    });
  };
}
