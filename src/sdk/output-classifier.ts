/**
 * Output-fidelity classifier for observer/summarizer SDK responses (plan-11, #2485).
 *
 * The observer SDK is supposed to emit `<observation>`/`<summary>` XML, but it
 * sometimes returns conversational prose or an empty/idle string instead.
 * Historically parseAgentXml just returned `{ valid: false }` and the whole
 * batch was dropped silently, leaving observations stuck at zero with no
 * signal. This classifier splits the non-XML cases apart so the pipeline can
 * log a visible preview while dropping benign skip/no-op output.
 */

export type ObserverOutputClass = 'xml' | 'idle' | 'skip' | 'prose';

const PREVIEW_LENGTH = 200;
const MAX_SKIP_PROSE_LENGTH = 200;
const SKIP_PROSE_MARKERS = [
  'no observations to record',
  'no new observations to record',
  'no observations found',
  'no new observations found',
  'no observations',
  'no new observations',
  'no observation ',
  'no substantive',
  'insufficient data',
  'nothing to observe',
  'nothing to record',
  'nothing to summarize',
  'nothing worth recording',
  'no summary needed',
  'no memory-worthy',
  'no tool executions',
  'no tool execution',
  'no relevant tool',
  'no meaningful',
  'empty - no',
  'skipping',
  'skip this',
] as const;
const SKIP_CONTENT_SIGNAL = /\b(?:but|however|although|except|identified|discovered|learned|recorded|captured|stored|noted|issue|bug|fix|error|failure)\b/;
const SKIP_NEUTRAL_REMAINDER_WORDS = new Set([
  'at',
  'this',
  'time',
  'for',
  'batch',
  'investigation',
  'not',
  'yet',
  'started',
  'no',
  'tool',
  'executions',
  'or',
  'technical',
  'findings',
  'have',
  'been',
  'provided',
  'in',
  'the',
  'primary',
  'session',
  'observed',
  'data',
  'observation',
  'window',
  'new',
  'needed',
  'repeated',
  'log',
  'scan',
  'with',
  'findings',
  'insufficient',
  'empty',
]);

// Benign "nothing to record" phrases the SDK emits as plain prose instead of
// <skip_summary/>. They mean the batch had no memory-worthy content — a healthy
// outcome — so they must be treated as idle, never as a wedge that accumulates
// toward a respawn. Kept lowercase; matched case-insensitively against the raw
// output.
const BENIGN_SKIP_MARKERS: string[] = [
  'no observations to record',
  'nothing to record',
  'no observations to make',
  'nothing to summarize',
  'no summary needed',
  'nothing worth recording',
  'no memory-worthy',
];

/**
 * Returns a short, single-line preview of raw output for diagnostics/logging so
 * a dropped batch is visible instead of silent.
 */
export function previewOutput(raw: unknown, maxLength: number = PREVIEW_LENGTH): string {
  if (typeof raw !== 'string') {
    return `(non-string output: ${typeof raw})`;
  }
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxLength) {
    return collapsed;
  }
  return `${collapsed.slice(0, maxLength)}…(+${collapsed.length - maxLength} chars)`;
}

function hasSkipMarkerPrefix(normalized: string, marker: string): boolean {
  if (normalized === marker) {
    return true;
  }

  if (!normalized.startsWith(marker)) {
    return false;
  }

  const nextChar = normalized.charAt(marker.length);
  return /[\s.,!?:;\-—–)]/.test(nextChar);
}

function isNeutralSkipRemainder(remainder: string): boolean {
  const stripped = remainder.replace(/^[\s.,!?:;\-—–()]+/, '').trim();
  if (stripped.length === 0) {
    return true;
  }

  const words = stripped.match(/[a-z]+/g);
  if (!words || words.length === 0) {
    return true;
  }

  return words.every(word => SKIP_NEUTRAL_REMAINDER_WORDS.has(word));
}

function isRecognizedSkipProse(raw: string): boolean {
  const normalized = raw.trim().toLowerCase().replace(/\s+/g, ' ');
  const withoutWrapper = normalized.replace(/^\(+/, '').replace(/\)+$/, '').trim();
  if (withoutWrapper.length === 0 || withoutWrapper.length > MAX_SKIP_PROSE_LENGTH) {
    return false;
  }

  for (const marker of SKIP_PROSE_MARKERS) {
    if (hasSkipMarkerPrefix(withoutWrapper, marker)) {
      const remainder = withoutWrapper.slice(marker.length);
      return !SKIP_CONTENT_SIGNAL.test(remainder) && isNeutralSkipRemainder(remainder);
    }

    if (
      !SKIP_CONTENT_SIGNAL.test(withoutWrapper) &&
      withoutWrapper.includes(marker) &&
      isNeutralSkipRemainder(withoutWrapper.replace(marker, ''))
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Classify an observer/summarizer SDK output.
 *
 * - `xml`      — contains a parseable `<observation>`/`<summary>`/`<skip_summary/>`
 *                root tag. (Whether it ultimately yields rows is parseAgentXml's
 *                job; this is the structural gate.)
 * - `idle`     — empty / whitespace-only, or a plain-prose "nothing to record"
 *                skip. Benign: the SDK had nothing memory-worthy to say.
 * - `poisoned` — a known "session exhausted"/closure string. Recover by killing
 *                and respawning the SDK session.
 * - `prose`    — any other non-XML text. Conversational output; not persisted.
 */
export function classifyObserverOutput(raw: unknown): ObserverOutputClass {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return 'idle';
  }

  if (/<(observation|summary)\b/i.test(raw) || /<skip_summary\b/i.test(raw)) {
    return 'xml';
  }

  // A "nothing to record" answer in plain prose is a benign skip, not a wedge:
  // classify it as idle so it never counts toward the respawn threshold.
  for (const marker of BENIGN_SKIP_MARKERS) {
    if (lower.includes(marker)) {
      return 'idle';
    }
  }

  return 'prose';
}

/**
 * Detect provider quota prose returned as an assistant message instead of a
 * structured SDK/system error. Quota pauses preserve claimed work; ordinary
 * observer prose is confirmed and dropped.
 */
export function isQuotaLimitedObserverOutput(raw: unknown): boolean {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return false;
  }

  const text = raw.toLowerCase().replace(/\s+/g, ' ').trim();

  return (
    /\bclaude\b.*\busage\b.*\blimit\b.*\b(reached|exceeded|exhausted|reset|resets|try again)\b/.test(text) ||
    /\b(reached|exceeded|exhausted)\b.*\bclaude\b.*\busage\b.*\blimit\b/.test(text) ||
    /\bweekly\b.*\b(limit|quota)\b.*\b(reached|exceeded|exhausted|reset|resets|try again)\b/.test(text) ||
    /\b(reached|exceeded|exhausted)\b.*\bweekly\b.*\b(limit|quota)\b/.test(text) ||
    /\bsubscription\b.*\b(limit|quota)\b.*\b(reached|exceeded|exhausted|reset|resets|try again)\b/.test(text) ||
    /\b(rate limit|quota)\b.*\b(subscription|weekly|claude usage)\b.*\b(reached|exceeded|exhausted|reset|resets|try again)\b/.test(text)
  );
}
