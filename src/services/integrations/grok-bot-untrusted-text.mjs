/**
 * One sanitizer for every writer that puts recalled observation text into a
 * Grok Bot host file the host reads as instructions: the live Memory INDEX
 * (grok-bot-index-format.ts), the awareness pusher (GrokBotAwarenessPusher.ts)
 * and the optional repo daemon (scripts/grok-bot-session-inject.mjs).
 *
 * Observation titles, subtitles and facts are LLM-written from untrusted tool
 * output, so they are treated as data: invisible and direction-hijacking
 * characters are removed, tag and code framing is neutralized so a title
 * cannot open or close host tags such as `</instructions_update>`, and the
 * recalled part of a row is fenced in «…» with the fence kept intact on
 * truncation.
 *
 * Plain JavaScript so the daemon can import it under plain `node`; the types
 * live in the sibling grok-bot-untrusted-text.d.mts.
 */

/**
 * C0/C1 controls, bidi marks, overrides and isolates, zero-width characters,
 * word joiners, the Arabic letter mark and BOM. Tab, LF and CR are left for
 * whitespace collapse so words are not glued together.
 */
const UNSAFE_CHARS =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F؜​-‏‪-‮⁠-⁤⁦-⁯﻿]/g;

const TAG_FRAMING = { '<': '‹', '>': '›', '`': 'ˋ' };

export function stripUnsafeChars(value) {
  return String(value ?? '').replace(UNSAFE_CHARS, '');
}

/** Strip unsafe characters, neutralize `<`, `>` and backtick, fold all whitespace (incl. U+2028/9) to one space. */
export function sanitizeUntrustedText(value) {
  return stripUnsafeChars(value)
    .replace(/[<>`]/g, char => TAG_FRAMING[char])
    .replace(/\s+/g, ' ')
    .trim();
}

/** Truncate to at most `maxChars` code points (never splits a surrogate pair), ending in `…` when cut. */
export function truncateCodePoints(value, maxChars) {
  if (maxChars <= 0) return '';
  const chars = Array.from(String(value));
  if (chars.length <= maxChars) return String(value);
  return maxChars === 1 ? '…' : `${chars.slice(0, maxChars - 1).join('')}…`;
}

/**
 * `${lead}«${recalled}»` in at most `maxChars` code points. The recalled text is
 * sanitized, stripped of fence marks (so it cannot forge a close) and truncated
 * inside the fence, so the closing » always survives.
 */
export function fencedLine(lead, recalled, maxChars) {
  const inner = sanitizeUntrustedText(String(recalled ?? '').replace(/[«»]/g, ''));
  const budget = Math.max(maxChars - Array.from(String(lead)).length - 2, 1);
  return `${lead}«${truncateCodePoints(inner, budget)}»`;
}
