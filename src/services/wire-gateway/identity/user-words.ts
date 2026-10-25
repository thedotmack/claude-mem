// SPDX-License-Identifier: Apache-2.0
//
// What the user said, told apart from what the agent put in for them (plan
// Phase 4 task 6). Ported from magpie (MIT, Copyright (c) 2026 yetone):
// `userWords`/`userSaid` and the `reminders`, `myRequest` and `injected`
// lists (internal/gateway/prompt.go:639-694), `agentsFor` (prompt.go:305),
// `firstWords` (internal/gateway/rules.go:122-153) and the session readers'
// context rule `textPart` (internal/sessions/content.go:204-210).

import { removeTagBlocks } from '../../../utils/tag-stripping.js';
import type { WireMessage, WireRequest } from '../ir/types.js';

const SYSTEM_REMINDER_OPEN = '<system-reminder';
const SYSTEM_REMINDER_CLOSE = '</system-reminder>';

/**
 * Remove what agents add to a user's message for the model alone: Claude
 * Code's <system-reminder>, ZCode's with a source=. The same text magpie's
 * `<system-reminder(?:\s[^>]*)?>[\s\S]*?</system-reminder>` removes, found
 * with indexOf: a backtracking regex rescans to the end for every unclosed
 * opening, and a request body is read before it is forwarded.
 */
function withoutSystemReminders(text: string): string {
  let kept = '';
  let keptUpTo = 0;
  let searchFrom = 0;
  for (;;) {
    const openAt = text.indexOf(SYSTEM_REMINDER_OPEN, searchFrom);
    if (openAt < 0) break;
    const afterName = openAt + SYSTEM_REMINDER_OPEN.length;
    const nextChar = text.charAt(afterName);
    let contentFrom: number;
    if (nextChar === '>') {
      contentFrom = afterName + 1;
    } else if (/\s/.test(nextChar)) {
      const tagEnd = text.indexOf('>', afterName);
      if (tagEnd < 0) break; // no later opening can end either
      contentFrom = tagEnd + 1;
    } else {
      searchFrom = afterName; // `<system-reminderish`: not a reminder
      continue;
    }
    const closeAt = text.indexOf(SYSTEM_REMINDER_CLOSE, contentFrom);
    if (closeAt < 0) break; // no later opening can close either
    kept += text.slice(keptUpTo, openAt);
    keptUpTo = closeAt + SYSTEM_REMINDER_CLOSE.length;
    searchFrom = keptUpTo;
  }
  return keptUpTo === 0 ? text : kept + text.slice(keptUpTo);
}

/**
 * The blocks the gateway itself adds (Endless Mode v2): the durable header's
 * <claude-mem-rules> and Endless Mode's <claude-mem-timeline>. They are never
 * the user's words, so the timeline neither starts nor hides a turn.
 */
const GATEWAY_BLOCK_TAG_NAMES = ['claude-mem-timeline', 'claude-mem-rules'] as const;

/**
 * Endless Mode's timeline is one block over several text parts (it grows by
 * a part at its end): the first part opens with this tag, the last part is
 * the closing tag alone, and none of the parts from one to the other are the
 * user's words.
 */
export const TIMELINE_OPEN_TAG = '<claude-mem-timeline>';
export const TIMELINE_CLOSE_TAG = '</claude-mem-timeline>';

/** Heads what the user typed in the Codex app, after the context it puts first. */
const CODEX_APP_MY_REQUEST_PATTERN = /^## My request(?: for Codex)?:[ \t]*\n?/gm;

/**
 * Codex: "# AGENTS.md instructions for /path" on a line of its own (magpie
 * `agentsFor`, `^# (\S+\.md) instructions for (\S.*?)[ \t]*\n`, without the
 * lazy repeat that backtracks over a long line with no line feed). codex-cli
 * 0.162.1 sends a bare "# AGENTS.md instructions" line, without the path
 * (seen live), so the "for <path>" part is optional. The two forms are
 * alternatives so no two repeats can match the same spaces (a long line of
 * spaces with no line feed would backtrack quadratically).
 */
const AGENTS_FILE_INSTRUCTIONS_PATTERN = /^# \S+\.md instructions(?: for \S[^\n\r\u2028\u2029]*|[ \t]*)\n/;

