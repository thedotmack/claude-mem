
import { logger } from './logger.js';

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

  return { stripped: stripped.trim(), counts };
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

export function isInternalSystemPrompt(text: string): boolean {
  if (!text) return false;

  const trimmed = text.trim();

  // 1. Codex-app session title generation prompt
  if (trimmed.startsWith('You are a helpful assistant. You will be presented with a user prompt, and your job is to provide a short title')) {
    return true;
  }

  // 2. Memory Writing Agent consolidation prompt
  if (trimmed.startsWith('## Memory Writing Agent: Phase 2 (Consolidation)') || trimmed.startsWith('## Memory Writing Agent')) {
    return true;
  }

  // 3. Codex onboarding/suggestions prompt
  if (trimmed.startsWith('# Overview\n\nGenerate 0 to 3 hyperpersonalized suggestions') || 
      trimmed.startsWith('# Overview\r\n\r\nGenerate 0 to 3 hyperpersonalized suggestions') ||
      trimmed.startsWith('# Overview\nGenerate 0 to 3 hyperpersonalized suggestions')) {
    return true;
  }

  return false;
}
