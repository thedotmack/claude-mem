/**
 * Allow-then-redact scrubber for ERROR text/stack bound for PostHog Error
 * Tracking ($exception). This is the deliberate OPPOSITE of scrub.ts:
 *
 *   - scrub.ts is a deny-by-default WHITELIST: structured properties survive
 *     only if their key is explicitly allowed. That works because those values
 *     are closed enums / counters with known shapes.
 *   - error messages and stacks are FREE-FORM — a whitelist would drop them
 *     entirely (and indeed scrubProperties has no `message`/`stack` key). So
 *     here we KEEP the text and aggressively REDACT the parts that leak PII or
 *     secrets: home dir, absolute paths, URL query strings, emails, API keys,
 *     tokens, JWTs, long hex blobs.
 *
 * HARD RULES baked in (do not regress):
 *   - PURE and NEVER THROWS. Every public function is wrapped so hostile input
 *     (null/undefined/circular/non-Error/objects with throwing getters) yields
 *     a safe fallback, never an exception. This module sits on the telemetry
 *     fire-and-forget path and must obey the "telemetry never throws" invariant.
 *   - We never emit raw paths, prompts, project names, or model output. The
 *     redaction order matters: home dir → absolute paths → URL query strings →
 *     secret/token patterns → whitespace collapse → length caps.
 *   - Output is bounded: message ≤ MESSAGE_MAX_CHARS, stack ≤ STACK_MAX_CHARS,
 *     and only the top STACK_MAX_FRAMES frames survive.
 *
 * Redaction helpers are exported so they are unit-testable in isolation
 * (tests/telemetry/error-scrub.test.ts). The top-level entry point is
 * scrubError().
 */

import os from 'os';

/** Max characters kept for the redacted error message. */
export const MESSAGE_MAX_CHARS = 500;
/** Approximate max characters kept for the redacted stack (~2KB). */
export const STACK_MAX_CHARS = 2048;
/** Max stack frames kept (top N). */
export const STACK_MAX_FRAMES = 10;

/**
 * Hard ceiling on the RAW length of any string a redaction regex is allowed to
 * see, applied at EVERY public entry point BEFORE any regex runs. This is the
 * primary defense against quadratic/catastrophic backtracking (ReDoS / CPU-DoS)
 * on hostile input — e.g. a 200KB base64 blob or a long run of email
 * local-part chars with no '@'. Without this cap the email/token regexes are
 * O(n²) on adversarial input (measured 200KB → ~32s), which would block the
 * worker and violate the "telemetry never blocks" invariant.
 *
 * 8192 is comfortably larger than every post-redaction emitted cap
 * (MESSAGE_MAX_CHARS=500, STACK_MAX_CHARS=2048) so it never truncates legitimate
 * signal we'd keep anyway, yet small enough that even a purely quadratic regex
 * over the whole buffer stays sub-millisecond. The bounded regexes below are a
 * second, independent layer: even within 8KB they cannot backtrack quadratically.
 */
export const MAX_RAW_INPUT_CHARS = 8192;

/** Placeholder substituted for any redacted secret / token / email. */
export const REDACTED = '[REDACTED]';

/**
 * Hard-truncates a raw input string to MAX_RAW_INPUT_CHARS BEFORE any regex is
 * allowed to run on it. Pure / never throws. Non-strings are coerced safely.
 */
export function capRawInput(text: unknown): string {
  try {
    if (typeof text !== 'string') {
      if (text === null || text === undefined) return '';
      try {
        text = String(text);
      } catch {
        return '';
      }
    }
    const s = text as string;
    return s.length > MAX_RAW_INPUT_CHARS ? s.slice(0, MAX_RAW_INPUT_CHARS) : s;
  } catch {
    return '';
  }
}

/**
 * Replaces the user's home directory prefix with `~`. Done FIRST so later
 * path/basename redaction operates on already-tildified paths and we never
 * leak the username embedded in the home path.
 *
 * os.homedir() can theoretically throw on exotic platforms; guarded so the
 * helper stays pure.
 */
export function redactHomeDir(text: string): string {
  if (typeof text !== 'string' || text.length === 0) return text ?? '';
  let home = '';
  try {
    home = os.homedir() || '';
  } catch {
    home = '';
  }
  if (!home) return text;
  // Replace every occurrence of the literal home path. Escape regex metachars
  // in the home path so it is matched literally (paths can contain e.g. '.').
  const escaped = home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  try {
    return text.replace(new RegExp(escaped, 'g'), '~');
  } catch {
    // If the constructed RegExp is somehow invalid, fall back to split/join.
    return text.split(home).join('~');
  }
}

