// SPDX-License-Identifier: Apache-2.0
//
// Memory injection at the wire (plan Phase 12 task 1, D7): claude-mem's
// context goes once into a conversation born under the gateway, at the END
// of its system prompt, and is put back byte for byte on every later
// request (and after a restart) from the conversation ledger.
//
// The rules, each from the plan:
// - Only the conversation's FIRST request fetches. If that fetch fails, or
//   the stage was off then, the ledger says `injection: null` and the
//   conversation is never injected: injecting on resume broke the prompt
//   cache before (cb53f9d48, §0.5).
// - Append, never prepend: Claude Code's attribution block stays the first
//   system block, untouched, and block-form system is never made a string
//   (report 07 §2.2–2.3, code.claude.com llm-gateway). An array gets a new
//   text block with no cache_control, so the breakpoint count is unchanged.
//   magpie appends its system lines the same way (provider/
//   factory_client.go:33-264, MIT, Copyright (c) 2026 yetone): idempotent by
//   its marker, twice is once.
// - A string is appended to by an insertion before its closing quote, so
//   every byte the agent wrote stays as it was.
// - The block is wrapped in <claude-mem-context>, which capture already
//   strips (src/utils/tag-stripping.ts), so injected memory never feeds back
//   into memory. A system prompt that already holds that tag (a native
//   integration injected it) is left alone.
// - Once injected, a request that goes without it (the stage turned off)
//   suspends injection for the conversation: putting it back later would
//   change the system prompt mid-conversation (D7.4).
// - When Endless Mode applies to the conversation's first request, the block
//   is not put in the system prompt: it is recorded with placement
//   `timeline` and Endless Mode puts it at the head of its timeline, the
//   first message, which only ever grows at its end (endless-mode-stage.ts).
// - Any failure leaves the bytes as they came (the seam fails open, D7.7).

import { logger } from '../../../utils/logger.js';
import { ScannedObject, objectElements } from '../ir/scanned-object.js';
import type { WireRequest } from '../ir/types.js';
import { applyByteSplices, type ByteSplice } from '../json/byte-splices.js';
import { decodeString, scanDocument, type JsonSpan } from '../json/scanner.js';
import { appendArrayItem, encodeJsonString, insertArrayItem, insertObjectMember, replaceSpan } from '../json/splice.js';
import { jsonEscapeString } from '../json/string-walker.js';
import { requestStartsConversation, type WireConversationLedgerView } from '../ledger/conversation-ledger.js';
import { estimateTextTokens } from '../metrics/context-buckets.js';
import { endlessModeEnabledFor } from '../endless/endless-mode-setting.js';
import type { WireGatewayRoute } from '../routes.js';
import { STAGE_BUDGET_MARGIN_MS, type WireRewriteContext, type WireRewriteStage } from '../rewrite/rewrite-stage.js';
import { fetchMemoryContextFromWorker, type MemoryContextFetcher } from './memory-worker-client.js';

export const MEMORY_INJECTION_STAGE_NAME = 'memory-injection';

/** On for `captureSource: 'wire'` routes unless 'false' (D9); a route's `features.memoryInjection` wins. Read at gateway start. */
export const MEMORY_INJECTION_SETTING = 'CLAUDE_MEM_WIRE_GATEWAY_MEMORY_INJECTION';
/** How long the first request waits for the worker's context. Read at gateway start. */
export const CONTEXT_TIMEOUT_MS_SETTING = 'CLAUDE_MEM_WIRE_GATEWAY_CONTEXT_TIMEOUT_MS';
export const DEFAULT_CONTEXT_TIMEOUT_MS = 1_500;

export const MEMORY_CONTEXT_OPEN_TAG = '<claude-mem-context>';
export const MEMORY_CONTEXT_CLOSE_TAG = '</claude-mem-context>';
/** What goes between the agent's system text and the block when both are one string. */
const STRING_SEPARATOR = '\n\n';

const SUSPENDED_ENTRY_ID = `suspended:${MEMORY_INJECTION_STAGE_NAME}`;

/**
 * Whether a system-prompt stage is on for a route: its own `features[feature]`,
 * else `setting` (on unless 'false'), which covers only routes the gateway
 * captures (`captureSource: 'wire'`); a native route has its integration's
 * own context injection, so it gets this only when its route asks.
 */
export function wireRouteFeatureEnabledFor(
  route: WireGatewayRoute,
  settings: Readonly<Record<string, string>>,
  feature: 'memoryInjection' | 'durableHeader',
  setting: string,
): boolean {
  const own = route.features?.[feature];
  if (own !== undefined) return own;
  return settings[setting] !== 'false' && route.captureSource === 'wire';
}

