// BMP-safe context sanitization (issue #2787).
//
// claude-mem injects a <claude-mem-context> block into auto-loaded CLAUDE.md /
// AGENTS.md / *.mdc files. Claude Code has a known bug class where it truncates
// the auto-loaded context at a UTF-16 code-unit boundary; if the cut lands
// inside an astral (non-BMP) character's surrogate pair, a LONE surrogate is
// emitted and the Anthropic API rejects the whole request with
// "400 ... no low surrogate in string". The session is bricked and SURVIVES
// /clear, because the bad bytes live in the always-reloaded context file.
//
// claude-mem is the source of the astral characters (emoji type markers from
// modes/*.json, plus any emoji in observation text). We can't fix Claude Code's
// truncation, but we can guarantee we never EMIT a surrogate pair into the
// injected block. Every code point we write is <= U+FFFF, so no cut can split a
// pair. Known type markers map to visually-distinct BMP glyphs; any other astral
// code point degrades to a neutral BMP bullet; stray lone surrogates are dropped.

const ASTRAL_FALLBACKS: Record<string, string> = {
  // Default "code" mode type markers (must match plugin/modes/code.json).
  '🔴': '●', // bugfix
  '🟣': '◆', // feature
  '🔄': '↻', // refactor
  '🔵': '○', // discovery
  '🚨': '⚠', // security_alert
  '🔐': '⚷', // security_note
  '🛠': '⚒', // tool/build
  '🔍': '⌕', // search/discovery
  '🎯': '◎', // session
  '💬': '”', // prompt
  '🧠': '◈', // decision (timeline legend)
};

const FALLBACK_BULLET = '•';

/**
 * Returns a copy of `input` containing only BMP (<= U+FFFF) code points, so the
 * string can never contribute a surrogate pair to auto-loaded context. Known
 * emoji markers are replaced with distinct BMP glyphs; other astral code points
 * become a neutral bullet; lone surrogates are stripped.
 */
export function toBmpSafe(input: string): string {
  if (!input) return input;
  let out = '';
  for (const ch of input) {
    const cp = ch.codePointAt(0)!;
    if (cp >= 0xd800 && cp <= 0xdfff) {
      // Lone surrogate (already-corrupted input) — drop it.
      continue;
    }
    if (cp <= 0xffff) {
      out += ch;
      continue;
    }
    out += ASTRAL_FALLBACKS[ch] ?? FALLBACK_BULLET;
  }
  return out;
}

/** True if `input` contains any astral (non-BMP) code point or lone surrogate. */
export function hasAstral(input: string): boolean {
  for (const ch of input) {
    const cp = ch.codePointAt(0)!;
    if (cp > 0xffff || (cp >= 0xd800 && cp <= 0xdfff)) return true;
  }
  return false;
}
