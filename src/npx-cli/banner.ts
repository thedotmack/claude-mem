import { inflateRawSync } from 'zlib';
import { BANNER } from './banner-frames.js';

const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
const CLEAR_SCREEN = '\x1b[2J\x1b[3J\x1b[H';
const RESET = '\x1b[0m';

const FRAME_SEP = '\x01';

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
  // Banner is decorative — if frame payload decoding fails for any reason
  // (corrupted bundle, mismatched zlib, etc.) we must not break the CLI.
  // Fail open by returning an empty frame list; playBanner() bails on empty.
  try {
    const raw = inflateRawSync(Buffer.from(BANNER.compressed, 'base64')).toString('utf8');
    frames = raw.split(FRAME_SEP).filter(Boolean);
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    console.warn('claude-mem: banner frame decoding failed, skipping banner:', err);
    frames = [];
  }
  return frames;
}

/** One character of a parsed frame plus whether it sits inside an accent span. */
export interface FrameCell {
  ch: string;
  accent: boolean;
}

/**
 * Parse a raw span-marked frame (`<x>…</x>` accent markers, `\n` row
 * separators) into per-character cells carrying an accent flag. Span state
 * carries across newlines, matching the original single-pass styling.
 */
export function parseFrameCells(frame: string): FrameCell[][] {
  const rows: FrameCell[][] = [[]];
  let i = 0;
  let inSpan = false;
  while (i < frame.length) {
    const ch = frame[i];
    if (ch === '<') {
      const isClosing = frame[i + 1] === '/';
      while (i < frame.length && frame[i] !== '>') i++;
      i++;
      inSpan = !isClosing;
      continue;
    }
    if (ch === '\n') {
      rows.push([]);
      i++;
      continue;
    }
    rows[rows.length - 1].push({ ch, accent: inSpan });
    i++;
  }
  if (rows.length > 1 && rows[rows.length - 1].length === 0) rows.pop();
  return rows;
}

/**
 * Nearest-neighbor downsample of a cell grid to at most targetCols × targetRows.
 * Sampling is even: output index j maps to source index floor(j * src / target).
 * Never upsamples — targets larger than the source return the source cells.
 */
export function downsampleFrameCells(
  cells: FrameCell[][],
  targetCols: number,
  targetRows: number,
): FrameCell[][] {
  const srcRows = cells.length;
  const srcCols = cells.reduce((max, row) => Math.max(max, row.length), 0);
  const outRows = Math.min(Math.max(1, targetRows), srcRows);
  const outCols = Math.min(Math.max(1, targetCols), srcCols);
  if (outRows === srcRows && outCols === srcCols) return cells;
  const out: FrameCell[][] = [];
  for (let r = 0; r < outRows; r++) {
    const srcRow = cells[outRows === srcRows ? r : Math.floor((r * srcRows) / outRows)];
    const row: FrameCell[] = [];
    for (let c = 0; c < outCols; c++) {
      const sc = outCols === srcCols ? c : Math.floor((c * srcCols) / outCols);
      row.push(srcRow[sc] ?? { ch: ' ', accent: false });
    }
    out.push(row);
  }
  return out;
}

export interface FrameRenderOptions {
  /** false → monochrome: plain glyphs, zero SGR sequences (NO_COLOR). */
  color: boolean;
  truecolor: boolean;
  brightness?: number;
}

/**
 * Render parsed cells to a printable string. With color, accent-flagged cells
 * switch to the accent color and the output ends with a reset; without color
 * the output is the bare glyphs with no escape sequences at all.
 */
export function renderFrameCells(cells: FrameCell[][], opts: FrameRenderOptions): string {
  if (!opts.color) {
    return cells.map((row) => row.map((cell) => cell.ch).join('')).join('\n');
  }
  const brightness = opts.brightness ?? 1.0;
  const primary = primaryColor(opts.truecolor, brightness);
  const accent = accentColor(opts.truecolor, brightness);
  let out = primary;
  let inAccent = false;
  for (let r = 0; r < cells.length; r++) {
    if (r > 0) out += '\n';
    for (const cell of cells[r]) {
      if (cell.accent !== inAccent) {
        inAccent = cell.accent;
        out += inAccent ? accent : primary;
      }
      out += cell.ch;
    }
  }
  return out + RESET;
}

/** Pure core of adaptive banner scaling: parse → downsample → render. */
export function scaleFrame(
  frame: string,
  targetCols: number,
  targetRows: number,
  opts: FrameRenderOptions,
): string {
  return renderFrameCells(downsampleFrameCells(parseFrameCells(frame), targetCols, targetRows), opts);
}

function detectTruecolor(): boolean {
  return process.env.COLORTERM === 'truecolor' || process.env.COLORTERM === '24bit';
}

const WORDMARK_BUBBLE: readonly string[] = [
  "      _                 _                                     ",
  "  ___| | __ _ _   _  __| | ___       _ __ ___   ___ _ __ ___  ",
  " / __| |/ _` | | | |/ _` |/ _ \\_____| '_ ` _ \\ / _ \\ '_ ` _ \\ ",
  "| (__| | (_| | |_| | (_| |  __/_____| | | | | |  __/ | | | | |",
  " \\___|_|\\__,_|\\__,_|\\__,_|\\___|     |_| |_| |_|\\___|_| |_| |_|",
] as const;
const BUBBLE_HEIGHT = WORDMARK_BUBBLE.length;
const BUBBLE_WIDTH = WORDMARK_BUBBLE[0].length;

