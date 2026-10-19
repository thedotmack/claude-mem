
import { logger } from './logger.js';
import { getRedactionConfig, redactSensitive } from './redaction.js';

const TAG_NAMES = [
  'private',
  'claude-mem-context',
  'system_instruction',
  'system-instruction',
  'persisted-output',
  'system-reminder',
] as const;
type TagName = (typeof TAG_NAMES)[number];

const MEMORY_TAG_NAMES = new Set<string>(TAG_NAMES);

// Sticky (stateful, `y`) matchers, applied at an explicit index. The open
// matcher captures only the tag name; the scanner checks that name against
// MEMORY_TAG_NAMES before doing anything else, so a run of ordinary tags like
// `'<div '` (no `>`) is rejected on the name instead of rescanning the suffix
// at every `<`.
const OPEN_TAG_NAME_RE = /<([A-Za-z_][A-Za-z0-9_-]*)/y;
const CLOSE_TAG_RE = /<\/([A-Za-z_][A-Za-z0-9_-]*)\s*>/y;

/**
 * Remove every balanced memory-tag block, including blocks nested inside
 * another memory tag of the same or a different name.
 *
 * An open tag spans `<name` through the first `>`, exactly the range the old
 * `[^>]*>` matched, so attribute text may contain `<` or a `</private>` and the
 * tag still ends where a reader expects. A close tag pairs with the earliest
 * still-open tag of that name and removes the whole span; pairing with the
 * earliest open (not the nearest) makes removal maximal, so a completed inner
 * block is dropped even when its outer tag is never closed and a nested
 * same-name block drops its whole tail. A close tag that falls inside an
 * opener's own span is that opener's attribute text, not a real close, so it is
 * ignored. A tag is removed only when a real close exists, so an unclosed
 * `<private>` in ordinary prose ("explain how <private> works") is left
 * untouched. Mis-nested close tags close the earliest matching open and drop
 * what was opened inside, so tag ordering cannot preserve private content.
 */
function stripBalancedMemoryTags(input: string): {
  text: string;
  counts: Record<TagName, number>;
  total: number;
} {
  const counts: Record<TagName, number> = Object.fromEntries(
    TAG_NAMES.map(name => [name, 0])
  ) as Record<TagName, number>;

  // No `<` means no memory tag can start, so skip the lookup table and the
  // scan entirely. Tool responses are usually untagged, and this keeps a large
  // one from paying a per-character table plus a second pass.
  if (!input.includes('<')) {
    return { text: input, counts, total: 0 };
  }

  // `nextGt[j]` is the index of the first `>` at or after `j`, or the input
  // length when there is none. Precomputing it keeps every opener's span lookup
  // O(1) so the scan stays linear.
  const len = input.length;
  const nextGt = new Int32Array(len + 1);
  nextGt[len] = len;
  for (let j = len - 1; j >= 0; j--) {
    nextGt[j] = input.charCodeAt(j) === 0x3e /* > */ ? j : nextGt[j + 1];
  }

  // Per name, the opens whose close tag has not been seen yet, consumed from
  // `head` upward. `removed` collects the half-open ranges `[start, end)` to
  // drop; ranges may nest or overlap, which the union below merges.
  const opens = new Map<TagName, { items: Array<{ start: number; attrEnd: number }>; head: number }>();
  const removed: Array<[number, number]> = [];
  let total = 0;
  let i = 0;

  while (i < len) {
    if (input.charCodeAt(i) !== 0x3c /* < */) {
      i += 1;
      continue;
    }

    CLOSE_TAG_RE.lastIndex = i;
    const close = CLOSE_TAG_RE.exec(input);
    if (close) {
      const name = close[1] as TagName;
      const entry = opens.get(name);
      const open = entry && entry.head < entry.items.length ? entry.items[entry.head] : undefined;
      // A close tag inside the opener's own span is that opener's attribute
      // text (for example `note="</private>"`), not a real close.
      if (open && i >= open.attrEnd) {
        entry!.head += 1;
        removed.push([open.start, i + close[0].length]);
        counts[name] += 1;
        total += 1;
      }
      i += close[0].length;
      continue;
    }

    OPEN_TAG_NAME_RE.lastIndex = i;
    const open = OPEN_TAG_NAME_RE.exec(input);
    if (open && MEMORY_TAG_NAMES.has(open[1])) {
      const name = open[1] as TagName;
      const nameEnd = i + open[0].length;
      const item = { start: i, attrEnd: nextGt[nameEnd] };
      const entry = opens.get(name);
      if (entry) {
        entry.items.push(item);
      } else {
        opens.set(name, { items: [item], head: 0 });
      }
      // Continue past the name only, so a memory tag inside this opener's
      // attribute is still scanned as a tag of its own.
      i = nameEnd;
      continue;
    }
    i += 1;
  }

  // Subtract the removed ranges (sorted and merged) from the input.
  removed.sort((a, b) => a[0] - b[0]);
  let out = '';
  let cursor = 0;
  for (const [start, end] of removed) {
    if (start > cursor) out += input.slice(cursor, start);
    if (end > cursor) cursor = end;
  }
  out += input.slice(cursor);
  return { text: out, counts, total };
}

const SYSTEM_REMINDER_OPEN = '<system-reminder>';
const SYSTEM_REMINDER_CLOSE = '</system-reminder>';

