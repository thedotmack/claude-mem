/**
 * Output-fidelity classifier for observer/summarizer SDK responses (plan-11, #2485).
 *
 * The observer SDK is supposed to emit `<observation>`/`<summary>` XML, but it
 * sometimes returns conversational prose or an empty/idle string instead.
 *
 * The classifier only checks output shape. It must not inspect content and make
 * recovery decisions. Unparseable output is ignored by the processor layer.
 */

export type ObserverOutputClass = 'xml' | 'idle' | 'prose';

const PREVIEW_LENGTH = 200;

/**
 * Returns a short, single-line preview of raw output for diagnostics/logging.
 */
export function previewOutput(
  raw: unknown,
  maxLength: number = PREVIEW_LENGTH
): string {
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
 * - `xml`   — contains a supported observer XML root tag.
 * - `idle`  — empty / whitespace-only output.
 * - `prose` — any other non-XML text.
 */
export function classifyObserverOutput(
  raw: unknown
): ObserverOutputClass {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return 'idle';
  }

  if (
    /<(observation|summary)\b/i.test(raw) ||
    /<skip_summary\b/i.test(raw)
  ) {
    return 'xml';
  }

  return 'prose';
}