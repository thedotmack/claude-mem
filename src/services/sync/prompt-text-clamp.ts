/**
 * The bound on a prompt's text in the cloud-sync push lane.
 *
 * Real prompts carry pathological text (single 7.4 MB prompts from pasted
 * logs). Reading one in full materializes the whole string across the
 * bun:sqlite FFI boundary in `.all()`, a page of them at a time, and the worker
 * runs out of memory — truncating AFTER the read is too late. So the drain
 * SELECT reads prompt_text in full only when it fits, and otherwise only its
 * first PROMPT_TEXT_MAX_BYTES bytes.
 *
 * The cut is made on BYTES, in a BLOB: SQLite's TEXT functions stop at an
 * embedded NUL (`substr`, `length`), so a text clamp would cut a prompt short
 * at its first NUL without anyone noticing, and the row would be acked as
 * synced. Measured and cut as a BLOB, the whole value counts.
 *
 * What reaches the hub is bounded the same way, as JSON-escaped UTF-8 (the form
 * that counts against the canonical body's CONTENT_BODY_MAX_BYTES): a prompt
 * that fits goes up byte for byte; a longer one goes up as its longest prefix
 * that fits, plus a marker. The full prompt stays in the local database.
 */

/** Read and upload bound for one prompt, in bytes (see the module docblock). */
export const PROMPT_TEXT_MAX_BYTES = 200_000;

/** Appended to a prompt that was cut to fit. */
export const PROMPT_TRUNCATION_MARKER =
  `\n…[truncated by cloud sync at ${PROMPT_TEXT_MAX_BYTES} bytes; the full prompt stays on the device that captured it]`;

/**
 * The prompt_text columns for the drain and ack-reconciliation SELECTs, on a
 * `user_prompts` table aliased `up`. Exactly one of the two is non-null for a
 * stored prompt: `prompt_text` when it fits, `prompt_text_head` (its first
 * PROMPT_TEXT_MAX_BYTES bytes, as a BLOB) when it does not. Both SELECTs must
 * use this one fragment: ack reconciliation re-derives the body from the row
 * and compares hashes, so any difference would read as drift and re-queue the
 * prompt forever.
 */
export const PROMPT_TEXT_COLUMNS_SQL = `
        CASE WHEN length(CAST(up.prompt_text AS BLOB)) > ${PROMPT_TEXT_MAX_BYTES}
          THEN NULL ELSE up.prompt_text END AS prompt_text,
        CASE WHEN length(CAST(up.prompt_text AS BLOB)) > ${PROMPT_TEXT_MAX_BYTES}
          THEN substr(CAST(up.prompt_text AS BLOB), 1, ${PROMPT_TEXT_MAX_BYTES}) END AS prompt_text_head`;

/** UTF-8 bytes a string occupies inside a JSON document, quotes excluded. */
function jsonStringBytes(text: string): number {
  return Buffer.byteLength(JSON.stringify(text), 'utf8') - 2;
}

/**
 * Decode the first bytes of a UTF-8 value, dropping a character the byte cut
 * split in two. Any other invalid sequence decodes to U+FFFD as usual.
 */
function decodeUtf8Head(bytes: Uint8Array): string {
  let end = bytes.length;
  let lead = end - 1;
  while (lead >= 0 && end - lead < 4 && (bytes[lead] & 0xc0) === 0x80) lead--;
  if (lead >= 0) {
    const byte = bytes[lead];
    const width = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    if (end - lead < width) end = lead;
  }
  return new TextDecoder().decode(bytes.subarray(0, end));
}

/** The longest prefix of `text` whose JSON-escaped size fits `budget`, never splitting a surrogate pair. */
function fittingPrefix(text: string, budget: number): string {
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (jsonStringBytes(text.slice(0, mid)) <= budget) low = mid;
    else high = mid - 1;
  }
  const code = text.charCodeAt(low - 1);
  if (low > 0 && code >= 0xd800 && code <= 0xdbff) low--;
  return text.slice(0, low);
}

/**
 * The prompt text to upload for one drained row, given the two columns of
 * PROMPT_TEXT_COLUMNS_SQL. Null only when the stored prompt is null.
 */
export function clampPromptTextForSync(promptText: unknown, promptTextHead: unknown): string | null {
  if (promptTextHead instanceof Uint8Array) {
    const head = decodeUtf8Head(promptTextHead);
    return fittingPrefix(head, PROMPT_TEXT_MAX_BYTES - jsonStringBytes(PROMPT_TRUNCATION_MARKER)) + PROMPT_TRUNCATION_MARKER;
  }
  if (typeof promptText !== 'string') return null;
  if (jsonStringBytes(promptText) <= PROMPT_TEXT_MAX_BYTES) return promptText;
  // Fits as raw bytes but not once escaped (quotes, backslashes, control
  // characters): cut it to fit the same bound.
  return fittingPrefix(promptText, PROMPT_TEXT_MAX_BYTES - jsonStringBytes(PROMPT_TRUNCATION_MARKER)) + PROMPT_TRUNCATION_MARKER;
}