/**
 * Collapses absolute filesystem paths down to their basename, so we keep the
 * useful "which file" signal without leaking the full directory tree (project
 * names, usernames, machine layout). Tildified (`~/...`) paths are left as-is —
 * redactHomeDir already stripped the sensitive prefix.
 *
 * Matches POSIX (`/a/b/c.ts`) and Windows (`C:\a\b\c.ts`, `\\unc\share`) style
 * absolute paths. Relative paths and bare basenames are untouched.
 */
export function redactAbsolutePaths(text: string): string {
  if (typeof text !== 'string' || text.length === 0) return text ?? '';
  let out = text;
  try {
    // POSIX absolute paths: a leading '/' followed by at least one segment.
    // Stop at whitespace, quotes, parens, or colon (stack frames use `:line`).
    out = out.replace(/(?<![~\w])\/(?:[^\s/:"'()]+\/)+([^\s/:"'()]+)/g, '$1');
    // Windows drive-absolute paths: C:\foo\bar\baz.ts
    out = out.replace(/[A-Za-z]:\\(?:[^\s\\:"'()]+\\)*([^\s\\:"'()]+)/g, '$1');
    // Windows UNC paths: \\server\share\file
    out = out.replace(/\\\\[^\s\\:"'()]+(?:\\[^\s\\:"'()]+)*\\([^\s\\:"'()]+)/g, '$1');
  } catch {
    return text;
  }
  return out;
}

/**
 * Strips query strings (and fragments) AND embedded userinfo credentials from
 * URLs / connection strings so we never leak tokens, session ids, signed-URL
 * credentials carried as query params, or `user:pass@host` credentials embedded
 * in DSNs / connection strings.
 *
 * Handles ANY `scheme://...` (not just http) so non-http connection strings —
 * postgres://, mysql://, redis://, mongodb+srv://, amqp://, ... — also get
 * their `user:pass@` userinfo and query strings stripped. The username must NOT
 * survive (previously only the password died by incidental email-regex luck);
 * the whole `user:pass@` is replaced with `[REDACTED]@`. Keeps the scheme + host
 * + path. Pure / never throws.
 */
export function redactUrlQueryStrings(text: string): string {
  if (typeof text !== 'string' || text.length === 0) return text ?? '';
  try {
    // Match ANY scheme:// URL (http, ws, postgres, redis, mongodb+srv, amqp, …)
    // up to the next whitespace/quote/paren. A scheme is letters/digits with
    // optional + . - (e.g. mongodb+srv). For each match: strip userinfo
    // (user:pass@ → [REDACTED]@) and drop everything from the first ? or #.
    return text.replace(
      /\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'()]+/g,
      match => {
        let out = match.replace(/[?#].*$/, '');
        // Strip userinfo: scheme://USERINFO@host → scheme://[REDACTED]@host.
        out = out.replace(
          /^([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/@\s]+@/,
          `$1${REDACTED}@`
        );
        return out;
      }
    );
  } catch {
    return text;
  }
}

/**
 * Masks secret-shaped substrings: emails, OpenAI-style `sk-...` keys, PostHog
 * `phc_...` keys, JWTs, AWS access key IDs (AKIA…), long hex blobs, generic
 * high-entropy tokens, and IPv4 addresses. Each match becomes [REDACTED]. Order
 * within is least-greedy-first so a JWT isn't partially eaten by the generic
 * token rule. Pure / never throws.
 */
export function redactSecrets(text: string): string {
  if (typeof text !== 'string' || text.length === 0) return text ?? '';
  try {
    let out = text;
    // Emails. Quantifiers are BOUNDED ({1,64} local / {1,255} domain / {2,24}
    // TLD) so a long run of local-part chars with no '@' (or a giant domain run)
    // cannot drive O(n²) backtracking. The bounds exceed RFC 5321 limits
    // (local ≤ 64, domain ≤ 255) so every real address still matches.
    out = out.replace(/[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,24}/g, REDACTED);
    // JWTs: three base64url segments separated by dots (header.payload.sig).
    // Each segment is BOUNDED ({10,512}) so a long dot-free base64 run cannot
    // backtrack quadratically chasing the required dots. Real JWT segments are
    // far under 512 chars.
    out = out.replace(/\b[A-Za-z0-9_-]{10,512}\.[A-Za-z0-9_-]{10,512}\.[A-Za-z0-9_-]{10,512}\b/g, REDACTED);
    // Provider keys with known prefixes (sk-, phc_, pk-, rk_, ghp_, xoxb-, ...)
    // followed by a run of token chars. Prefix list kept broad but anchored.
    // Upper-bounded ({8,512}) to stay linear on adversarial runs.
    out = out.replace(
      /\b(?:sk|pk|rk|ak|phc|phx|ph|ghp|gho|ghs|xox[bpasr])[-_][A-Za-z0-9_-]{8,512}\b/gi,
      REDACTED
    );
    // Bearer tokens: "Bearer <token>".
    out = out.replace(/\bBearer\s+[A-Za-z0-9._-]{8,512}\b/gi, REDACTED);
    // AWS access key IDs: AKIA/ASIA/AGPA/AIDA/AROA/ANPA/ANVA/AIPA + 16 base32.
    out = out.replace(/\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA)[0-9A-Z]{16}\b/g, REDACTED);
    // Long hex blobs (sha/uuid-without-dashes/api hashes): 24+ hex chars.
    // Upper-bounded ({24,4096}) so an enormous hex run stays linear.
    out = out.replace(/\b[0-9a-fA-F]{24,4096}\b/g, REDACTED);
    // UUIDs.
    out = out.replace(
      /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g,
      REDACTED
    );
    // Generic high-entropy tokens: 32+ chars of base64url-ish alphabet that
    // contain at least one digit (avoids redacting ordinary long words).
    // The "contains a digit" requirement is a lookahead that previously scanned
    // the WHOLE run from every position → O(n²) on a long digit-free run. It is
    // now bounded ([...]{0,4096}) and the run itself is bounded ({32,4096}) so
    // the work per position is capped and total work stays linear in practice.
    out = out.replace(/\b(?=[A-Za-z0-9+/_-]{0,4096}\d)[A-Za-z0-9+/_-]{32,4096}={0,2}\b/g, REDACTED);
    // IPv4 addresses (internal IPs/hostnames leak in network errors). Each
    // octet is constrained to 0-255 so 4-part dotted quads match but ordinary
    // 3-part version numbers (1.2.3) do NOT. Word-boundaried both sides so a
    // longer dotted token (e.g. a 5-part version) is left alone.
    out = out.replace(
      /\b(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}\b/g,
      REDACTED
    );
    return out;
  } catch {
    return text;
  }
}

/** Collapses runs of whitespace to single spaces and trims. Pure. */
export function collapseWhitespace(text: string): string {
  if (typeof text !== 'string' || text.length === 0) return text ?? '';
  try {
    return text.replace(/[ \t\f\v]+/g, ' ').replace(/ *\n */g, '\n').trim();
  } catch {
    return text;
  }
}

/**
 * Full redaction pipeline for a single line/message, applied in the mandated
 * order: home dir → absolute paths → URL query strings → secrets → whitespace.
 * Pure / never throws. Length capping is applied by the callers (scrubMessage /
 * scrubStack) so this stays composable.
 */
export function redactText(text: unknown): string {
  // CAP FIRST: no regex in this pipeline ever sees more than MAX_RAW_INPUT_CHARS.
  // This is the shared choke point for both scrubMessage and scrubStack's
  // per-line redaction, so the hard bound is enforced here regardless of caller.
  let out = capRawInput(text);
  if (out.length === 0) return '';
  out = redactHomeDir(out);
  out = redactAbsolutePaths(out);
  out = redactUrlQueryStrings(out);
  out = redactSecrets(out);
  return out;
}

/** Redacts + collapses + caps an error message to MESSAGE_MAX_CHARS. */
export function scrubMessage(message: unknown): string {
  try {
    // Cap raw input BEFORE redaction (defense-in-depth; redactText also caps).
    const redacted = collapseWhitespace(redactText(capRawInput(message)));
    return redacted.length > MESSAGE_MAX_CHARS
      ? redacted.slice(0, MESSAGE_MAX_CHARS)
      : redacted;
  } catch {
    return '';
  }
}

/**
 * Redacts a stack trace: keeps only the top STACK_MAX_FRAMES lines, redacts
 * each (paths/secrets), then caps the whole thing at STACK_MAX_CHARS. The first
 * line of a JS stack is the "Name: message" header; we keep it and the frame
 * lines beneath. Pure / never throws.
 */
export function scrubStack(stack: unknown): string {
  try {
    if (typeof stack !== 'string' || stack.length === 0) return '';
    // Cap raw input BEFORE splitting/redaction so neither the split nor any
    // per-line redactText regex nor the defensive redactSecrets pass below can
    // ever see more than MAX_RAW_INPUT_CHARS. Keeping only the top frames and
    // the existing STACK_MAX_CHARS cap still apply to the final emitted size.
    const capped = capRawInput(stack);
    const lines = capped.split('\n');
    // Keep header + top frames. STACK_MAX_FRAMES counts frame lines; the header
    // line (lines[0]) is kept additionally when present.
    const kept = lines.slice(0, STACK_MAX_FRAMES + 1);
    const redacted = kept
      .map(line => redactText(line).replace(/[ \t]+/g, ' ').trimEnd())
      .join('\n')
      .trim();
    // Secrets can span the joined text; run one more secret pass defensively.
    const finalText = redactSecrets(redacted);
    return finalText.length > STACK_MAX_CHARS
      ? finalText.slice(0, STACK_MAX_CHARS)
      : finalText;
  } catch {
    return '';
  }
}

/** The shape we hand to PostHog's exception capture. */
export type ScrubbedError = {
  /** Error constructor name / type (e.g. "TypeError"). */
  type: string;
  /** Redacted, length-capped message. */
  message: string;
  /** Redacted, frame-trimmed, length-capped stack (may be ''). */
  stack: string;
};

/**
 * Extracts a safe `type` (constructor name) from an arbitrary thrown value.
 * Never throws — objects with throwing getters or null prototypes fall back to
 * 'Error'. Pure.
 */
export function extractErrorType(err: unknown): string {
  try {
    if (err instanceof Error) {
      // err.name can be overridden via a throwing getter on exotic objects.
      try {
        const name = err.name;
        if (typeof name === 'string' && name.length > 0) {
          return collapseWhitespace(name).slice(0, 100);
        }
      } catch {
        /* fall through */
      }
      try {
        const ctor = err.constructor?.name;
        if (typeof ctor === 'string' && ctor.length > 0) return ctor.slice(0, 100);
      } catch {
        /* fall through */
      }
      return 'Error';
    }
    if (err === null) return 'NullError';
    if (err === undefined) return 'UndefinedError';
    if (typeof err === 'string') return 'StringError';
    if (typeof err === 'object') {
      try {
        const ctor = (err as { constructor?: { name?: unknown } }).constructor?.name;
        if (typeof ctor === 'string' && ctor.length > 0) return ctor.slice(0, 100);
      } catch {
        /* fall through */
      }
      return 'ObjectError';
    }
    return typeof err === 'number' || typeof err === 'boolean'
      ? `${typeof err}Error`
      : 'UnknownError';
  } catch {
    return 'Error';
  }
}

/**
 * Safely reads `.message` / `.stack` off an arbitrary value without ever
 * throwing (getters can throw). Falls back to String(value) for non-Error
 * throws, and to '' on total failure.
 */
function safeReadField(err: unknown, field: 'message' | 'stack'): string {
  try {
    if (err && typeof err === 'object') {
      try {
        const value = (err as Record<string, unknown>)[field];
        if (typeof value === 'string') return value;
      } catch {
        return '';
      }
    }
    return '';
  } catch {
    return '';
  }
}

/**
 * Top-level entry: turn an arbitrary thrown value into a redacted, bounded
 * { type, message, stack } safe to send to PostHog. NEVER throws — every
 * branch is guarded; hostile input yields a best-effort safe object.
 */
export function scrubError(err: unknown): ScrubbedError {
  try {
    const type = extractErrorType(err);

    let rawMessage = safeReadField(err, 'message');
    if (!rawMessage) {
      // Non-Error throw (string/number/object): stringify defensively.
      try {
        if (typeof err === 'string') rawMessage = err;
        else if (err !== null && err !== undefined && !(err instanceof Error)) {
          rawMessage = String(err);
        }
      } catch {
        rawMessage = '';
      }
    }

    const rawStack = safeReadField(err, 'stack');

    return {
      type,
      message: scrubMessage(rawMessage),
      stack: scrubStack(rawStack),
    };
  } catch {
    // Absolute last-resort fallback — still a valid object, still no throw.
    return { type: 'Error', message: '', stack: '' };
  }
}

/**
 * Normalizes a redacted message into a stable fingerprint TEMPLATE so that
 * messages differing only by varying numbers / ids / quoted values collapse to
 * ONE fingerprint. Used by the rate-limiter (telemetry.ts) so a storm of the
 * "same" error with different embedded ids is deduped to a single send.
 *
 * Replaces: [REDACTED] (already-masked), runs of digits, quoted substrings,
 * and remaining hex blobs with stable tokens. Pure / never throws.
 */
export function messageTemplate(message: unknown): string {
  try {
    const base = typeof message === 'string' ? message : '';
    return base
      .replace(/\[REDACTED\]/g, '§')
      .replace(/'[^']*'/g, "'§'")
      .replace(/"[^"]*"/g, '"§"')
      .replace(/\b\d+\b/g, '§')
      .replace(/[ \t]+/g, ' ')
      .trim()
      .slice(0, 200);
  } catch {
    return '';
  }
}
