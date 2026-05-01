import { inflateRawSync } from 'zlib';
import { BANNER } from './banner-frames.js';

const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
const CURSOR_HOME = '\x1b[H';
const CLEAR_DOWN = '\x1b[J';
const CLEAR_SCREEN = '\x1b[2J\x1b[3J\x1b[H';
const RESET = '\x1b[0m';

const FRAME_SEP = '\x01';

// Brand colors. Primary = the orange logo body. Accent = outline highlight
// applied to <span>-tagged cells (the high-gradient edges).
function primaryColor(truecolor: boolean, brightness: number = 1.0): string {
  if (!truecolor) return '\x1b[38;5;208m';
  const r = Math.min(255, Math.round(230 * brightness));
  const g = Math.min(255, Math.round(115 * brightness));
  const b = Math.min(255, Math.round(70 * brightness));
  return `\x1b[38;2;${r};${g};${b}m`;
}

function accentColor(truecolor: boolean, brightness: number = 1.0): string {
  if (!truecolor) return '\x1b[38;5;215m';
  const r = Math.min(255, Math.round(255 * brightness));
  const g = Math.min(255, Math.round(180 * brightness));
  const b = Math.min(255, Math.round(122 * brightness));
  return `\x1b[38;2;${r};${g};${b}m`;
}

let frames: string[] | null = null;
function getFrames(): string[] {
  if (frames) return frames;
  const raw = inflateRawSync(Buffer.from(BANNER.compressed, 'base64')).toString('utf8');
  frames = raw.split(FRAME_SEP);
  return frames;
}

// Render one frame: walks the text, switching ANSI styles on <span>...</span>
// tags. Mirrors the state machine in ghostty's src/cli/boo.zig updateFrame().
function styleFrame(
  frame: string,
  truecolor: boolean,
  brightness: number = 1.0,
): string {
  const primary = primaryColor(truecolor, brightness);
  const accent = accentColor(truecolor, brightness);
  let out = primary;
  let i = 0;
  let inSpan = false;
  while (i < frame.length) {
    const ch = frame[i];
    if (ch === '<') {
      // Skip until '>'. Track whether we're entering or leaving a span.
      const isClosing = frame[i + 1] === '/';
      while (i < frame.length && frame[i] !== '>') i++;
      i++; // skip '>'
      inSpan = !isClosing;
      out += inSpan ? accent : primary;
      continue;
    }
    out += ch;
    i++;
  }
  return out + RESET;
}

function detectTruecolor(): boolean {
  return process.env.COLORTERM === 'truecolor' || process.env.COLORTERM === '24bit';
}

// figlet -f standard "claude-mem" — geometric ASCII letters, 5 rows × 62 cols.
const WORDMARK_BUBBLE: readonly string[] = [
  "      _                 _                                     ",
  "  ___| | __ _ _   _  __| | ___       _ __ ___   ___ _ __ ___  ",
  " / __| |/ _` | | | |/ _` |/ _ \\_____| '_ ` _ \\ / _ \\ '_ ` _ \\ ",
  "| (__| | (_| | |_| | (_| |  __/_____| | | | | |  __/ | | | | |",
  " \\___|_|\\__,_|\\__,_|\\__,_|\\___|     |_| |_| |_|\\___|_| |_| |_|",
] as const;
const BUBBLE_HEIGHT = WORDMARK_BUBBLE.length;
const BUBBLE_WIDTH = WORDMARK_BUBBLE[0].length;

// Reserve canvas: animation + wordmark (5 rows) + 1 blank gap + 1 tagline row.
const TAGLINE_GAP = 1;
const TOTAL_ROWS = BANNER.height + BUBBLE_HEIGHT + TAGLINE_GAP + 1;