/** Whether injection is on for a route (wireRouteFeatureEnabledFor). */
export function memoryInjectionEnabledFor(route: WireGatewayRoute, settings: Readonly<Record<string, string>>): boolean {
  return wireRouteFeatureEnabledFor(route, settings, 'memoryInjection', MEMORY_INJECTION_SETTING);
}

/** `text` between `<tagName>` and `</tagName>`, each on its own line: how a stage's system block is appended. */
export function tagWrappedBlock(tagName: string, text: string): string {
  return `<${tagName}>\n${text}\n</${tagName}>`;
}

/** The block as it is appended. */
export function memoryContextBlock(contextText: string): string {
  return tagWrappedBlock('claude-mem-context', contextText);
}

const utf8Encoder = new TextEncoder();

/** `text` inserted at the end of the string at `span` (before its closing quote); every other byte kept. */
function appendToStringSpan(body: Uint8Array, span: JsonSpan, text: string): Uint8Array {
  const splice = appendToStringSplice(body, span, text);
  return splice ? applyByteSplices(body, [splice]) : body;
}

/**
 * The splice appendToStringSpan makes (after a blank line when the string
 * is not empty); null when the string already ends with it. For a caller
 * that applies it together with other splices of the same bytes.
 */
export function appendToStringSplice(body: Uint8Array, span: JsonSpan, text: string): ByteSplice | null {
  const existing = decodeString(body, span);
  const appended = existing === '' ? text : `${STRING_SEPARATOR}${text}`;
  if (existing.endsWith(appended) || existing === text) return null;
  const at = span.end - 1;
  return { start: at, end: at, replacement: utf8Encoder.encode(jsonEscapeString(appended)) };
}

/** `text` as a text block of the protocol: a Gemini part, a Responses input_text, else a text block. */
export function textBlockJson(protocol: WireRequest['protocol'], text: string): string {
  const encoded = encodeJsonString(text);
  switch (protocol) {
    case 'gemini':
      return `{"text":${encoded}}`;
    case 'openai-responses':
      return `{"type":"input_text","text":${encoded}}`;
    default:
      return `{"type":"text","text":${encoded}}`;
  }
}

/** The body with `block` appended at the end of its system prompt (see the table in plan Phase 12 task 1). */
export function appendToSystemPrompt(request: WireRequest, block: string): Uint8Array {
  const body = request.body;
  const root = new ScannedObject(body, scanDocument(body));
  switch (request.protocol) {
    case 'anthropic': {
      const systemSpan = root.spanOf('system');
      if (systemSpan?.type === 'string') return appendToStringSpan(body, systemSpan, block);
      if (systemSpan?.type === 'array') return appendArrayItem(body, systemSpan, textBlockJson('anthropic', block));
      if (!systemSpan || systemSpan.type === 'null') {
        return systemSpan ? replaceSpan(body, systemSpan, encodeJsonString(block)) : insertObjectMember(body, root.span, 'system', encodeJsonString(block));
      }
      throw new Error(`system is a ${systemSpan.type}`);
    }
    case 'openai-chat': {
      const messagesSpan = root.spanOf('messages');
      if (messagesSpan?.type !== 'array') throw new Error('no messages array');
      const firstSystem = objectElements(body, messagesSpan)
        .find(message => {
          const role = message.string('role');
          return role === 'system' || role === 'developer';
        });
      if (!firstSystem) return insertArrayItem(body, messagesSpan, 0, `{"role":"system","content":${encodeJsonString(block)}}`);
      const contentSpan = firstSystem.spanOf('content');
      if (contentSpan?.type === 'string') return appendToStringSpan(body, contentSpan, block);
      if (contentSpan?.type === 'array') return appendArrayItem(body, contentSpan, textBlockJson('openai-chat', block));
      throw new Error(`the system message's content is a ${contentSpan?.type ?? 'missing value'}`);
    }
    case 'openai-responses': {
      const instructionsSpan = root.spanOf('instructions');
      if (instructionsSpan?.type === 'string') return appendToStringSpan(body, instructionsSpan, block);
      if (!instructionsSpan) return insertObjectMember(body, root.span, 'instructions', encodeJsonString(block));
      if (instructionsSpan.type === 'null') return replaceSpan(body, instructionsSpan, encodeJsonString(block));
      throw new Error(`instructions is a ${instructionsSpan.type}`);
    }
    case 'gemini': {
      const key = root.spanOf('systemInstruction') ? 'systemInstruction' : root.spanOf('system_instruction') ? 'system_instruction' : 'systemInstruction';
      const systemSpan = root.spanOf(key);
      const partJson = textBlockJson('gemini', block);
      if (!systemSpan) return insertObjectMember(body, root.span, key, `{"parts":[${partJson}]}`);
      if (systemSpan.type === 'string') return appendToStringSpan(body, systemSpan, block);
      if (systemSpan.type === 'object') {
        const partsSpan = new ScannedObject(body, systemSpan).spanOf('parts');
        if (partsSpan?.type === 'array') return appendArrayItem(body, partsSpan, partJson);
        if (!partsSpan) return insertObjectMember(body, systemSpan, 'parts', `[${partJson}]`);
      }
      throw new Error(`${key} has no parts array`);
    }
  }
}

