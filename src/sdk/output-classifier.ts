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
    /\bfailed to authenticate\b/.test(text) ||
    /\bauthentication (?:failed|failure|error)\b/.test(text) ||
    /\b(?:authentication|auth)\b.{0,20}\b(?:required|expired|invalid|again)\b.{0,20}\/login\b/.test(text) ||
    /\b(?:api|http)\s*(?:error\s*)?:?\s*(?:401|403)\b/.test(text) ||
    /\b(?:(?:401|403)\s+(?:unauthorized|forbidden)|status\s*[:=]?\s*(?:401|403)|request failed with\s+(?:401|403))\b/.test(text) ||
    /\/login\b.{0,40}\b(?:to\s+authenticate|again|to\s+continue|and\s+retry|reauthenticate|credentials|provider|claude)\b/.test(text)
  );
}

/**
 * Detect the spawned CLI's own transport/API failure returned as the response
 * body.
 *
 * When the child cannot reach the provider it does not crash — it prints its
 * error and exits 0, so the text arrives here looking like any other non-XML
 * output. Without a class of its own it falls to the generic prose branch,
 * which confirms (drops) the claimed batch: a transient network fault becomes
 * permanent data loss (#3752).
 *
 * Kept deliberately tight. A false positive requeues work and pauses the
 * generator, so the patterns anchor on the shapes the CLI actually emits —
 * the error as the whole response — rather than on any mention of a network
 * word, which an observer narrating a connectivity bug would trip.
 */
/**
 * Conditions that make a failure a *transport* failure — the request never got
 * an answer — as opposed to one the server understood and refused. Only the
 * former is worth requeuing: a refusal fails identically on every retry, so
 * treating it as transport turns one bad batch into an endless one.
 */
const NETWORK_CONDITION =
  /\b(?:connect|connection|network|socket|dns|proxy|tls|ssl|certificate|unreachable|econnrefused|econnreset|etimedout|enotfound|enetunreach|ehostunreach|epipe|econnaborted|eai_again|eproto)\b|\bfetch failed\b|\bsocket hang up\b/;

/**
 * An `<envelope> error` prefix only counts when the response is *reporting* the
 * error rather than talking about one. A report either stops at the envelope or
 * introduces its detail with punctuation; prose runs straight on into a
 * sentence ("Connection error handling was reviewed"). Punctuation is a
 * necessary condition, not a sufficient one — see
 * selfDescribingEnvelopeReportsAFailure for the half it does not carry.
 *
 * A trailing full stop is deliberately NOT a delimiter here. "Network error."
 * therefore goes undetected, which is the safe direction: a miss leaves today's
 * behaviour in place, while a false positive requeues the batch and pauses the
 * generator — a retry loop over work that already completed.
 */
const ENVELOPE_IS_A_REPORT = {
  fetchNetworkConnection: /^(?:fetch|network|connection)\s*error\b\s*(?::|-|–|—|$)\s*/,
  apiHttpRequest: /^(?:api|http|request)\s*error\b\s*(?::|-|–|—|$)/,
};

/**
 * A verb of being is what separates a sentence *about* an error from the error
 * itself. What a CLI puts after its envelope is a fragment naming a condition —
 * "upstream closed", "peer reset the stream", "ECONNRESET". What an observer
 * puts there predicates about one — "recovery is already covered by the retry
 * wrapper".
 */
const DETAIL_IS_A_CLAUSE = /\b(?:is|are|was|were|be|been|being|has|have|had)\b/;

/**
 * The words that only a failure uses. Deliberately narrower than
 * NETWORK_CONDITION, whose generic nouns — connect, connection, network,
 * socket, proxy — are exactly what prose about networking code is full of, so
 * they cannot re-admit a clause this detector has already judged to be prose.
 */
const CONCRETE_FAILURE =
  /\b(?:econnrefused|econnreset|etimedout|enotfound|enetunreach|ehostunreach|epipe|econnaborted|eai_again|eproto|unreachable|refused|timed out|timeout)\b|\bfetch failed\b|\bsocket hang up\b|\breset by peer\b/;

