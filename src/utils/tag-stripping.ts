
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

const STRIP_REGEX = new RegExp(
  `<(${TAG_NAMES.join('|')})\\b[^>]*>[\\s\\S]*?</\\1>`,
  'g'
);

export const SYSTEM_REMINDER_REGEX = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

const MAX_TAG_COUNT = 100;

export function stripTags(input: string): { stripped: string; counts: Record<TagName, number> } {
  const counts: Record<TagName, number> = Object.fromEntries(
    TAG_NAMES.map(name => [name, 0])
  ) as Record<TagName, number>;

  STRIP_REGEX.lastIndex = 0; 

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
