/** Bounded, cancellable compression of oversized observation fields (#3839). */

import { stripVTControlCharacters } from 'node:util';
import { OBS_PROMPT_FIELD_MAX_CHARS } from '../../sdk/prompts.js';
import { logger } from '../../utils/logger.js';

export interface FieldCompressionOptions {
  /** Forward to the actual request, not just a promise race. */
  signal: AbortSignal;
}

/**
 * One model call. Two-argument callbacks remain assignable, but cannot cancel
 * their request until they forward options.signal to their transport.
 * Return null for unusable answers; throw provider errors unchanged so the
 * owning generator retains quota/auth policy and ownership of queued work.
 */
export type FieldCompressor = (
  text: string, budgetChars: number, options: FieldCompressionOptions,
) => Promise<string | null>;

/** How long one compression pass may run before the observer gives up on it. */
export const FIELD_OPTIMIZE_TIMEOUT_MS = 30_000;

/** Conservative default, not a ceiling; providers may supply their own budget. */
export const FIELD_OPTIMIZE_DEFAULT_MAX_INPUT_BYTES = 32_000;
/** @deprecated Use FIELD_OPTIMIZE_DEFAULT_MAX_INPUT_BYTES. This value is bytes. */
export const FIELD_OPTIMIZE_MAX_INPUT_CHARS = FIELD_OPTIMIZE_DEFAULT_MAX_INPUT_BYTES;

export interface FieldOptimizeOptions {
  signal?: AbortSignal;
  /** Deadline for each request; signal cancels the entire multistage operation. */
  timeoutMs?: number;
  /**
   * Per-request UTF-8 byte budget INCLUDING buildFieldCompressionPrompt framing.
   * Providers should derive this from their available input budget after reserving
   * transport/system framing and output tokens. Can raise or lower the default.
   */
  maxInputBytes?: number;
  /** Optional provider/operator limit on total model requests for one field. */
  maxRequests?: number;
  /** @deprecated Byte-budget alias, not a character count. maxInputBytes wins. */
  maxInputChars?: number;
}

/** Not a provider failure or permission to drop/confirm a pending message. */
export class FieldInputBudgetError extends Error {
  constructor(readonly inputBytes: number, readonly maxInputBytes: number) {
    super(`Field compression needs at least ${inputBytes} request bytes; budget is ${maxInputBytes}`);
    this.name = 'FieldInputBudgetError';
  }
}

/** Retain queued work; never treat an incomplete reduction as a complete summary. */
export class FieldCompressionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FieldCompressionError';
  }
}

/**
 * Target size for compressed output, as a fraction of the per-field budget.
 * Leaves headroom so a slightly-over reply still fits rather than being thrown
 * away for missing the cap by a few characters.
 */
const FIELD_OPTIMIZE_TARGET_RATIO = 0.8;

export function buildFieldCompressionPrompt(text: string, budgetChars: number): string {
  return `Condense the tool payload below to under ${budgetChars} characters.

It is going into an observation record, so preserve everything that carries
signal: file paths, identifiers, commands, counts, error text, status codes, and
any concrete values a later reader would need. Drop repetition, boilerplate and
filler. Keep the original ordering. Preserve binary-omission markers and their
metadata; do not infer the contents of omitted binary data.
The payload may be one consecutive fragment or ordered partial summaries of a
larger record. Preserve concrete details and ordering; do not invent missing
context or treat an incomplete fragment as a syntax error to fix.

Reply with the condensed payload only — no preamble, no commentary, no code
fences.

<payload>
${text}
</payload>`;
}

function binaryMarker(kind: string, size: number, unit: string): string {
  return `[binary omitted: ${kind}; ${unit}=${size}]`;
}

/**
 * Bun's VT helper can leave OSC title terminators behind. Strip only complete
 * OSC spans for classification, in one pass even with unterminated sequences.
 */
function stripCompleteOsc(text: string): string {
  const parts: string[] = [];
  let oscStart = -1, copyFrom = 0;
  for (let i = 0; i < text.length; i++) {
    if (oscStart === -1) {
      if (text[i] === '\x1b' && text[i + 1] === ']') {
        oscStart = i;
        i++;
      } else if (text[i] === '\u009d') {
        oscStart = i;
      }
      continue;
    }
    const escapedSt = text[i] === '\x1b' && text[i + 1] === '\\';
    if (text[i] === '\x07' || text[i] === '\u009c' || escapedSt) {
      parts.push(text.slice(copyFrom, oscStart));
      if (escapedSt) i++;
      copyFrom = i + 1;
      oscStart = -1;
    }
  }
  parts.push(text.slice(copyFrom));
  return parts.join('');
}

