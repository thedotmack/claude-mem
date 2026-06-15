/**
 * Output-fidelity classifier for observer/summarizer SDK responses (plan-11, #2485).
 *
 * The observer SDK is supposed to emit `<observation>`/`<summary>` XML, but it
 * sometimes returns conversational prose, an empty/idle string, or a
 * "session exhausted"/closure string instead. Historically parseAgentXml just
 * returned `{ valid: false }` and the whole batch was dropped silently, leaving
 * observations stuck at zero with no signal. This classifier splits the
 * non-XML cases apart so the pipeline can log a visible preview, avoid respawn
 * churn on benign idle output, and trigger recovery on a poisoned session.
 */

export type ObserverOutputClass = 'xml' | 'idle' | 'prose' | 'poisoned';

const PREVIEW_LENGTH = 200;

// Phrases that signal the SDK session has wedged / been exhausted and will keep
// emitting non-XML closure strings until it is killed and respawned. Kept
// lowercase; matched case-insensitively against the raw output.
const POISONED_MARKERS: string[] = [
  'session exhausted',
  'session has been exhausted',
  'session limit reached',
  'context window',
  'prompt is too long',
  'maximum context length',
  'conversation is too long',
  'no longer able to continue',
  'i cannot continue this session',
  'session closed',
  'this session has ended',
];

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

  const lower = raw.toLowerCase();

  // Poison detection takes precedence over XML: a wedged session can emit a
  // closure string alongside a stray tag, and we want to recover regardless.
  for (const marker of POISONED_MARKERS) {
    if (lower.includes(marker)) {
      return 'poisoned';
    }
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
