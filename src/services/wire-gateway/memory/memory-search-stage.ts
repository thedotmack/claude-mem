// SPDX-License-Identifier: Apache-2.0
//
// The hidden memory_search tool (plan Phase 12 task 2, opt-in, D9): the
// model of a conversation born under the gateway is offered a tool that
// searches claude-mem; when it calls only that tool, the gateway runs the
// search, asks the model again with the result and stitches the rounds into
// the one reply the agent sees (stitch/). The agent never sees the tool,
// its calls or their results, so capture never records them either.
//
// The definition is appended at the END of `tools` on the conversation's
// FIRST request and frozen in the ledger; every later request gets the same
// bytes, and a conversation whose first request went without it never gets
// it (tools change only at a conversation's start, D7.4). Named
// `memory_search`, or `claude_mem_memory_search[_N]` when the agent has a
// tool of that name already (magpie searchTool, gateway/search.go:496-506,
// MIT, Copyright (c) 2026 yetone). Once offered, a request that goes
// without it (the stage turned off) suspends it for the conversation.

import { logger } from '../../../utils/logger.js';
import { ScannedObject, objectElements } from '../ir/scanned-object.js';
import type { WireRequest } from '../ir/types.js';
import { scanDocument } from '../json/scanner.js';
import { appendArrayItem, encodeJsonString, insertObjectMember } from '../json/splice.js';
import { requestStartsConversation, type WireConversationLedgerView } from '../ledger/conversation-ledger.js';
import type { WireProtocol } from '../relay/protocols.js';
import type { WireGatewayRoute } from '../routes.js';
import type { WireReplyStitchInput, WireRewriteContext, WireRewriteStage } from '../rewrite/rewrite-stage.js';
import { searchMemoryInWorker, type MemorySearcher } from './memory-worker-client.js';
import { AnthropicStitcher } from './stitch/anthropic-stitcher.js';
import { GeminiStitcher } from './stitch/gemini-stitcher.js';
import { DEFAULT_KEEPALIVE_INTERVAL_MS, MAX_SEARCH_ROUNDS, hiddenToolLoopStream } from './stitch/hidden-tool-loop.js';
import { OpenAiChatStitcher } from './stitch/openai-chat-stitcher.js';
import { OpenAiResponsesStitcher } from './stitch/openai-responses-stitcher.js';
import type { HiddenToolCall, ProtocolStitcher } from './stitch/stitch-events.js';

export const MEMORY_SEARCH_STAGE_NAME = 'memory-search';

/** Off unless 'true' (D9: it adds billed upstream rounds); a route's `features.memorySearchTool` wins. Read at gateway start. */
export const MEMORY_SEARCH_TOOL_SETTING = 'CLAUDE_MEM_WIRE_GATEWAY_MEMORY_SEARCH_TOOL';

export const MEMORY_SEARCH_TOOL_NAME = 'memory_search';
const RENAMED_TOOL_NAME = 'claude_mem_memory_search';
/** One search may take this long; past it the result says the search failed. */
export const MEMORY_SEARCH_TIMEOUT_MS = 5_000;
const DEFAULT_SEARCH_LIMIT = 5;
const MAX_SEARCH_LIMIT = 20;

const MEMORY_SEARCH_DESCRIPTION = 'Search claude-mem, the user\'s persistent memory of earlier work sessions (what was done, decided, fixed '
  + 'and learned, across projects), for anything that helps with the current task. Returns the matching memories with their IDs. '
  + 'Use it before re-deriving something that may have been worked out before.';
const MEMORY_SEARCH_PARAMETERS = '{"type":"object","properties":{"query":{"type":"string","description":"What to look for"},'
  + '"limit":{"type":"integer","description":"How many memories at most (default 5)"}},"required":["query"]}';

const SUSPENDED_ENTRY_ID = `suspended:${MEMORY_SEARCH_STAGE_NAME}`;

/** Whether the hidden tool is on for a route: its own `features.memorySearchTool`, else the setting (off by default). */
export function memorySearchToolEnabledFor(route: WireGatewayRoute, settings: Readonly<Record<string, string>>): boolean {
  return route.features?.memorySearchTool ?? settings[MEMORY_SEARCH_TOOL_SETTING] === 'true';
}

