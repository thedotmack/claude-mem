// SPDX-License-Identifier: Apache-2.0
//
// What a request is for (plan Phase 4 task 4): exactly one of `turn`,
// `subagent`, `helper:<name>` or `compaction`. Helper and compaction requests
// are an agent's side calls: they never end a turn and never become
// observations (Phase 5), except that a compaction's summary is kept.
//
// Detectors ported from magpie (MIT, Copyright (c) 2026 yetone):
// `autoModeClassifier` (internal/gateway/automode.go:84-103), `desktopTitle`,
// `small` and `hasTools` (internal/gateway/desktop.go:470-524), `compacting`
// with `compactSystems`/`compactAsks` (internal/gateway/compacting.go:19-94),
// and the `[SUGGESTION MODE:` literal (claude_side_question_test.go:45; magpie
// has no detector for it).

import type { WireMessage, WireRequest } from '../ir/types.js';

export type WireRequestKind = 'turn' | 'subagent' | 'compaction' | `helper:${string}`;

/** Claude Code's `x-claude-code-request-class` hint (CLAUDE_CODE_GATEWAY_HINT_HEADERS=1, v2.1.273+). */
export function kindFromClaudeCodeRequestClass(requestClass: string | null): WireRequestKind | null {
  switch ((requestClass ?? '').trim().toLowerCase()) {
    case 'main':
      return 'turn';
    case 'subagent':
    case 'workflow':
      return 'subagent';
    case 'compaction':
      return 'compaction';
    case 'auxiliary':
      return 'helper:auxiliary';
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Shared readers

/** The system prompt as one text, its parts joined as magpie joins them. */
function systemPromptText(request: WireRequest): string {
  return request.system.map(part => part.text ?? '').filter(text => text !== '').join('\n\n');
}

function lastUserMessage(request: WireRequest): WireMessage | undefined {
  for (let index = request.messages.length - 1; index >= 0; index--) {
    if (request.messages[index].role === 'user') return request.messages[index];
  }
  return undefined;
}

function textPartsOf(message: WireMessage | undefined): string[] {
  return (message?.parts ?? []).filter(part => part.kind === 'text').map(part => part.text ?? '');
}

// ---------------------------------------------------------------------------
// Helper detectors

/**
 * Claude Code's auto-mode safety classifier: no tools, `<block>` or
 * `<severity>` in the system prompt, and a user text starting `<transcript>`.
 */
export function isAutoModeClassifierRequest(request: WireRequest): boolean {
  if (request.tools.length > 0) return false;
  const system = systemPromptText(request);
  if (!system.includes('<block>') && !system.includes('<severity>')) return false;
  return request.messages.some(message =>
    message.role === 'user' && textPartsOf(message).some(text => text.trim().startsWith('<transcript>')));
}

/**
 * How title prompts begin: Claude Desktop's (its client, or Claude Code's
 * --system-prompt), and OpenCode's (opencode 1.19, seen live: its title
 * request comes first and has no folder, so read as a turn it opened the
 * session in no project).
 */
export const TITLE_HELPER_SYSTEM_PROMPTS: readonly string[] = [
  'You write short session titles.',
  'You are a title generator. You output ONLY a thread title.',
];

/** The largest max_tokens magpie's `small` takes for a short side answer. */
export const SMALL_REQUEST_MAX_OUTPUT_TOKENS = 4096;

/** Agents whose small, tool-less requests are side calls (magpie `otelCallKind`: claude and claude-desktop). */
const SMALL_TOOLLESS_HELPER_AGENT_IDS: ReadonlySet<string> = new Set(['claude-code', 'claude-desktop']);

/**
 * A title helper: the system prompt (as a string or any of its blocks)
 * starts with a title prompt; or, from Claude Code or Claude Desktop,
 * the request asks for at most 4096 tokens and offers no tools.
 */
export function isTitleHelperRequest(request: WireRequest, agentId: string): boolean {
  if (request.system.some(part => TITLE_HELPER_SYSTEM_PROMPTS.some(prompt => (part.text ?? '').startsWith(prompt)))) return true;
  const maxOutputTokens = request.maxOutputTokens ?? 0;
  return SMALL_TOOLLESS_HELPER_AGENT_IDS.has(agentId)
    && maxOutputTokens > 0
    && maxOutputTokens <= SMALL_REQUEST_MAX_OUTPUT_TOKENS
    && request.tools.length === 0;
}

export const SUGGESTION_MODE_MARKER = '[SUGGESTION MODE:';

/** Claude Code's prompt suggestion: its last user message holds the `[SUGGESTION MODE:` literal. */
export function isSuggestionModeRequest(request: WireRequest): boolean {
  return textPartsOf(lastUserMessage(request)).some(text => text.includes(SUGGESTION_MODE_MARKER));
}

// ---------------------------------------------------------------------------
// Compaction (magpie compacting.go)

/** How far into the system prompt, or a last-user text part, a compaction prompt may begin, in bytes. */
const COMPACTION_PROMPT_LEAD_BYTES = 2048;

/** Open (or are) the system prompt of a compaction request (magpie `compactSystems`, verbatim). */
export const COMPACTION_SYSTEM_PROMPTS: readonly string[] = [
  // Claude Code 2.1, and OpenCode's before its own agent
  'You are a helpful AI assistant tasked with summarizing conversations.',
  // OpenCode's compaction agent
  'You are a context summarization agent.',
  // Pi
  'You are a context summarization assistant.',
  // Gemini CLI
  'You are a specialized system component responsible for distilling chat history into a structured XML <state_snapshot>',
  // Qwen Code
  'You are the component that summarizes a conversation when its context window is about to overflow.',
  // Minis
  'You are a context compaction engine. Your summary will REPLACE the original messages in the conversation context window.',
  // Kimi Code
  'You are a helpful assistant that compacts conversation context.',
];

/** Said in a text part of the last user message (magpie `compactAsks`, verbatim). */
export const COMPACTION_USER_ASKS: ReadonlyArray<{ ask: string; opens?: string }> = [
  // Claude Code's /compact and auto-compact
  { ask: 'Your task is to create a detailed summary of the conversation so far' },
  // Codex
  { ask: 'You are performing a CONTEXT CHECKPOINT COMPACTION.' },
  // Kimi Code
  { ask: 'You are now given a task to compact this conversation context' },
  // Minis, around the conversation it sends as one user message
  { ask: 'END OF CONVERSATION TO COMPACT.', opens: 'Compact this conversation into a context summary:' },
];

/** Whether `phrase` begins within the first 2048 bytes of `text` (magpie `leads`). */
function beginsNearStart(text: string, phrase: string): boolean {
  const at = text.indexOf(phrase);
  return at >= 0 && Buffer.byteLength(text.slice(0, at), 'utf8') <= COMPACTION_PROMPT_LEAD_BYTES;
}

/** An agent compacting its conversation, told by its own prompt (magpie `compacting`). */
export function isCompactionPromptRequest(request: WireRequest): boolean {
  const system = systemPromptText(request);
  if (COMPACTION_SYSTEM_PROMPTS.some(prompt => beginsNearStart(system, prompt))) return true;
  return textPartsOf(lastUserMessage(request)).some(text => COMPACTION_USER_ASKS.some(({ ask, opens }) =>
    opens === undefined
      ? beginsNearStart(text, ask)
      : text.trim().startsWith(opens) && text.includes(ask)));
}

/** Codex asks for a compaction with a `compaction_trigger` input item in its latest user message. */
export function hasCodexCompactionTrigger(request: WireRequest): boolean {
  return (lastUserMessage(request)?.parts ?? []).some(part => part.kind === 'context' && part.name === 'compaction_trigger');
}
