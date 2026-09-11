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

  if (/<(observation|summary)\b/i.test(raw) || /<skip_summary\b/i.test(raw)) {
    return false;
  }

  const text = raw.toLowerCase().replace(/\s+/g, ' ').trim();

  return (
    // Wordings Claude Code actually writes when a subscription window or the
    // credit balance is exhausted:
    //   "You've hit your session limit · resets 5:50pm (America/Los_Angeles)"
    //   "You've reached your Fable 5 limit. Run /usage-credits to continue…"
    //   "You're out of usage credits. Run /usage-credits to keep using…"
    /\byou'?ve (?:hit|reached) your\b.{0,40}\blimit\b/.test(text) ||
    /\bsession limit\b/.test(text) ||
    /\bout of (?:usage )?credits\b/.test(text) ||
    /\/usage-credits\b/.test(text) ||
    /\bclaude\b.*\busage\b.*\blimit\b.*\b(reached|exceeded|exhausted|reset|resets|try again)\b/.test(text) ||
    /\b(reached|exceeded|exhausted)\b.*\bclaude\b.*\busage\b.*\blimit\b/.test(text) ||
    /\bweekly\b.*\b(limit|quota)\b.*\b(reached|exceeded|exhausted|reset|resets|try again)\b/.test(text) ||
    /\b(reached|exceeded|exhausted)\b.*\bweekly\b.*\b(limit|quota)\b/.test(text) ||
    /\bsubscription\b.*\b(limit|quota)\b.*\b(reached|exceeded|exhausted|reset|resets|try again)\b/.test(text) ||
    /\b(rate limit|quota)\b.*\b(subscription|weekly|claude usage)\b.*\b(reached|exceeded|exhausted|reset|resets|try again)\b/.test(text)
  );
}

/**
 * Detect context-window-overflow prose returned as an assistant message.
 *
 * The observer holds one long-lived conversation per session and appends every
 * observation to it, so a busy session eventually pushes that conversation past
 * the model's context ceiling. The provider then answers "Prompt is too long"
 * as ordinary assistant text rather than as a structured error. Without this
 * check that text classifies as `prose`, the batch is confirmed and dropped,
 * the next observation appends yet more, and the session re-sends an
 * over-ceiling prompt on every tool call for the rest of its life — the
 * unbounded-cost path behind #3800 (2,264 rejections in one day).
 *
 * Overflow is recoverable, unlike quota or auth: recycling the conversation
 * fixes it, because a single observation prompt is field-truncated well under
 * any ceiling.
 */
export function isContextOverflowObserverOutput(raw: unknown): boolean {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return false;
  }

  if (/<(observation|summary)\b/i.test(raw) || /<skip_summary\b/i.test(raw)) {
    return false;
  }

  const text = raw.toLowerCase().replace(/\s+/g, ' ').trim();

  return (
    /\b(?:prompt|input|conversation|request) is too long\b/.test(text) ||
    /\bmaximum context length\b/.test(text) ||
    /\bcontext (?:window|length|limit)\b.{0,30}\b(?:exceeded|too (?:long|large)|overflow)\b/.test(text) ||
    /\bexceeds?\b.{0,30}\bcontext (?:window|length|limit)\b/.test(text) ||
    /\b(?:too many|exceeds the maximum number of) (?:input )?tokens\b/.test(text) ||
    /\breduce the length of the messages\b/.test(text)
  );
}

/**
 * Detect provider authentication-failure prose so claimed work can be retried
 * after the user restores provider authentication.
 */
export function isAuthFailureObserverOutput(raw: unknown): boolean {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return false;
  }

  if (/<(observation|summary)\b/i.test(raw) || /<skip_summary\b/i.test(raw)) {
    return false;
  }

  const text = raw.toLowerCase().replace(/\s+/g, ' ').trim();

  return (
    // The CLI's own signed-out wording, which says nothing about
    // "authentication" and so matched none of the patterns below.
    //
    // Anchored at BOTH ends, because every looser shape I tried let prose
    // through: a completed observation can open with the same words ("Not
    // logged in during the reboot window; …"), and it can follow them with a
    // separator too ("Not logged in — the observer recorded nothing new"). A
    // leading anchor answers the first and not the second; only requiring the
    // status to be the WHOLE response answers both. Misclassifying prose here
    // resets a batch that already succeeded and pauses the generator, so the
    // rule has to close, not narrow.
    //
    // Two shapes, and the CLI emits no third: the status alone, or the status
    // plus its own /login remediation.
    /^not logged in\b\s*[.!]?\s*$/.test(text) ||
    /^not logged in\b\s*[·|:\-–—]\s*(?:please\s+)?run\s+\/login\b\s*[.!]?\s*$/.test(text) ||
    // The remediation half of the same line: "<state> · Please run /login".
    // Required to END the response, so it is the CLI telling the user what to
    // do rather than an observation quoting the instruction — the existing
    // false cases ("Please run /login in the observed project instructions")
    // run on into a sentence and stay unmatched.
    /(?:^|[·|]\s*)please run \/login\b\s*[.!]?\s*$/.test(text) ||
    /\bfailed to authenticate\b/.test(text) ||
    /\bauthentication (?:failed|failure|error)\b/.test(text) ||
    /\b(?:authentication|auth)\b.{0,20}\b(?:required|expired|invalid|again)\b.{0,20}\/login\b/.test(text) ||
    /\b(?:api|http)\s*(?:error\s*)?:?\s*(?:401|403)\b/.test(text) ||
    /\b(?:(?:401|403)\s+(?:unauthorized|forbidden)|status\s*[:=]?\s*(?:401|403)|request failed with\s+(?:401|403))\b/.test(text) ||
    /\/login\b.{0,40}\b(?:to\s+authenticate|again|to\s+continue|and\s+retry|reauthenticate|credentials|provider|claude)\b/.test(text)
  );
}