const TAGLINE_GAP = 1;
/** Terminal row count below which the art is downsampled vertically. */
const ROW_SCALE_THRESHOLD = BANNER.height + 4;
const MIN_ART_ROWS = 8;

/** Derive the render target from the current terminal size. */
function targetArtSize(): { cols: number; rows: number } {
  const cols = Math.min(process.stdout.columns ?? BANNER.width, BANNER.width);
  const termRows = process.stdout.rows ?? ROW_SCALE_THRESHOLD;
  let rows = BANNER.height;
  if (termRows < ROW_SCALE_THRESHOLD) {
    const reserved = BUBBLE_HEIGHT + TAGLINE_GAP + 2;
    rows = Math.min(BANNER.height, Math.max(MIN_ART_ROWS, termRows - reserved));
  }
  return { cols: Math.max(1, cols), rows };
}

function writeBubbleRow(rowIdx: number, colsRevealed: number, width: number, color: boolean): string {
  const src = WORDMARK_BUBBLE[rowIdx];
  // Center-crop the wordmark when the target width can't fit it.
  const bubbleWidth = Math.min(BUBBLE_WIDTH, width);
  const cropStart = Math.max(0, Math.floor((BUBBLE_WIDTH - bubbleWidth) / 2));
  const cropped = src.slice(cropStart, cropStart + bubbleWidth);
  const visible = cropped.slice(0, Math.min(bubbleWidth, colsRevealed)).padEnd(bubbleWidth, ' ');
  const pad = Math.max(0, Math.floor((width - bubbleWidth) / 2));
  const rightPad = ' '.repeat(Math.max(0, width - pad - bubbleWidth));
  const styled = color ? `\x1b[1;97m${visible}\x1b[0m` : visible;
  return ' '.repeat(pad) + styled + rightPad;
}

function writeTaglineRow(text: string, width: number, color: boolean): string {
  const shown = text.length > width ? text.slice(0, width) : text;
  const pad = Math.max(0, Math.floor((width - shown.length) / 2));
  const rightPad = ' '.repeat(Math.max(0, width - pad - shown.length));
  const styled = color ? `\x1b[2;37m${shown}\x1b[0m` : shown;
  return ' '.repeat(pad) + styled + rightPad;
}

export function isBannerEnabled(): boolean {
  if (!process.stdout.isTTY) return false;
  if (process.env.CI) return false;
  if (process.env.CLAUDE_MEM_NO_BANNER) return false;
  return true;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function playBanner(): Promise<void> {
  if (!isBannerEnabled()) return;
  const truecolor = detectTruecolor();
  const color = !process.env.NO_COLOR;
  const allFrames = getFrames();
  if (allFrames.length === 0) return;
  const { cols, rows } = targetArtSize();
  const frameCells = allFrames.map((f) => downsampleFrameCells(parseFrameCells(f), cols, rows));
  const rendered = frameCells.map((c) => renderFrameCells(c, { color, truecolor }));
  const finalCells = frameCells[frameCells.length - 1];
  const artRows = finalCells.length;
  const totalRows = artRows + BUBBLE_HEIGHT + TAGLINE_GAP + 1;
  const bubbleWidth = Math.min(BUBBLE_WIDTH, cols);

  let aborted = false;
  const onResize = () => { aborted = true; };
  process.stdout.on('resize', onResize);
  process.stdout.write(CLEAR_SCREEN);
  process.stdout.write(HIDE_CURSOR);

  process.stdout.write('\n'.repeat(totalRows));
  process.stdout.write(`\x1b[${totalRows}A`);
  process.stdout.write('\x1b[s');

  const blankRow = ' '.repeat(cols);

  const writeFrame = (art: string, colsRevealed: number, tagline: string) => {
    process.stdout.write('\x1b[u');
    process.stdout.write(art);
    process.stdout.write('\n');
    for (let i = 0; i < BUBBLE_HEIGHT; i++) {
      process.stdout.write(writeBubbleRow(i, colsRevealed, cols, color));
      process.stdout.write('\n');
    }
    for (let g = 0; g < TAGLINE_GAP; g++) {
      process.stdout.write(blankRow);
      process.stdout.write('\n');
    }
    process.stdout.write(writeTaglineRow(tagline, cols, color));
  };

  try {
    for (let i = 0; i < rendered.length; i++) {
      if (aborted) return;
      writeFrame(rendered[i], 0, '');
      await sleep(BANNER.frameDelay);
    }

    const finalArt = rendered[rendered.length - 1];
    const TAGLINE = 'persistent memory across sessions';

    const REVEAL_STEPS = 14;
    for (let s = 1; s <= REVEAL_STEPS; s++) {
      if (aborted) return;
      const revealCols = Math.ceil(bubbleWidth * (s / REVEAL_STEPS));
      writeFrame(finalArt, revealCols, '');
      await sleep(45);
    }

    for (let s = 1; s <= 6; s++) {
      if (aborted) return;
      const chars = Math.ceil(TAGLINE.length * (s / 6));
      writeFrame(finalArt, bubbleWidth, TAGLINE.slice(0, chars));
      await sleep(33);
    }

    for (const brightness of [0.85, 0.95, 1.0]) {
      if (aborted) return;
      writeFrame(renderFrameCells(finalCells, { color, truecolor, brightness }), bubbleWidth, TAGLINE);
      await sleep(100);
    }

    await sleep(150);
  } finally {
    process.stdout.off('resize', onResize);
    if (color) process.stdout.write(RESET);
    process.stdout.write(SHOW_CURSOR);
    process.stdout.write('\n');
  }
}
