/**
 * Secret redaction for content bound for the observer LLM, SQLite, and
 * Chroma — the opposite job from services/telemetry/error-scrub.ts.
 *
 * error-scrub.ts scrubs FREE-FORM error text bound for PostHog: it collapses
 * every match to one placeholder ([REDACTED]) and is allowed to be lossy
 * (paths get basenamed, output is length-capped) because the point is never
 * to reconstruct the original text. This module runs on USER DATA we still
 * want to keep — tool inputs/outputs, prompts, file contents — so it must
 * stay lossless except for the specific secret spans it strips, and each
 * match is tagged with its kind ([REDACTED:<kind>]) so stored/summarized
 * text still tells a human (or the observer) what used to be there.
 *
 * Two entry points:
 *   - redactSecrets(text): pattern-based pass over a string (PEM blocks,
 *     provider key prefixes, JWTs, auth headers, URL userinfo, XML secret
 *     elements, and generic KEY=value/KEY: value/--key value assignments
 *     whose key name looks sensitive).
 *   - redactSecretsDeep(value): recurses into a parsed JSON-shaped value
 *     (tool inputs/responses are plain objects before they get
 *     JSON.stringify'd) and additionally redacts any object value whose KEY
 *     matches the sensitive-key regex, even if the value itself doesn't
 *     look like a secret pattern (e.g. `"password": "hunter2"`).
 *
 * Pure, never throws — same "must not blow up ingest" invariant as
 * error-scrub.ts, just enforced with plain try/catch here rather than a
 * shared harness.
 */

const tag = (kind: string): string => `[REDACTED:${kind}]`;

// ponytail: unanchored substring match, not per-word-boundary per term — so
// "author", "authenticate" etc. also flag (they contain "auth"). That's the
// spec as given; tighten to per-term boundaries if false positives show up
// on real tool input in practice.
export const SENSITIVE_KEY_REGEX =
  /(pass(word)?|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|auth|credential|session[_-]?key)/i;

const TYPE_LIKE_VALUES =
  /^(string|number|boolean|any|unknown|object|void|null|undefined|true|false|Array|Record|Map|Set)(<.*>)?$/i;

/** True when an unquoted assignment RHS looks like a real secret literal, not code. */
function isLiteralValue(value: string): boolean {
  if (!value) return false;
  if (TYPE_LIKE_VALUES.test(value)) return false;
  // getToken(), foo() — a call, not a value.
  if (/^[A-Za-z_$][\w$]*\(\)?$/.test(value)) return false;
  return value.length >= 6;
}

function redactPemBlocks(text: string): string {
  return text.replace(
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    tag('private_key'),
  );
}

function redactProviderKeys(text: string): string {
  let out = text;
  out = out.replace(/\b(?:AKIA|ASIA|AROA|AIDA)[0-9A-Z]{16}\b/g, tag('aws_access_key_id'));
  // Specific prefixes before the generic sk- fallback so they don't get
  // double-matched/partially eaten by it.
  out = out.replace(/\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, tag('anthropic_key'));
  out = out.replace(/\bsk-proj-[A-Za-z0-9_-]{20,}\b/g, tag('openai_key'));
  out = out.replace(/\bsk-[A-Za-z0-9]{20,}\b/g, tag('openai_key'));
  out = out.replace(/\bgh[pousr]_[A-Za-z0-9]{20,255}\b/g, tag('github_token'));
  out = out.replace(/\bgithub_pat_[A-Za-z0-9_]{20,255}\b/g, tag('github_token'));
  out = out.replace(/\bAIza[0-9A-Za-z_-]{20,100}\b/g, tag('google_api_key'));
  out = out.replace(/\bxox[abprs]-[A-Za-z0-9-]{10,72}\b/g, tag('slack_token'));
  out = out.replace(/\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/g, tag('stripe_key'));
  return out;
}

function redactJwt(text: string): string {
  // Three base64url segments joined by dots — bounded like error-scrub's JWT
  // rule so a long dot-free run can't drive quadratic backtracking.
  return text.replace(/\bey[A-Za-z0-9_-]{5,512}\.[A-Za-z0-9_-]{5,512}\.[A-Za-z0-9_-]{5,512}\b/g, tag('jwt'));
}

function redactAuthHeader(text: string): string {
  return text.replace(
    /\b(Authorization\s*:\s*)(Bearer|Basic)\s+\S+/gi,
    (_m, prefix: string, scheme: string) => `${prefix}${scheme} ${tag('auth_header')}`,
  );
}

