// SPDX-License-Identifier: Apache-2.0
//
// The head's own cache breakpoint (Endless Mode v2, the owner's spec: the
// durable header and the timeline are caches). On Anthropic, the gateway's
// last block of the head (the <claude-mem-context> timeline, or the
// <claude-mem-rules> header when there is no timeline) gets a
// `cache_control` marker of its own, so tools + system + header + timeline
// are cached as one entry whatever happens in the messages after them.
//
// The rules, each from Anthropic's prompt caching docs:
// - "You can define up to 4 cache breakpoints": the marker is added only when
//   the request uses fewer (top-level automatic caching takes a slot).
// - "Cache entries with longer TTL must appear before shorter TTLs": the
//   marker's TTL is 1h when a breakpoint after it (the agent's, in the
//   messages) is 1h, else the 5-minute default, and it is added only when
//   every breakpoint before it is at least that long.
// - A marker is not part of the cached prefix: "blocks that were previously
//   marked with a cache_control block are later not marked with this, but
//   they will still be considered a cache hit". Adding it changes no entry
//   the agent's breakpoints write or read; it only writes one more, at the
//   head.
// - Deterministic: the marker and its TTL follow from the request's bytes and
//   the ledger's frozen header and timeline alone, so the same request
//   always gets the same bytes.
// - Only a block the gateway added (its text is the frozen header or
//   timeline) is marked, and only in an array-form system prompt: a string
//   system prompt has no block to mark. OpenAI and Gemini have no explicit
//   breakpoints here, so they are left alone.

import { logger } from '../../../utils/logger.js';
import { ScannedObject } from '../ir/scanned-object.js';
import { arrayElements, objectMembers, scanDocument, type JsonSpan } from '../json/scanner.js';
import { insertObjectMember } from '../json/splice.js';
import type { WireConversationLedgerView } from '../ledger/conversation-ledger.js';
import { memoryInjectionEnabledFor } from '../memory/memory-injection-stage.js';
import type { WireGatewayRoute } from '../routes.js';
import type { WireRewriteContext, WireRewriteStage } from '../rewrite/rewrite-stage.js';
import { durableHeaderEnabledFor, headerInForce } from './durable-header-stage.js';

export const HEAD_CACHE_BREAKPOINT_STAGE_NAME = 'head-cache-breakpoint';

/** Anthropic's limit: "You can define up to 4 cache breakpoints" (prompt caching docs). */
export const ANTHROPIC_MAX_CACHE_BREAKPOINTS = 4;

/** The TTLs Anthropic's cache_control takes; no `ttl` is the 5-minute default. */
type CacheTtl = '5m' | '1h';

/** The TTL of a `cache_control` value; null when it names one this stage does not know (then it adds nothing). */
function ttlOf(bytes: Uint8Array, cacheControlSpan: JsonSpan): CacheTtl | null {
  const ttl = ScannedObject.of(bytes, cacheControlSpan)?.string('ttl') ?? '5m';
  return ttl === '5m' || ttl === '1h' ? ttl : null;
}

/** Every `cache_control` TTL inside the value at `span`, in byte order. */
function cacheControlTtlsIn(bytes: Uint8Array, span: JsonSpan, found: Array<CacheTtl | null> = []): Array<CacheTtl | null> {
  if (span.type === 'object') {
    for (const member of objectMembers(bytes, span)) {
      if (member.key === 'cache_control') found.push(ttlOf(bytes, member.value));
      else cacheControlTtlsIn(bytes, member.value, found);
    }
  } else if (span.type === 'array') {
    for (const element of arrayElements(bytes, span)) cacheControlTtlsIn(bytes, element, found);
  }
  return found;
}

/** The texts of the head blocks the gateway added to this conversation: its frozen header and timeline. */
function gatewayHeadTextsOf(ledger: WireConversationLedgerView): Set<string> {
  const texts = new Set<string>();
  const header = headerInForce(ledger);
  if (header?.text) texts.add(header.text);
  const injection = ledger.get('injection');
  if (injection?.type === 'injection' && injection.text !== null) texts.add(injection.text);
  return texts;
}

/** Whether a stage that adds to the head is on for the route: only then is there a head block to mark. */
function headCacheBreakpointEnabledFor(route: WireGatewayRoute, settings: Readonly<Record<string, string>>): boolean {
  return durableHeaderEnabledFor(route, settings) || memoryInjectionEnabledFor(route, settings);
}

/** The body with the head's breakpoint added; the same bytes when there is no place for one. */
export function withHeadCacheBreakpoint(body: Uint8Array, gatewayHeadTexts: ReadonlySet<string>): Uint8Array {
  if (gatewayHeadTexts.size === 0) return body;
  const root = new ScannedObject(body, scanDocument(body));
  const systemSpan = root.spanOf('system');
  if (systemSpan?.type !== 'array') return body;
  const systemBlocks = [...arrayElements(body, systemSpan)];
  let headIndex = -1;
  systemBlocks.forEach((block, index) => {
    const scanned = ScannedObject.of(body, block);
    if (scanned?.string('type') === 'text' && gatewayHeadTexts.has(scanned.string('text') ?? '')) headIndex = index;
  });
  if (headIndex < 0) return body;
  const headBlock = systemBlocks[headIndex];
  if (ScannedObject.of(body, headBlock)?.spanOf('cache_control')) return body;

  // Render order is tools → system → messages; automatic caching (top-level cache_control) marks the last block.
  const tools = root.spanOf('tools');
  const before = [
    ...(tools ? cacheControlTtlsIn(body, tools) : []),
    ...systemBlocks.slice(0, headIndex).flatMap(block => cacheControlTtlsIn(body, block)),
  ];
  const messages = root.spanOf('messages');
  const topLevel = root.spanOf('cache_control');
  const after = [
    ...systemBlocks.slice(headIndex + 1).flatMap(block => cacheControlTtlsIn(body, block)),
    ...(messages ? cacheControlTtlsIn(body, messages) : []),
    ...(topLevel ? [ttlOf(body, topLevel)] : []),
  ];
  const reason = (() => {
    if (before.length + after.length >= ANTHROPIC_MAX_CACHE_BREAKPOINTS) return `the request already uses ${ANTHROPIC_MAX_CACHE_BREAKPOINTS} breakpoints`;
    if ([...before, ...after].includes(null)) return 'a breakpoint names a TTL other than 5m or 1h';
    return null;
  })();
  if (reason !== null) {
    logger.debug('WIRE', `The head's cache breakpoint was not added: ${reason}`);
    return body;
  }
  const ttl: CacheTtl = after.includes('1h') ? '1h' : '5m';
  if (ttl === '1h' && before.includes('5m')) {
    logger.debug('WIRE', 'The head\'s cache breakpoint was not added: a 5-minute breakpoint comes before a 1-hour one');
    return body;
  }
  return insertObjectMember(body, headBlock, 'cache_control', ttl === '1h' ? '{"type":"ephemeral","ttl":"1h"}' : '{"type":"ephemeral"}');
}

export function createHeadCacheBreakpointStage(): WireRewriteStage {
  return {
    name: HEAD_CACHE_BREAKPOINT_STAGE_NAME,
    enabledFor: headCacheBreakpointEnabledFor,
    appliesTo: context => context.protocol === 'anthropic' && context.ledger?.status === 'born',
    onRequest(context: WireRewriteContext, body: Uint8Array) {
      const marked = withHeadCacheBreakpoint(body, gatewayHeadTextsOf(context.ledger as WireConversationLedgerView));
      return marked === body ? undefined : marked;
    },
  };
}