/** Whether the request's system prompt already carries claude-mem's context tag. */
function systemHasMemoryContext(request: WireRequest): boolean {
  return request.system.some(part => (part.text ?? '').includes(MEMORY_CONTEXT_OPEN_TAG));
}

export interface MemoryInjectionStageOptions {
  /** CONTEXT_TIMEOUT_MS: how long the first request waits for the worker. */
  contextTimeoutMs?: number;
  /** Test seam; defaults to the worker's /api/context/inject over direct-http. */
  fetchContext?: MemoryContextFetcher;
  now?: () => number;
}

export function createMemoryInjectionStage(options: MemoryInjectionStageOptions = {}): WireRewriteStage {
  const contextTimeoutMs = options.contextTimeoutMs ?? DEFAULT_CONTEXT_TIMEOUT_MS;
  const fetchContext = options.fetchContext ?? (query => fetchMemoryContextFromWorker(query));
  const now = options.now ?? Date.now;

  return {
    name: MEMORY_INJECTION_STAGE_NAME,
    budgetMs: contextTimeoutMs + STAGE_BUDGET_MARGIN_MS,
    enabledFor: memoryInjectionEnabledFor,
    appliesTo: context => context.ledger?.status === 'born' && context.ledger.get(SUSPENDED_ENTRY_ID) === undefined,

    whileOff(ledger: WireConversationLedgerView) {
      if (ledger.status !== 'born' || ledger.get(SUSPENDED_ENTRY_ID)) return;
      const injection = ledger.get('injection');
      if (injection?.type !== 'injection' || injection.text === null) return;
      ledger.record({ type: 'suspended', stage: MEMORY_INJECTION_STAGE_NAME, at: new Date(now()).toISOString() });
      logger.debug('WIRE', 'Memory injection was off for a conversation it had injected; it never injects that conversation again', {
        conversationKey: ledger.conversationKey,
      });
    },

    async onRequest(context: WireRewriteContext, body: Uint8Array) {
      const ledger = context.ledger as WireConversationLedgerView;
      const request = context.requestOf(body);
      let injection = ledger.get('injection');
      if (injection === undefined) {
        // Only the conversation's first request decides; any later one finds
        // a conversation that went without memory, and keeps it so.
        if (!requestStartsConversation(request, context.identity.userTurnOrdinal) || systemHasMemoryContext(request)) {
          ledger.record({ type: 'injection', text: null });
          return undefined;
        }
        const contextText = await fetchedContextOrNull(fetchContext, context, contextTimeoutMs);
        const placement = endlessModeEnabledFor(context.route, context.settings) ? 'timeline' : 'system-prompt';
        injection = ledger.record({ type: 'injection', text: contextText ? memoryContextBlock(contextText) : null, placement });
      }
      if (injection.type !== 'injection' || injection.text === null) return undefined;
      // Endless Mode's timeline carries it (and counts its tokens).
      if (injection.placement === 'timeline') return undefined;
      const injected = appendToSystemPrompt(request, injection.text);
      if (injected === request.body) return undefined;
      context.estimates.injectedTokens += estimateTextTokens(injection.text);
      return injected;
    },
  };
}

/** The worker's context for the agent's folder; null (logged) when there is none or it could not be had in time. */
async function fetchedContextOrNull(fetchContext: MemoryContextFetcher, context: WireRewriteContext, timeoutMs: number): Promise<string | null> {
  const workDir = context.identity.workDir;
  if (!workDir) {
    logger.debug('WIRE', 'Memory injection skipped: the agent\'s folder is unknown', { agentId: context.identity.agentId });
    return null;
  }
  try {
    const text = await fetchContext({ workDir, platformSource: context.identity.agentId, timeoutMs });
    return text.trim() === '' ? null : text.trim();
  } catch (error) {
    logger.debug('WIRE', 'Memory injection skipped: the worker\'s context could not be had; the conversation goes without it', {
      agentId: context.identity.agentId, error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