/**
 * Remove <system-reminder>...</system-reminder> blocks the way the shipped
 * `/<system-reminder>[\s\S]*?<\/system-reminder>/g` replace did: leftmost open
 * pairs with the first close after it, opens inside that span go with it.
 * Linear indexOf passes replace a regex whose per-position restart made
 * unclosed-tag payloads quadratic. A failed close search proves no close
 * exists for any later open either (the window only shrinks), so the tail,
 * unclosed open included, is kept verbatim.
 */
export function stripSystemReminderBlocks(text: string): string {
  let out = '';
  let pos = 0;
  for (;;) {
    const open = text.indexOf(SYSTEM_REMINDER_OPEN, pos);
    if (open === -1) break;
    const close = text.indexOf(SYSTEM_REMINDER_CLOSE, open + SYSTEM_REMINDER_OPEN.length);
    if (close === -1) break;
    out += text.slice(pos, open);
    pos = close + SYSTEM_REMINDER_CLOSE.length;
  }
  return out + text.slice(pos);
}

const MAX_TAG_COUNT = 100;

export function stripTags(input: string): { stripped: string; counts: Record<TagName, number> } {
  return finishStrippedTags(input, stripBalancedMemoryTags(input));
}

function finishStrippedTags(
  input: string,
  { text: stripped, counts, total }: ReturnType<typeof stripBalancedMemoryTags>,
): { stripped: string; counts: Record<TagName, number> } {

  if (total > MAX_TAG_COUNT) {
    logger.warn('SYSTEM', 'tag count exceeds limit', undefined, {
      tagCount: total,
      maxAllowed: MAX_TAG_COUNT,
      contentLength: input.length,
    });
  }

  // The single choke point for opt-in secret redaction (CLAUDE_MEM_REDACT_*):
  // every capture path (tool I/O and tool_uses, prompts incl. prompt storage,
  // assistant messages, server-beta events) strips tags through here, so no
  // site can be missed. A no-op while redaction is disabled.
  const redacted = redactSensitive(stripped.trim(), getRedactionConfig()).redacted;
  return { stripped: redacted, counts };
}

export function stripMemoryTags(content: string): string {
  return stripTags(content).stripped;
}

/**
 * The value with memory tags (<private> and the rest) removed from every
 * string in it (object values and array items, at any depth); the caller's
 * value is not mutated. For structured payloads that leave the hook or are
 * stored as-is, such as server runtime events and session metadata, where the
 * worker path's stripMemoryTags(JSON.stringify(...)) does not apply. Strings
 * without a tag are returned unchanged, so untagged content keeps its exact
 * whitespace.
 */
export function stripMemoryTagsFromJsonStrings<T>(value: T): T {
  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') {
      // Gate on the linear scanner, not a regex probe (quadratic on unclosed
      // tags, and blind to `</private >`); its result is reused, not rescanned.
      const scan = stripBalancedMemoryTags(node);
      return scan.total > 0 ? finishStrippedTags(node, scan).stripped : node;
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node !== null && typeof node === 'object') {
      return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, walk(child)]));
    }
    return node;
  };
  return walk(value) as T;
}

const PROTOCOL_ONLY_TAGS = ['task-notification'] as const;

const PROTOCOL_ONLY_REGEX = new RegExp(
  `^\\s*<(${PROTOCOL_ONLY_TAGS.join('|')})\\b[^>]*>(?:(?!<\\1\\b|</\\1\\b)[\\s\\S])*</\\1>\\s*$`,
);

const MAX_PROTOCOL_PAYLOAD_BYTES = 256 * 1024;

export function isInternalProtocolPayload(text: string): boolean {
  if (!text) return false;
  if (text.length > MAX_PROTOCOL_PAYLOAD_BYTES) return false;
  return PROTOCOL_ONLY_REGEX.test(text);
}

/**
 * The openings of the prompts Codex and the Codex app send, through the same
 * UserPromptSubmit hook as a user turn, for their own helper threads. Each
 * became a claude-mem session and spent observer tokens on Codex's internals.
 * Each pattern is the helper's own opening line, never a phrase a person
 * would type.
 */
const CODEX_INTERNAL_PROMPT_OPENINGS: readonly RegExp[] = [
  // Codex app: names a task.
  /^You are a helpful assistant\. You will be presented with a user prompt, and your job is to provide a short title/,
  // Codex memories: the consolidation pass.
  /^## Memory Writing Agent: Phase 2 \(Consolidation\)/,
  // Codex app: onboarding suggestions.
  /^# Overview\r?\n(?:\r?\n)?Generate 0 to 3 hyperpersonalized suggestions/,
  // Codex app: suggests the next message for the empty composer (#4811).
  /^This is an app-generated request for a suggested next user message\. The user did not write this message\./,
  // Codex memories: folds rollout summaries into memory_summary.md (#4811).
  /^Consolidate the supplied rollout summaries into `memory_summary\.md`/,
];

/**
 * Whether a prompt is one of Codex's internal helper prompts. Callers apply it
 * only to platformSource 'codex': the same text from any other host is a
 * person's prompt.
 */
export function isCodexInternalPrompt(text: string): boolean {
  const opening = text.trimStart();
  return CODEX_INTERNAL_PROMPT_OPENINGS.some(pattern => pattern.test(opening));
}