/** `scheme://user:pass@host` → `scheme://[REDACTED:url_credentials]@host`. Keeps scheme + host + path. */
function redactUrlCredentials(text: string): string {
  return text.replace(
    /\b([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s"'/@]+@/g,
    (_m, scheme: string) => `${scheme}${tag('url_credentials')}@`,
  );
}

/** `<Password>...</Password>`, `<apiKey>...</apiKey>` (SOAP-style credential XML). */
function redactXmlElements(text: string): string {
  return text.replace(/<([A-Za-z][\w:-]{0,60})>([^<]{0,4096})<\/\1>/g, (match, tagName: string) => {
    if (!SENSITIVE_KEY_REGEX.test(tagName)) return match;
    return `<${tagName}>${tag(`field:${tagName.toLowerCase()}`)}</${tagName}>`;
  });
}

const KEY_PART = '[A-Za-z_][A-Za-z0-9_.-]{0,60}';
const QUOTED_VALUE = `"(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'`;
// Unquoted value token: stops at whitespace and the punctuation that ends a
// code statement/collection (`;`, `,`, braces, brackets, parens) so
// `secret: string;` and `token: number)` don't drag trailing syntax into the
// captured value and defeat the type-annotation check in isLiteralValue.
const VALUE_TOKEN = `[^\\s"'{}\\[\\],;()]+`;

const ASSIGNMENT_REGEX = new RegExp(
  `(")?(${KEY_PART})(")?(\\s*[:=]\\s*)(${QUOTED_VALUE}|${VALUE_TOKEN})`,
  'g',
);
const CLI_FLAG_REGEX = new RegExp(
  `(--(${KEY_PART}))([= ]+)(${QUOTED_VALUE}|${VALUE_TOKEN})`,
  'g',
);

function shouldRedactAssignment(key: string, raw: string): boolean {
  if (!SENSITIVE_KEY_REGEX.test(key)) return false;
  // Authorization headers are handled by redactAuthHeader already — skip
  // here so "Authorization: Bearer [REDACTED:auth_header]" isn't re-matched
  // as a plain key:value assignment on the scheme word.
  if (key.toLowerCase() === 'authorization') return false;
  const quoted = raw.length >= 2 && ((raw[0] === '"' && raw.endsWith('"')) || (raw[0] === "'" && raw.endsWith("'")));
  if (quoted) return raw.length > 2;
  return isLiteralValue(raw);
}

function redactedValueFor(raw: string, key: string): string {
  const quoted = raw.length >= 2 && ((raw[0] === '"' && raw.endsWith('"')) || (raw[0] === "'" && raw.endsWith("'")));
  const quoteChar = quoted ? raw[0] : '';
  return `${quoteChar}${tag(`field:${key.toLowerCase()}`)}${quoteChar}`;
}

/** `--key value` / `--key=value` CLI flags where KEY matches the sensitive-key regex. */
function redactCliFlags(text: string): string {
  return text.replace(CLI_FLAG_REGEX, (match, flagKey: string, key: string, sep: string, raw: string) => {
    if (!shouldRedactAssignment(key, raw)) return match;
    return `${flagKey}${sep}${redactedValueFor(raw, key)}`;
  });
}

/**
 * Generic `KEY=value` / `"key": "value"` / `key: value` assignments where
 * KEY matches the sensitive-key regex. Skips unquoted values that look like
 * code (type annotations, `getToken()` calls) rather than a literal — see
 * isLiteralValue.
 */
function redactAssignments(text: string): string {
  return text.replace(
    ASSIGNMENT_REGEX,
    (match, keyQuoteOpen: string | undefined, key: string, keyQuoteClose: string | undefined, sep: string, raw: string) => {
      if (!shouldRedactAssignment(key, raw)) return match;
      return `${keyQuoteOpen ?? ''}${key}${keyQuoteClose ?? ''}${sep}${redactedValueFor(raw, key)}`;
    },
  );
}

/**
 * Pattern-based redaction pass over a single string. Order: PEM blocks (so
 * later passes never scan a giant base64 blob) → provider key prefixes →
 * JWTs → auth headers → URL userinfo → XML secret elements → CLI flags →
 * generic assignments. Pure, never throws.
 */
export function redactSecrets(text: string): string {
  if (typeof text !== 'string' || text.length === 0) return text ?? '';
  try {
    let out = text;
    out = redactPemBlocks(out);
    out = redactProviderKeys(out);
    out = redactJwt(out);
    out = redactAuthHeader(out);
    out = redactUrlCredentials(out);
    out = redactXmlElements(out);
    out = redactCliFlags(out);
    out = redactAssignments(out);
    return out;
  } catch {
    // Never throw from the redactor — worst case the raw text passes through
    // unredacted, which callers should treat as best-effort, not a guarantee.
    return text;
  }
}

/**
 * Recurses into a parsed JSON-shaped value (tool inputs/responses are plain
 * objects/arrays before JSON.stringify). String leaves get the pattern pass
 * above; object values whose KEY matches the sensitive-key regex are
 * replaced outright (catches secrets with no recognizable pattern, e.g.
 * `"password": "hunter2"`).
 */
export function redactSecretsDeep(value: unknown, keyHint?: string): unknown {
  try {
    if (typeof value === 'string') {
      if (keyHint && value.length > 0 && SENSITIVE_KEY_REGEX.test(keyHint)) {
        return tag(`field:${keyHint.toLowerCase()}`);
      }
      return redactSecrets(value);
    }
    if (Array.isArray(value)) {
      return value.map(v => redactSecretsDeep(v));
    }
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = redactSecretsDeep(v, k);
      }
      return out;
    }
    return value;
  } catch {
    return value;
  }
}
