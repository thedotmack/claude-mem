// SPDX-License-Identifier: Apache-2.0

/**
 * Provider and gateway words that claude-mem relays into model context: the
 * SessionStart fallback notice (cmem-gateway.ts) and the observer-health
 * banner (observer-health.ts). They come from an upstream error body, stored
 * in settings.json or observer-health.json, so they are untrusted. Each piece
 * is reduced to one plain, bounded line, and a link is relayed only when it
 * points at an approved destination.
 */

/** Longest relayed message, action, request id, or link, in code points. */
export const RELAYED_TEXT_MAX_CHARS = 300;

/**
 * One plain line: whitespace (newlines and line separators included) is
 * collapsed, control and format characters (bidi overrides, zero-width
 * characters) are dropped, angle brackets are escaped so no `<tag>` survives,
 * and the result is capped at RELAYED_TEXT_MAX_CHARS code points without ever
 * splitting one.
 */
export function relayedLine(text: string | null | undefined): string {
  const line = (text ?? '')
    .replace(/\s+/g, ' ')
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/ {2,}/g, ' ')
    .trim();
  const codePoints = Array.from(line);
  return codePoints.length > RELAYED_TEXT_MAX_CHARS
    ? `${codePoints.slice(0, RELAYED_TEXT_MAX_CHARS - 1).join('').trimEnd()}…`
    : line;
}

/**
 * Markdown that could pass for claude-mem's own structure: a heading like the
 * `# [project] recent context` one, a code fence, or a rule. A relayed line
 * that starts with one gets a backslash, which keeps its words and drops its
 * structure.
 */
const STRUCTURAL_MARKDOWN_LINE = /^\s*(#|```|---)/;

/**
 * Several plain lines, for a relayed block such as the TeamBrain brief, which
 * is written from other people's observations. Line breaks survive (CRLF and
 * Unicode line separators become `\n`, runs of blank lines collapse to one);
 * everything else follows relayedLine: control and format characters are
 * dropped, angle brackets are escaped, a line that would open a heading,
 * fence or rule is escaped (STRUCTURAL_MARKDOWN_LINE), and the result is
 * capped at `maxUtf16Units` (clipUtf16).
 */
export function relayedBlock(text: string | null | undefined, maxUtf16Units: number): string {
  const block = (text ?? '')
    .replace(/\r\n?|[\u2028\u2029]/g, '\n')
    .split('\n')
    .map(line => line
      .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\s+$/u, ''))
    .map(line => (STRUCTURAL_MARKDOWN_LINE.test(line) ? `\\${line}` : line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return clipUtf16(block, maxUtf16Units);
}

/**
 * Caps `text` at `maxUtf16Units` String.length units, the unit context budgets
 * and host delivery caps count, ending a cut text with `…`. A cut never splits
 * a surrogate pair.
 */
export function clipUtf16(text: string, maxUtf16Units: number): string {
  if (text.length <= maxUtf16Units) return text;
  let kept = text.slice(0, Math.max(0, maxUtf16Units - 1));
  if (/[\uD800-\uDBFF]$/.test(kept)) kept = kept.slice(0, -1);
  return `${kept.trimEnd()}…`;
}

/**
 * Where a relayed link may point: the cmem.ai site, OpenRouter (whose remedy
 * pages and model list claude-mem links to), and the claude-mem issue tracker
 * (plan 2026-08-16 §1.1).
 */
function isApprovedDestination(url: URL): boolean {
  if (url.hostname === 'cmem.ai' || url.hostname === 'openrouter.ai') return true;
  return url.hostname === 'github.com' && /^\/thedotmack\/claude-mem\/issues(\/|$)/.test(url.pathname);
}

/**
 * The link as it may be relayed, or null. Only https on the default port, with
 * no credentials, to an approved destination, and short enough to relay whole:
 * a cut link is a broken one.
 */
export function relayedLink(url: string | null | undefined): string | null {
  const candidate = (url ?? '').trim();
  if (!URL.canParse(candidate)) return null;
  const parsed = new URL(candidate);
  if (
    parsed.protocol === 'https:'
    && !parsed.port
    && !parsed.username
    && !parsed.password
    && isApprovedDestination(parsed)
    && parsed.href.length <= RELAYED_TEXT_MAX_CHARS
  ) {
    return parsed.href;
  }
  return null;
}
