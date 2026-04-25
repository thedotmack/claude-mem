/**
 * Tag Stripping Utilities
 *
 * Implements the tag system for meta-observation control:
 * 1. <claude-mem-context> - System-level tag for auto-injected observations
 *    (prevents recursive storage when context injection is active)
 * 2. <private> - User-level tag for manual privacy control
 *    (allows users to mark content they don't want persisted)
 * 3. <system_instruction> / <system-instruction> - Conductor-injected system instructions
 *    (should not be persisted to memory)
 * 4. <system-reminder> - Claude Code-injected system reminders
 *    (CLAUDE.md contents, deferred tool lists, etc. — should not be persisted)
 * 5. <persisted-output> - Persisted-output payload tag
 *
 * EDGE PROCESSING PATTERN: Filter at hook layer before sending to worker/storage.
 * This keeps the worker service simple and follows one-way data stream.
 *
 * PATHFINDER plan 03 phase 8: collapsed countTags + stripTagsInternal into a
 * single alternation regex. One pass over the input. One helper, N callers
 * (`stripMemoryTagsFromJson` / `stripMemoryTagsFromPrompt` are thin adapters).
 */

import { logger } from './logger.js';

/** All tag names this module strips. Single source of truth for the regex. */
const TAG_NAMES = [
  'private',
  'claude-mem-context',
  'system_instruction',
  'system-instruction',
  'persisted-output',
  'system-reminder',
] as const;
type TagName = (typeof TAG_NAMES)[number];

/**
 * Single-pass alternation regex covering every privacy / context tag.
 * Backreference `\1` ensures a closing tag matches the opening name; tag
 * attributes (e.g. `<system-reminder data-foo="…">`) are tolerated via
 * `[^>]*`.
 */
const STRIP_REGEX = new RegExp(
  `<(${TAG_NAMES.join('|')})\\b[^>]*>[\\s\\S]*?</\\1>`,
  'g'
);

/**
 * Regex to match <system-reminder> tags and their content.
 * Exported for use by transcript parsers that strip system-reminder at read-time.
 *
 * Kept as a separate single-tag regex because the active transcript parser
 * (`src/shared/transcript-parser.ts`) consumes only this one tag and would
 * otherwise need to re-import the multi-tag list.
 */
export const SYSTEM_REMINDER_REGEX = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

/** Maximum total stripped-tag count before we log a ReDoS-class anomaly. */
const MAX_TAG_COUNT = 100;

/**
 * Strip every recognised tag from `input` in a single pass.
 *
 * @returns the stripped string (trimmed) and per-tag counts. Counts are
 *          surfaced to logs for observability but are not used as a control
 *          signal.
 */
export function stripTags(input: string): { stripped: string; counts: Record<TagName, number> } {
  const counts: Record<TagName, number> = Object.fromEntries(
    TAG_NAMES.map(name => [name, 0])
  ) as Record<TagName, number>;

  STRIP_REGEX.lastIndex = 0; // /g state is per-instance — reset before each call.

  let total = 0;
  const stripped = input.replace(STRIP_REGEX, (_, name: TagName) => {
    counts[name] = (counts[name] ?? 0) + 1;
    total += 1;
    return '';
  });

  if (total > MAX_TAG_COUNT) {
    logger.warn('SYSTEM', 'tag count exceeds limit', undefined, {
      tagCount: total,
      maxAllowed: MAX_TAG_COUNT,
      contentLength: input.length,
    });
  }

  return { stripped: stripped.trim(), counts };
}

/**
 * Strip memory tags from JSON-serialized content (tool inputs/responses).
 * Thin adapter around `stripTags` — same regex, same single pass.
 */
export function stripMemoryTagsFromJson(content: string): string {
  return stripTags(content).stripped;
}

/**
 * Strip memory tags from user prompt content.
 * Thin adapter around `stripTags` — same regex, same single pass.
 */
export function stripMemoryTagsFromPrompt(content: string): string {
  return stripTags(content).stripped;
}

/**
 * Tag names that Claude Code emits autonomously into the prompt stream as
 * protocol notifications — never authored by the user. When the entire prompt
 * payload is one of these blocks (with no surrounding user text), the hook
 * MUST skip storage to keep `user_prompts` clean.
 *
 * Conservative deny-list: do NOT add `<command-name>` / `<command-message>`
 * here — those wrap genuine user slash-command invocations.
 */
const PROTOCOL_ONLY_TAGS = ['task-notification'] as const;

const PROTOCOL_ONLY_REGEX = new RegExp(
  `^\\s*<(${PROTOCOL_ONLY_TAGS.join('|')})\\b[^>]*>[\\s\\S]*</\\1>\\s*$`,
);

// Bounds the unanchored `[\s\S]*` body to keep a malformed 1MB+ payload that
// opens a protocol tag and never closes it from running the regex engine
// against the whole prompt before failing.
const MAX_PROTOCOL_PAYLOAD_BYTES = 256 * 1024;

/**
 * Returns true when `text` is *entirely* a Claude Code protocol payload
 * (e.g. a `<task-notification>` block emitted on background Agent completion)
 * with no surrounding user-authored content.
 */
export function isInternalProtocolPayload(text: string): boolean {
  if (!text) return false;
  if (text.length > MAX_PROTOCOL_PAYLOAD_BYTES) return false;
  return PROTOCOL_ONLY_REGEX.test(text);
}
