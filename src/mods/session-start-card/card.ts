/**
 * The session-start card: claude-mem's SessionStart banner (the recent
 * timeline) drawn as a framed row of the transcript by the hooks module,
 * instead of printed as the context hook's `systemMessage`. The hook message
 * shrinks to one line, which is what keeps the Claude app's view of the
 * session clean: Claude Code repeats a hook's name on every line there.
 *
 * This file is the part with no Claude Code API in it (register.ts has the
 * hooks): which sessions get a card, and the banner text as styled lines.
 */
import { SESSION_START_CARD_SOURCES, type SessionStartCardSlot } from '../../shared/session-start-card-slot.js';

/**
 * CLAUDE_CODE_ENTRYPOINT of a session at the terminal's own screen. Claude Code
 * sets it at launch, before any hook runs, and turns `cli` into `sdk-cli` for a
 * `-p` run, so it says "this session has the terminal screen" even when
 * SessionStart fires before that screen is up (`$.session.surfaces()` is empty
 * then). The terminal is the one screen the card has been seen to draw on; the
 * Desktop app and VS Code have other entrypoints and keep the full message.
 */
export const TERMINAL_ENTRYPOINT = 'cli';

/**
 * The first Claude Code with every call the card makes. Measured with
 * `claude plugin test`: `$.ui.place` (the row) came in 2.1.314, and
 * `$.process.hookEnv` (the plugin's data folder, where the banner is handed
 * over) in 2.1.326; 2.1.322, 2.1.323 and 2.1.325 do not have it.
 */
export const SESSION_START_CARD_MINIMUM_VERSION = [2, 1, 326] as const;

/** Whether a Claude Code version (`2.1.326`, `2.1.326-dev…`) has every call the card makes. */
export function supportsSessionStartCard(version: string | undefined): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version ?? '');
  if (!match) return false;
  for (let i = 0; i < SESSION_START_CARD_MINIMUM_VERSION.length; i += 1) {
    const part = Number(match[i + 1]);
    if (part !== SESSION_START_CARD_MINIMUM_VERSION[i]) return part > SESSION_START_CARD_MINIMUM_VERSION[i];
  }
  return true;
}

export function isSessionStartCardSource(source: unknown): boolean {
  return (SESSION_START_CARD_SOURCES as readonly unknown[]).includes(source);
}

/** A stretch of one line drawn in one style. */
export interface StyledRun {
  text: string;
  color?: string;
  isBold: boolean;
  isDim: boolean;
}

/**
 * The context renderer's colors (`colors` in src/services/context/types.ts), by
 * SGR code, as the color names a Text element takes. Beside them it uses only
 * 0 (reset), 1 (bold) and 2 (dim).
 */
const SGR_COLOR_NAMES: Record<string, string> = {
  '31': 'red',
  '32': 'green',
  '33': 'yellow',
  '34': 'blue',
  '35': 'magenta',
  '36': 'cyan',
  '90': 'gray',
};

const SGR_SEQUENCE = /\x1b\[([0-9;]*)m/g;

/**
 * Characters Claude Code refuses in drawn text (2.1.326: control characters
 * but tab and line breaks, a lone surrogate, U+10EEEE). One of them makes it
 * skip the whole row, so they are taken out.
 */
const REFUSED_IN_DRAWN_TEXT = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\uD800-\uDFFF\u{10EEEE}]/gu;
/** A braille blank is refused when a kitty diacritic follows it; a space draws the same. */
const BRAILLE_BLANK = /⠀/g;

function drawableText(text: string): string {
  return text.replace(REFUSED_IN_DRAWN_TEXT, '').replace(BRAILLE_BLANK, ' ');
}

/**
 * The banner as lines of styled runs: each SGR sequence changes the style of
 * the text after it, as in a terminal, and a style stays on across a line
 * break until it is reset. An empty line has no runs.
 */
export function parseAnsiLines(text: string): StyledRun[][] {
  let color: string | undefined;
  let isBold = false;
  let isDim = false;
  return text.split(/\r?\n/).map(line => {
    const runs: StyledRun[] = [];
    const addRun = (raw: string) => {
      const runText = drawableText(raw);
      if (runText) runs.push({ text: runText, color, isBold, isDim });
    };
    let from = 0;
    for (const sequence of line.matchAll(SGR_SEQUENCE)) {
      addRun(line.slice(from, sequence.index));
      for (const code of (sequence[1] || '0').split(';')) {
        if (code === '0' || code === '') {
          color = undefined;
          isBold = false;
          isDim = false;
        } else if (code === '1') {
          isBold = true;
        } else if (code === '2') {
          isDim = true;
        } else if (SGR_COLOR_NAMES[code]) {
          color = SGR_COLOR_NAMES[code];
        }
      }
      from = sequence.index + sequence[0].length;
    }
    addRun(line.slice(from));
    return runs;
  });
}

/** The lines a slot file's text draws, or null when the file is not a slot with something to show. */
export function sessionStartCardLines(slotFileText: string): StyledRun[][] | null {
  let slot: Partial<SessionStartCardSlot> | null;
  try {
    slot = JSON.parse(slotFileText);
  } catch {
    return null;
  }
  if (!slot || typeof slot.text !== 'string' || slot.text.trim() === '') return null;
  return parseAnsiLines(slot.text);
}