function writeBubbleRow(rowIdx: number, colsRevealed: number): string {
  // Reveal left-to-right by column. Hidden cols become spaces so the row width
  // is always BUBBLE_WIDTH and centering stays stable.
  const src = WORDMARK_BUBBLE[rowIdx];
  const W = BANNER.width;
  const visible = src.slice(0, Math.min(BUBBLE_WIDTH, colsRevealed)).padEnd(BUBBLE_WIDTH, ' ');
  const pad = Math.max(0, Math.floor((W - BUBBLE_WIDTH) / 2));
  return ' '.repeat(pad) + `\x1b[1;97m${visible}\x1b[0m` + ' '.repeat(Math.max(0, W - pad - BUBBLE_WIDTH));
}

function writeTaglineRow(text: string): string {
  const W = BANNER.width;
  const pad = Math.max(0, Math.floor((W - text.length) / 2));
  return ' '.repeat(pad) + `\x1b[2;37m${text}\x1b[0m` + ' '.repeat(Math.max(0, W - pad - text.length));
}

export function isBannerEnabled(): boolean {
  if (process.env.CLAUDE_MEM_NO_BANNER) return false;
  return true;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function playBanner(): Promise<void> {
  if (!isBannerEnabled()) return;
  const truecolor = detectTruecolor();
  const allFrames = getFrames();
  let aborted = false;
  const onResize = () => { aborted = true; };
  process.stdout.on('resize', onResize);
  process.stdout.write(CLEAR_SCREEN);
  process.stdout.write(HIDE_CURSOR);

  // Reserve vertical space (logo + 2 wordmark rows) so we have a stable
  // canvas to redraw on. Save cursor at the top of the canvas.
  process.stdout.write('\n'.repeat(TOTAL_ROWS));
  process.stdout.write(`\x1b[${TOTAL_ROWS}A`);
  process.stdout.write('\x1b[s');

  const blankRow = ' '.repeat(BANNER.width);

  const writeFrame = (frameText: string, colsRevealed: number, tagline: string, brightness: number = 1.0) => {
    process.stdout.write('\x1b[u');
    process.stdout.write(styleFrame(frameText, truecolor, brightness));
    // Frames don't end with \n on the last line, so add one before drawing wordmark rows
    process.stdout.write('\n');
    for (let i = 0; i < BUBBLE_HEIGHT; i++) {
      process.stdout.write(writeBubbleRow(i, colsRevealed));
      process.stdout.write('\n');
    }
    for (let g = 0; g < TAGLINE_GAP; g++) {
      process.stdout.write(blankRow);
      process.stdout.write('\n');
    }
    process.stdout.write(writeTaglineRow(tagline));
  };

  try {
    // ACT 1+2: play the prerendered animation
    for (let i = 0; i < allFrames.length; i++) {
      if (aborted) return;
      writeFrame(allFrames[i], 0, '');
      await sleep(BANNER.frameDelay);
    }

    // ACT 3: reveal bubble wordmark letter-by-letter, then tagline
    const finalFrame = allFrames[allFrames.length - 1];
    const TAGLINE = 'persistent memory across sessions';

    // Sweep reveal across all columns
    const REVEAL_STEPS = 14;
    for (let s = 1; s <= REVEAL_STEPS; s++) {
      if (aborted) return;
      const cols = Math.ceil(BUBBLE_WIDTH * (s / REVEAL_STEPS));
      writeFrame(finalFrame, cols, '');
      await sleep(45);
    }

    for (let s = 1; s <= 6; s++) {
      if (aborted) return;
      const chars = Math.ceil(TAGLINE.length * (s / 6));
      writeFrame(finalFrame, BUBBLE_WIDTH, TAGLINE.slice(0, chars));
      await sleep(33);
    }

    // Brief breathe pulse on the final pose
    for (const brightness of [0.85, 0.95, 1.0]) {
      if (aborted) return;
      writeFrame(finalFrame, BUBBLE_WIDTH, TAGLINE, brightness);
      await sleep(100);
    }

    await sleep(150);
  } finally {
    process.stdout.off('resize', onResize);
    process.stdout.write(RESET);
    process.stdout.write(SHOW_CURSOR);
    // Move cursor below the banner so subsequent output starts on a fresh line.
    process.stdout.write('\n');
  }
}