/** `memory_search`, or a name none of the agent's tools has. */
export function hiddenToolNameFor(agentToolNames: readonly string[]): string {
  const taken = new Set(agentToolNames);
  if (!taken.has(MEMORY_SEARCH_TOOL_NAME)) return MEMORY_SEARCH_TOOL_NAME;
  if (!taken.has(RENAMED_TOOL_NAME)) return RENAMED_TOOL_NAME;
  for (let suffix = 2; ; suffix++) {
    const candidate = `${RENAMED_TOOL_NAME}_${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** The tool's definition in the protocol's own shape (Gemini: one functionDeclarations entry). */
export function memorySearchToolDefinition(protocol: WireProtocol, name: string): string {
  const encodedName = encodeJsonString(name);
  const description = encodeJsonString(MEMORY_SEARCH_DESCRIPTION);
  switch (protocol) {
    case 'anthropic':
      return `{"name":${encodedName},"description":${description},"input_schema":${MEMORY_SEARCH_PARAMETERS}}`;
    case 'openai-chat':
      return `{"type":"function","function":{"name":${encodedName},"description":${description},"parameters":${MEMORY_SEARCH_PARAMETERS}}}`;
    case 'openai-responses':
      return `{"type":"function","name":${encodedName},"description":${description},"parameters":${MEMORY_SEARCH_PARAMETERS}}`;
    case 'gemini':
      return `{"name":${encodedName},"description":${description},"parameters":${MEMORY_SEARCH_PARAMETERS}}`;
  }
}

/** The body with `definitionJson` at the end of its tools (twice is once). */
export function appendToolDefinition(request: WireRequest, definitionJson: string): Uint8Array {
  const body = request.body;
  const root = new ScannedObject(body, scanDocument(body));
  if (request.protocol === 'gemini') {
    const toolsSpan = root.spanOf('tools');
    if (!toolsSpan) return insertObjectMember(body, root.span, 'tools', `[{"functionDeclarations":[${definitionJson}]}]`);
    if (toolsSpan.type !== 'array') throw new Error(`tools is a ${toolsSpan.type}`);
    // Into the last tool that declares functions, so the declarations stay one list.
    const declaring = objectElements(body, toolsSpan).filter(tool => tool.spanOf('functionDeclarations', 'function_declarations')?.type === 'array');
    const last = declaring[declaring.length - 1];
    if (last) return appendArrayItem(body, last.spanOf('functionDeclarations', 'function_declarations')!, definitionJson);
    return appendArrayItem(body, toolsSpan, `{"functionDeclarations":[${definitionJson}]}`);
  }
  // Responses Lite carries its tools in an input item; the parser says where they are.
  const toolsSpan = request.toolsSpan ?? root.spanOf('tools');
  if (!toolsSpan) return insertObjectMember(body, root.span, 'tools', `[${definitionJson}]`);
  if (toolsSpan.type !== 'array') throw new Error(`tools is a ${toolsSpan.type}`);
  return appendArrayItem(body, toolsSpan, definitionJson);
}

function stitcherFor(protocol: WireProtocol, hiddenToolName: string, request: WireRequest): ProtocolStitcher {
  switch (protocol) {
    case 'anthropic':
      return new AnthropicStitcher(hiddenToolName);
    case 'openai-chat':
      return new OpenAiChatStitcher(hiddenToolName);
    case 'openai-responses':
      return new OpenAiResponsesStitcher(hiddenToolName, { storeDisabled: storeIsDisabled(request) });
    case 'gemini':
      return new GeminiStitcher(hiddenToolName);
  }
}

/** Whether a Responses request said `store: false`. */
function storeIsDisabled(request: WireRequest): boolean {
  const root = ScannedObject.of(request.body, scanDocument(request.body));
  return root?.spanOf('store')?.type === 'false';
}

interface SearchContext {
  searcher: MemorySearcher;
  workDir: string | undefined;
  signal: AbortSignal;
  /** Outbound redaction's placeholders back to their values: the search runs here, on what the user really wrote. */
  restorePlaceholders?: (text: string) => string;
}

/** A call's search, never throwing: a bad query or a failed search is a result that says so. */
async function searchForCall(call: HiddenToolCall, { searcher, workDir, signal, restorePlaceholders }: SearchContext): Promise<{ text: string; isError: boolean }> {
  let query = '';
  let limit = DEFAULT_SEARCH_LIMIT;
  try {
    const args = JSON.parse(call.argsJson) as { query?: unknown; limit?: unknown };
    if (typeof args.query === 'string') query = args.query.trim();
    if (typeof args.limit === 'number' && Number.isInteger(args.limit) && args.limit > 0) limit = Math.min(args.limit, MAX_SEARCH_LIMIT);
  } catch {
    return { text: 'memory_search: the arguments are not JSON', isError: true };
  }
  if (query === '') return { text: 'memory_search: query is empty', isError: true };
  if (restorePlaceholders) query = restorePlaceholders(query);
  try {
    const answer = await searcher({ query, limit, workDir, timeoutMs: MEMORY_SEARCH_TIMEOUT_MS, signal });
    return { text: answer.text.trim() === '' ? 'No memories matched.' : answer.text, isError: answer.isError };
  } catch (error) {
    return { text: `memory_search failed: ${error instanceof Error ? error.message : String(error)}`, isError: true };
  }
}

export interface MemorySearchStageOptions {
  /** Test seam; defaults to the worker's /api/dumb-search over direct-http. */
  searcher?: MemorySearcher;
  /** Test seams. */
  keepaliveIntervalMs?: number;
  maxSearchRounds?: number;
  now?: () => number;
}

interface MemorySearchStageState {
  hiddenToolName?: string;
}

export function createMemorySearchStage(options: MemorySearchStageOptions = {}): WireRewriteStage {
  const searcher = options.searcher ?? (query => searchMemoryInWorker(query));
  const now = options.now ?? Date.now;

  return {
    name: MEMORY_SEARCH_STAGE_NAME,
    enabledFor: memorySearchToolEnabledFor,
    appliesTo: context => context.ledger?.status === 'born' && context.ledger.get(SUSPENDED_ENTRY_ID) === undefined,

    whileOff(ledger: WireConversationLedgerView) {
      if (ledger.status !== 'born' || ledger.get(SUSPENDED_ENTRY_ID)) return;
      const tool = ledger.get('tool');
      if (tool?.type !== 'tool' || tool.definitionJson === null) return;
      ledger.record({ type: 'suspended', stage: MEMORY_SEARCH_STAGE_NAME, at: new Date(now()).toISOString() });
      logger.debug('WIRE', 'The hidden memory_search tool was off for a conversation it was offered to; it is never offered there again', {
        conversationKey: ledger.conversationKey,
      });
    },

    onRequest(context: WireRewriteContext, body: Uint8Array) {
      const ledger = context.ledger as WireConversationLedgerView;
      const request = context.requestOf(body);
      let tool = ledger.get('tool');
      if (tool === undefined) {
        if (!requestStartsConversation(request, context.identity.userTurnOrdinal)) {
          ledger.record({ type: 'tool', name: '', definitionJson: null });
          return undefined;
        }
        const name = hiddenToolNameFor(request.tools.map(definition => definition.name));
        tool = ledger.record({ type: 'tool', name, definitionJson: memorySearchToolDefinition(request.protocol, name) });
      }
      if (tool.type !== 'tool' || tool.definitionJson === null) return undefined;
      (context.state as MemorySearchStageState).hiddenToolName = tool.name;
      const withTool = appendToolDefinition(request, tool.definitionJson);
      return withTool === request.body ? undefined : withTool;
    },

    stitchReply(context: WireRewriteContext, input: WireReplyStitchInput) {
      const hiddenToolName = (context.state as MemorySearchStageState).hiddenToolName;
      if (!hiddenToolName) return undefined;
      const contentType = (input.contentType ?? '').toLowerCase();
      const mode = contentType.includes('event-stream') ? 'stream'
        : contentType.includes('json') ? 'whole'
          : contentType === '' ? (context.requestOf(input.forwardedBody).stream ? 'stream' : 'whole') : null;
      if (mode === null) return undefined;
      const workDir = context.identity.workDir;
      return hiddenToolLoopStream({
        stitcher: stitcherFor(context.protocol, hiddenToolName, context.requestOf(input.forwardedBody)),
        mode,
        input,
        search: (call, signal) => searchForCall(call, { searcher, workDir, signal, restorePlaceholders: input.restorePlaceholders }),
        keepaliveIntervalMs: options.keepaliveIntervalMs ?? DEFAULT_KEEPALIVE_INTERVAL_MS,
        maxSearchRounds: options.maxSearchRounds ?? MAX_SEARCH_ROUNDS,
        agentId: context.identity.agentId,
      });
    },
  };
}
