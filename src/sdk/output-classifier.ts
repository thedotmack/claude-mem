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

export type ObserverOutputClass = 'xml' | 'idle' | 'prose';

const PREVIEW_LENGTH = 200;

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

/**
 * Classify an observer/summarizer SDK output.
 *
 * - `xml`      — contains a parseable `<observation>`/`<summary>`/`<skip_summary/>`
 *                root tag. (Whether it ultimately yields rows is parseAgentXml's
 *                job; this is the structural gate.)
 * - `idle`     — empty / whitespace-only. Benign: the SDK had nothing to say.
 * - `prose`    — any other non-XML text. Conversational output; not persisted.
 */
export function classifyObserverOutput(raw: unknown): ObserverOutputClass {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return 'idle';
  }

  if (/<(observation|summary)\b/i.test(raw) || /<skip_summary\b/i.test(raw)) {
    return 'xml';
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