/**
 * How a text the agent put in as the user begins (magpie `injected`, verbatim):
 * Codex's and the Codex app's context, Claude Code's and ZCode's notices,
 * plugin metadata, agent lists and todo nudges.
 */
export const AGENT_INJECTED_TEXT_PREFIXES: readonly string[] = [
  '<system-reminder', '<environment_context>', '<user_instructions>', '<turn_aborted>',
  '<user_shell_command>', '<subagent_notification>', '<in-app-browser-context',
  '<task-notification>', '<subagent-notification>', '<plugin_reference>',
  'Available agent types for the Agent tool:', 'Available agent types and the tools they have access to:',
  'New agent types are now available for the Agent tool:',
  "The TodoWrite tool hasn't been used recently.", "The task tools haven't been used recently.",
  'Conversation rewind applied.', 'Workspace rewind applied.',
  // Claude Code's local commands (/compact, /clear, …) and the summary a
  // compaction leaves; the turn after a /compact carries all of them before
  // the user's words (seen live, claude 2.1.303).
  '<local-command-caveat>', '<command-name>', '<local-command-stdout>', '<local-command-stderr>',
  // What Claude Code puts beside the tool results of a turn the user stopped.
  '[Request interrupted by user',
  'This session is being continued from a previous conversation that ran out of context.',
];

/**
 * What the user said in one text: "" for a text the agent put in (an
 * instruction file, a reminder, a notice), else the text without its
 * reminders, and after the Codex app's context (magpie `userWords`).
 */
export function userWordsInText(text: string): string {
  let words = withoutSystemReminders(removeTagBlocks(text, GATEWAY_BLOCK_TAG_NAMES)).trim();
  const myRequestHeadings = [...words.matchAll(CODEX_APP_MY_REQUEST_PATTERN)];
  const lastMyRequestHeading = myRequestHeadings.at(-1);
  if (lastMyRequestHeading) {
    words = words.slice(lastMyRequestHeading.index! + lastMyRequestHeading[0].length).trim();
  }
  if (words === '' || AGENTS_FILE_INSTRUCTIONS_PATTERN.test(words)) return '';
  if (AGENT_INJECTED_TEXT_PREFIXES.some(prefix => words.startsWith(prefix))) return '';
  return words;
}

/** What the user said in a message: the words of its text parts, one per line (magpie `userSaid`). */
export function userWordsInMessage(message: WireMessage): string {
  const said: string[] = [];
  let insideTimeline = false;
  for (const part of message.parts) {
    if (part.kind !== 'text') continue;
    const text = part.text ?? '';
    if (!insideTimeline && text.startsWith(TIMELINE_OPEN_TAG) && !text.trimEnd().endsWith(TIMELINE_CLOSE_TAG)) insideTimeline = true;
    if (insideTimeline) {
      if (text.trim() === TIMELINE_CLOSE_TAG) insideTimeline = false;
      continue;
    }
    const words = userWordsInText(text);
    if (words !== '') said.push(words);
  }
  return said.join('\n');
}

/**
 * The user's words that open the conversation (magpie `firstWords`, before
 * hashing): those of the first user message that has any; when none has,
 * the text of the first user message. An edited instruction file, a
 * reminder or Codex's context never changes it, so it names the
 * conversation for its whole life.
 */
export function firstUserWordsOfConversation(request: WireRequest): string {
  for (const message of request.messages) {
    if (message.role !== 'user') continue;
    const words = userWordsInMessage(message);
    if (words !== '') return words;
  }
  const firstUserMessage = request.messages.find(message => message.role === 'user');
  if (!firstUserMessage) return '';
  return firstUserMessage.parts.filter(part => part.kind === 'text').map(part => part.text ?? '').join('');
}

/** The words of the last user message that said anything; "" when none did. */
export function latestUserWordsOfConversation(request: WireRequest): string {
  for (let index = request.messages.length - 1; index >= 0; index--) {
    const message = request.messages[index];
    if (message.role !== 'user') continue;
    const words = userWordsInMessage(message);
    if (words !== '') return words;
  }
  return '';
}

/**
 * Whether a text is something the agent put in rather than words said: it
 * opens with a `<…>` tag or is Codex's AGENTS.md (magpie `textPart`). magpie
 * applies this only when reading agents' own session files; the wire
 * gateway applies it in its recorder on purpose (plan Phase 4 task 6).
 */
export function isAgentContextText(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith('<') || trimmed.startsWith('# AGENTS.md');
}
