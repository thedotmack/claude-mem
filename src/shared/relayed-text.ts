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
  try {
    const parsed = new URL((url ?? '').trim());
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
  } catch {
    // Not a URL at all.
  }
  return null;
}