/**
 * `Fetch|Network|Connection error` is the one envelope family that needs no
 * separate diagnosis — the noun is itself the condition — which is also why it
 * cannot lean on NETWORK_CONDITION to reject prose the way the API family does.
 * Punctuation alone does not carry it: a narrative can be punctuated too, and
 * "Network error: recovery is already covered by the retry wrapper" is a
 * completed no-op batch, not a dead socket.
 *
 * So the envelope reports a failure when it is the whole response, when what
 * follows is a fragment rather than a clause, or when a clause names a concrete
 * failure ("the connection was reset by peer").
 *
 * This errs towards missing: "Network error: the endpoint is behind a firewall"
 * is a real failure it now rejects, having a verb of being and no concrete
 * token. That is the direction the rest of this detector is already wrong in,
 * and the cheap one — a miss leaves today's behaviour in place, while a false
 * positive requeues completed work and pauses the generator.
 */
function selfDescribingEnvelopeReportsAFailure(text: string): boolean {
  const envelope = ENVELOPE_IS_A_REPORT.fetchNetworkConnection.exec(text);
  if (envelope === null) {
    return false;
  }

  const detail = text.slice(envelope[0].length).trim();

  if (detail === '' || !DETAIL_IS_A_CLAUSE.test(detail)) {
    return true;
  }

  return CONCRETE_FAILURE.test(detail);
}

export function isTransportFailureObserverOutput(raw: unknown): boolean {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return false;
  }

  if (/<(observation|summary)\b/i.test(raw) || /<skip_summary\b/i.test(raw)) {
    return false;
  }

  // 401/403 is a credential problem, not a transport one. Leave it to the auth
  // detector so the user still gets the /login remediation instead of a silent
  // retry against a provider that will keep refusing.
  if (isAuthFailureObserverOutput(raw)) {
    return false;
  }

  const text = raw.toLowerCase().replace(/\s+/g, ' ').trim();

  // Every pattern below is anchored, without exception. The child hands its
  // failure back as the WHOLE response, so an error shape at the start is what
  // separates it from an observer narrating a past incident — and a narrative
  // is exactly what an unanchored token search catches. "The observer noted
  // that fetch failed during the previous deploy" is a completed no-op batch,
  // not a dead network.
  //
  // Anchoring can under-detect, if a future CLI prefixes its error with a
  // timestamp or a log level. That is the safe direction to be wrong in: a
  // missed detection is the behaviour that already exists today, while a false
  // positive requeues the batch AND pauses the generator, which is a retry loop.
  return (
    // "Fetch error …", "Network error …", "Connection error …" — the noun is
    // itself the condition, so no separate diagnosis is needed. The envelope
    // must still be REPORTING an error rather than naming one: an error report
    // ends there or introduces its detail with punctuation, while prose
    // continues into a sentence. "Connection error handling was reviewed" is a
    // completed observation, and anchoring alone does not catch it — the
    // narrative starts with the token.
    selfDescribingEnvelopeReportsAFailure(text) ||
    // "API Error", "HTTP error" and "Request error" are envelopes, not
    // diagnoses: they front a dead socket and a refused request identically,
    // and the two want opposite handling. Requeuing a 400 or an unknown model
    // is a loop — it will fail the same way on every retry — so the envelope
    // only counts once the message also names a network condition. A genuine
    // 5xx still arrives, through the status patterns below.
    // The report test applies here too. Without it, "API error handling for
    // connection resets was reviewed" satisfies both halves — it opens with the
    // envelope and mentions a condition — while being ordinary prose.
    (ENVELOPE_IS_A_REPORT.apiHttpRequest.test(text) && NETWORK_CONDITION.test(text)) ||
    // "Error: socket hang up" — but not "Error: no such file or directory".
    (/^error:\s/.test(text) && NETWORK_CONDITION.test(text)) ||
    // Node's own shapes: "connect ECONNREFUSED 127.0.0.1:443".
    /^(?:connect|getaddrinfo|read|write|socket)\b.*\b(?:econnrefused|econnreset|etimedout|enotfound|enetunreach|ehostunreach|epipe|econnaborted|eai_again|eproto)\b/.test(text) ||
    // The bare code, or the bare phrase, as the entire message.
    /^(?:econnrefused|econnreset|etimedout|enotfound|enetunreach|ehostunreach|epipe|econnaborted|eai_again|eproto)\b/.test(text) ||
    /^(?:fetch failed|socket hang up|connectionrefused)\b/.test(text) ||
    // A 5xx reported as the response itself.
    /^(?:api|http|request)\s*(?:error\s*)?:?\s*5\d{2}\b/.test(text) ||
    /^request failed with\s+5\d{2}\b/.test(text) ||
    /^status\s*[:=]?\s*5\d{2}\b/.test(text) ||
    /^5\d{2}\s+(?:internal server error|bad gateway|service unavailable|gateway timeout)\b/.test(text)
  );
}
