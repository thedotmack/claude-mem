import { BANNER_TIERS, type TierFrames } from './banner-frames.js';

type Tier = 'small' | 'medium' | 'hero';
type Cell = string;

const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';

let canvas: Cell[][] = [];

function detectTier(): Tier | null {
  const cols = process.stdout.columns ?? 0;
  if (cols >= 160) return 'hero';
  if (cols >= 120) return 'medium';
  if (cols >= 80) return 'small';
  return null;
}

function detectTruecolor(): boolean {
  return process.env.COLORTERM === 'truecolor' || process.env.COLORTERM === '24bit';
}

function cellColor(
  col: number,
  row: number,
  tierCols: number,
  tierRows: number,
  truecolor: boolean,
  brightness: number = 1.0,
): string {
  const cx = tierCols / 2;
  const cy = tierRows / 2;
  const dx = col - cx;
  const dy = row - cy;
  const dist = Math.sqrt(dx * dx + dy * dy) / Math.sqrt(cx * cx + cy * cy);
  // lerp #FFB47A → #C04A30
  let r = Math.round(255 * (1 - dist) + 192 * dist);
  let g = Math.round(180 * (1 - dist) + 74 * dist);
  let b = Math.round(122 * (1 - dist) + 48 * dist);
  r = Math.min(255, Math.round(r * brightness));
  g = Math.min(255, Math.round(g * brightness));
  b = Math.min(255, Math.round(b * brightness));
  if (truecolor) return `\x1b[38;2;${r};${g};${b}m`;
  return '\x1b[38;5;208m';
}

function renderFrame(
  frameStr: string,
  tier: TierFrames,
  truecolor: boolean,
  brightness: number = 1.0,
): Cell[][] {
  const { cols, rows } = tier;
  const newCanvas: Cell[][] = [];
  const CHARS = [' ', '▄', '▀', '█'];
  for (let row = 0; row < rows; row++) {
    newCanvas[row] = [];
    for (let col = 0; col < cols; col++) {
      const idx = row * cols + col;
      const val = parseInt(frameStr[idx] ?? '0', 10);
      if (val === 0) {
        newCanvas[row][col] = ' ';
        continue;
      }
      let isTip = false;
      outer: for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          const nr = row + dr;
          const nc = col + dc;
          if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) {
            isTip = true;
            break outer;
          }
          if (parseInt(frameStr[nr * cols + nc] ?? '0', 10) === 0) {
            isTip = true;
            break outer;
          }
        }
      }
      const b = isTip ? Math.min(1.5, brightness * 1.2) : brightness;
      const color = cellColor(col, row, cols, rows, truecolor, b);
      newCanvas[row][col] = color + CHARS[val] + '\x1b[0m';
    }
  }
  return newCanvas;
}

function diffWrite(newCanvas: Cell[][], first: boolean): void {
  if (first) {
    process.stdout.write('\x1b[s');
    for (const row of newCanvas) {
      process.stdout.write(row.join('') + '\n');
    }
    canvas = newCanvas.map((r) => [...r]);
    return;
  }
  for (let row = 0; row < newCanvas.length; row++) {
    const rowDirty = newCanvas[row].some((cell, col) => cell !== canvas[row]?.[col]);
    if (!rowDirty) continue;
    process.stdout.write('\x1b[u');
    if (row > 0) process.stdout.write(`\x1b[${row}B`);
    process.stdout.write('\x1b[1G');
    process.stdout.write(newCanvas[row].join(''));
  }
  canvas = newCanvas.map((r) => [...r]);
}

function buildDiscFrame(tier: TierFrames, fraction: number): string {
  const { cols, rows, finalFrame } = tier;
  const cx = cols / 2;
  const cy = rows / 2;
  const maxDiscRadius = Math.min(cols, rows) * 0.15;
  const radius = maxDiscRadius * fraction;
  let result = '';
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const dx = col - cx;
      const dy = row - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      result += dist <= radius ? finalFrame[row * cols + col] : '0';
    }
  }
  return result;
}

function addWordmark(c: Cell[][], tier: TierFrames, wordmark: string, tagline: string): void {
  const { cols, rows } = tier;
  const midY = Math.floor(rows / 2);
  if (wordmark) {
    c[midY - 1] = c[midY - 1] ?? [];
    while (c[midY - 1].length < cols + 2) c[midY - 1].push(' ');
    c[midY - 1].push(`\x1b[1;37m${wordmark}\x1b[0m`);
  }
  if (tagline) {
    c[midY] = c[midY] ?? [];
    while (c[midY].length < cols + 2) c[midY].push(' ');
    c[midY].push(`\x1b[2;37m${tagline}\x1b[0m`);
  }
}

export function isBannerEnabled(): boolean {
  if (!process.stdout.isTTY) return false;
  if (process.env.CI) return false;
  if (process.env.CLAUDE_MEM_NO_BANNER) return false;
  if (process.env.NO_COLOR) return false;
  return detectTier() !== null;
}

export async function playBanner(): Promise<void> {
  if (!isBannerEnabled()) return;
  const tierName = detectTier()!;
  const tier = BANNER_TIERS[tierName];
  const truecolor = detectTruecolor();
  let aborted = false;
  const onResize = () => {
    aborted = true;
  };
  process.stdout.on('resize', onResize);
  process.stdout.write(HIDE_CURSOR);
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  canvas = [];
  let first = true;

  try {
    // ACT 1: Ignition (0–480ms) — center disc grows, 8 steps × 60ms
    for (let step = 1; step <= 8; step++) {
      if (aborted) return;
      const discFrame = buildDiscFrame(tier, step / 8);
      const nc = renderFrame(discFrame, tier, truecolor);
      diffWrite(nc, first);
      first = false;
      await sleep(60);
    }

    // ACT 2: Bloom (480–1200ms) — 12 rays × 60ms = 720ms
    for (let i = 0; i < 12; i++) {
      if (aborted) return;
      const nc = renderFrame(tier.bloomFrames[i], tier, truecolor);
      diffWrite(nc, false);
      await sleep(60);
    }

    // ACT 3a: Type-on wordmark (350ms, 10 chars × 35ms)
    const WORDMARK = 'claude-mem';
    for (let c = 1; c <= WORDMARK.length; c++) {
      if (aborted) return;
      const nc = renderFrame(tier.finalFrame, tier, truecolor);
      addWordmark(nc, tier, WORDMARK.slice(0, c), '');
      diffWrite(nc, false);
      await sleep(35);
    }

    // ACT 3b: Tagline fade-in (200ms, 6 steps)
    const TAGLINE = 'persistent memory across sessions';
    for (let s = 1; s <= 6; s++) {
      if (aborted) return;
      const chars = Math.ceil(TAGLINE.length * (s / 6));
      const nc = renderFrame(tier.finalFrame, tier, truecolor);
      addWordmark(nc, tier, WORDMARK, TAGLINE.slice(0, chars));
      diffWrite(nc, false);
      await sleep(33);
    }

    // ACT 3c: Breathe (300ms)
    for (const brightness of [0.9, 0.95, 1.0]) {
      if (aborted) return;
      const nc = renderFrame(tier.finalFrame, tier, truecolor, brightness);
      addWordmark(nc, tier, WORDMARK, TAGLINE);
      diffWrite(nc, false);
      await sleep(100);
    }

    // Hold 200ms
    await sleep(200);
  } finally {
    process.stdout.off('resize', onResize);
    process.stdout.write(SHOW_CURSOR);
  }
}