function normalizeBytes(bytes: Buffer, kind: string, size: number, unit: string): string {
  const decoded = bytes.toString('utf8');
  // ANSI/OSC controls are normal in UTF-8 logs, not evidence of binary data.
  // Ignore recognized terminal controls only for classification; return the
  // original text so log content and OSC metadata are preserved exactly.
  if (bytes.length > 0 && Buffer.from(decoded, 'utf8').equals(bytes) &&
      !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(stripVTControlCharacters(stripCompleteOsc(decoded)))) {
    return `[decoded ${kind}; ${unit}=${size}]\n${decoded}`;
  }
  return binaryMarker(kind, size, unit);
}

function decodeBase64(data: string, allowWhitespace: boolean = false): Buffer | null {
  const canonical = (allowWhitespace ? data.replace(/[ \t\r\n]+/g, '') : data)
    .replace(/-/g, '+').replace(/_/g, '/');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(canonical)) return null;
  const bytes = Buffer.from(canonical, 'base64');
  const encoded = bytes.toString('base64');
  // Buffer.from alone accepts malformed/truncated input and can lose text.
  if (canonical.includes('=') ? encoded !== canonical : encoded.replace(/=+$/, '') !== canonical) {
    return null;
  }
  return bytes;
}

function hasBinarySignature(bytes: Buffer): boolean {
  return /^(89504e470d0a1a0a|ffd8ff|474946383[79]61|255044462d|52494646)/
    .test(bytes.subarray(0, 8).toString('hex'));
}

/** Normalize at serialization so byte arrays never enter model input. */
function serializeField(value: unknown): { raw: string; normalized: boolean } {
  let normalized = false;
  const raw = JSON.stringify(value, function (key, item) {
    const original = this[key];
    if (original instanceof ArrayBuffer || ArrayBuffer.isView(original)) {
      normalized = true;
      const bytes = original instanceof ArrayBuffer ? Buffer.from(original) :
        Buffer.from(original.buffer, original.byteOffset, original.byteLength);
      return normalizeBytes(bytes, Buffer.isBuffer(original) ? 'Buffer' : original.constructor.name,
        original.byteLength, 'bytes');
    }
    if (item && typeof item === 'object' && item.type === 'Buffer' &&
        Array.isArray(item.data) && item.data.every((n: unknown) =>
          typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 255)) {
      normalized = true;
      return { ...item, data: normalizeBytes(Buffer.from(item.data), 'Buffer', item.data.length, 'bytes') };
    }
    if (typeof item !== 'string') return item;
    // Tool responses can contain serialized JSON rather than an object. Parse
    // only containers, and preserve string-valued output and all sibling data.
    const container = item.trim();
    if ((container.startsWith('{') && container.endsWith('}')) ||
        (container.startsWith('[') && container.endsWith(']'))) {
      let parsed: unknown;
      try { parsed = JSON.parse(container); } catch { /* Ordinary non-JSON text. */ }
      if (parsed && typeof parsed === 'object') {
        const nested = serializeField(parsed);
        if (nested.normalized) {
          normalized = true;
          return nested.raw;
        }
      }
    }
    const replaced = item.replace(
      /data:([\w.+-]+\/[\w.+-]+)(;[\w=.+-]+)*;base64,([A-Za-z0-9+/=_-]+)/g,
      (_match, mime: string, _parameters: string, data: string) => {
        const bytes = decodeBase64(data);
        if (!bytes) return _match;
        normalized = true;
        return normalizeBytes(bytes, `data:${mime};base64`, data.length, 'encoded_chars');
      },
    );
    const declaredBase64 = /^(base64|b64_json)$/i.test(key) ||
      (key === 'data' && (this.encoding === 'base64' || this.type === 'base64'));
    const binaryCandidate = /^(iVBOR|\/9j|R0lG|JVBE|UklG)/.test(replaced);
    // MIME/content type does not specify an encoding. Undeclared payloads need
    // both canonical base64 and a decoded binary signature, not just an alphabet.
    if ((declaredBase64 || binaryCandidate) && replaced.length >= 1024) {
      const bytes = decodeBase64(replaced, declaredBase64);
      if (bytes && (declaredBase64 || hasBinarySignature(bytes))) {
        normalized = true;
        return normalizeBytes(bytes, 'base64', replaced.length, 'encoded_chars');
      }
    }
    return replaced;
  }, 2) ?? '';
  return { raw, normalized };
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Field optimization aborted', 'AbortError');
}

/** Abort the request before settling the deadline; always remove listeners. */
async function compressWithDeadline(
  compress: FieldCompressor, text: string, budget: number, options: FieldOptimizeOptions,
): Promise<string | null> {
  const controller = new AbortController();
  const outer = options.signal;
  if (outer?.aborted) throw abortReason(outer);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      const reason = abortReason(outer!);
      controller.abort(reason);
      reject(reason);
    };
    outer?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => {
      const reason = new DOMException('Field compression timed out', 'TimeoutError');
      controller.abort(reason);
      reject(reason);
    }, options.timeoutMs ?? FIELD_OPTIMIZE_TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        if (controller.signal.aborted) throw abortReason(controller.signal);
        return compress(text, budget, { signal: controller.signal });
      }),
      cancelled,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) outer?.removeEventListener('abort', onAbort);
  }
}

/** Lossless partition: prefer complete lines/words, never split a surrogate pair. */
function* splitField(text: string, maxBytes: number): Generator<string> {
  let start = 0, end = 0, bytes = 0, lineEnd = 0, wordEnd = 0, lineBytes = 0, wordBytes = 0;
  while (end < text.length) {
    const cp = text.codePointAt(end)!;
    const width = cp > 0xffff ? 2 : 1;
    const size = cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
    if (size > maxBytes) throw new FieldInputBudgetError(size, maxBytes);
    if (bytes + size > maxBytes) {
      const cut = lineBytes >= maxBytes / 2 ? lineEnd : wordBytes >= maxBytes / 2 ? wordEnd : end;
      yield text.slice(start, cut);
      start = end = cut;
      bytes = lineEnd = wordEnd = lineBytes = wordBytes = 0;
      continue;
    }
    end += width;
    bytes += size;
    if (cp === 10) { lineEnd = end; lineBytes = bytes; }
    if (cp === 10 || cp === 13 || cp === 32 || cp === 9) { wordEnd = end; wordBytes = bytes; }
  }
  if (start < end) yield text.slice(start, end);
}

/**
 * Each map visits every source fragment in order. Intermediate results must
 * shrink in bytes, so reduction terminates without a fixed input-size ceiling
 * or a retry ladder. No partial stage is returned if a request fails.
 */
async function condenseField(
  raw: string, compress: FieldCompressor, budget: number, maxInputBytes: number,
  options: FieldOptimizeOptions, fits: (text: string) => boolean,
): Promise<string | null> {
  const framingBytes = Buffer.byteLength(buildFieldCompressionPrompt('', budget), 'utf8');
  // Reserve enough room for any single Unicode scalar before starting work.
  if (maxInputBytes < framingBytes + 4) {
    throw new FieldInputBudgetError(framingBytes + 4, maxInputBytes);
  }
  const payloadBytes = maxInputBytes - framingBytes;
  // A source-derived guard scales with input, unlike a fixed large-field cap.
  // Preferred boundaries use at least half a window; map output halves bytes.
  const maxRequests = options.maxRequests ??
    4 * Math.ceil(Buffer.byteLength(raw, 'utf8') / payloadBytes) +
    Math.ceil(Math.log2(Buffer.byteLength(raw, 'utf8') + 1)) + 1;
  let requests = 0;
  let current = raw;
  let reduced = false;
  const request = async (text: string, target: number): Promise<string | null> => {
    if (requests >= maxRequests) {
      throw new FieldCompressionError('Field compression exhausted its request budget');
    }
    // Recheck the actual prompt, not an estimate or a character-count proxy.
    const inputBytes = Buffer.byteLength(buildFieldCompressionPrompt(text, target), 'utf8');
    if (inputBytes > maxInputBytes) throw new FieldInputBudgetError(inputBytes, maxInputBytes);
    requests++;
    const result = await compressWithDeadline(compress, text, target, options);
    if (options.signal?.aborted) throw abortReason(options.signal);
    return result?.trim() || null;
  };
  while (true) {
    if (options.signal?.aborted) throw abortReason(options.signal);
    const currentBytes = Buffer.byteLength(current, 'utf8');
    if (currentBytes <= payloadBytes) {
      const result = await request(current, budget);
      if (result && fits(result)) return result;
      if (!reduced) return null; // Keep the existing bounded single-pass policy.
      throw new FieldCompressionError('Final field reduction returned an unusable summary');
    }
    const summaries: string[] = [];
    for (const chunk of splitField(current, payloadBytes)) {
      const chunkBytes = Buffer.byteLength(chunk, 'utf8');
      // Tiny trailing fragments need no model call. Carry them verbatim into
      // the next ordered reduction instead of forcing a lossy micro-summary.
      if (chunkBytes <= Math.min(budget, Math.floor(payloadBytes / 4))) {
        summaries.push(chunk);
        continue;
      }
      // UTF-8 uses at most three bytes per UTF-16 code unit. Asking for a sixth
      // of input bytes in characters leaves room for at least 2:1 reduction.
      const target = Math.max(1, Math.min(budget, Math.floor(chunkBytes / 6)));
      const summary = await request(chunk, target);
      if (!summary || summary.length > target ||
          Buffer.byteLength(summary, 'utf8') > Math.floor(chunkBytes / 2)) {
        throw new FieldCompressionError('Field fragment compression did not produce a bounded summary');
      }
      summaries.push(summary);
    }
    const next = summaries.join('\n\n');
    if (Buffer.byteLength(next, 'utf8') >= currentBytes) {
      throw new FieldCompressionError('Field reduction made no progress');
    }
    if (fits(next)) return next;
    current = next;
    reduced = true;
  }
}

/**
 * Condense one field if it is over budget.
 *
 * Normalize binary fields, then compress with bounded requests. Large ordinary
 * text is partitioned losslessly and reduced in stages, not rejected by size.
 * The owner must retain queued work on thrown errors. Null/unusable single-pass
 * replies retain bounded source for the existing observation truncation policy;
 * an incomplete multistage reduction is never returned as a complete summary.
 */
export async function optimizeField(
  value: unknown,
  compress: FieldCompressor,
  context: { sessionDbId: number; field: string; toolName?: string },
  maxChars: number = OBS_PROMPT_FIELD_MAX_CHARS,
  options: FieldOptimizeOptions = {},
): Promise<unknown> {
  if (options.signal?.aborted) throw abortReason(options.signal);
  if (!Number.isSafeInteger(maxChars) || maxChars < 1 ||
      (options.maxRequests !== undefined &&
        (!Number.isSafeInteger(options.maxRequests) || options.maxRequests < 1)) ||
      (options.maxInputBytes !== undefined &&
        (!Number.isSafeInteger(options.maxInputBytes) || options.maxInputBytes < 1)) ||
      (options.maxInputChars !== undefined &&
        (!Number.isSafeInteger(options.maxInputChars) || options.maxInputChars < 1)) ||
      (options.timeoutMs !== undefined &&
        (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 ||
          options.timeoutMs > 2_147_483_647))) {
    throw new RangeError('Field optimization budgets and timeout must be positive integers');
  }
  const { raw, normalized } = serializeField(value);
  const retained = normalized ? JSON.parse(raw) : value;
  if (raw.length <= maxChars) {
    return retained;
  }

  const wrap = (text: string) =>
    `<condensed source_size_chars="${raw.length}" reason="oversize">\n${text}\n</condensed>`;
  // The observation builder JSON-serializes this string again. Reserve framing
  // and verify the actual serialized answer, including JSON escape expansion.
  const overhead = JSON.stringify(wrap('')).length;
  if (overhead >= maxChars) {
    throw new FieldCompressionError('Observation field budget cannot fit summary framing');
  }
  const budget = Math.max(1, Math.min(Math.floor(maxChars * FIELD_OPTIMIZE_TARGET_RATIO),
    maxChars - overhead));
  const maxInput = options.maxInputBytes ?? options.maxInputChars ?? FIELD_OPTIMIZE_DEFAULT_MAX_INPUT_BYTES;
  const condensed = await condenseField(raw, compress, budget, maxInput, options,
    text => JSON.stringify(wrap(text)).length <= maxChars);
  if (options.signal?.aborted) throw abortReason(options.signal);

  const trimmed = condensed?.trim();
  if (!trimmed || JSON.stringify(wrap(trimmed)).length > maxChars) {
    logger.warn('SDK', 'Oversized field compression unusable; retaining bounded source', {
      sessionId: context.sessionDbId,
      field: context.field,
      toolName: context.toolName,
      sourceChars: raw.length,
      returnedChars: trimmed?.length ?? 0,
      reason: !trimmed ? 'empty' : 'still-over-budget',
    });
    return retained;
  }

  logger.info('SDK', 'Condensed an oversized observation field to fit', {
    sessionId: context.sessionDbId,
    field: context.field,
    toolName: context.toolName,
    sourceChars: raw.length,
    condensedChars: trimmed.length,
  });

  return wrap(trimmed);
}

/**
 * Normalize both payload fields, compressing only those still over budget.
 */
export async function optimizeObservationFields(
  fields: { toolInput: unknown; toolOutput: unknown },
  compress: FieldCompressor,
  context: { sessionDbId: number; toolName?: string },
  maxChars: number = OBS_PROMPT_FIELD_MAX_CHARS,
  options: FieldOptimizeOptions = {},
): Promise<{ toolInput: unknown; toolOutput: unknown }> {
  // Do not launch a sibling auxiliary request after a quota/auth failure.
  const toolInput = await optimizeField(fields.toolInput, compress,
    { ...context, field: 'parameters' }, maxChars, options);
  const toolOutput = await optimizeField(fields.toolOutput, compress,
    { ...context, field: 'outcome' }, maxChars, options);
  return { toolInput, toolOutput };
}
