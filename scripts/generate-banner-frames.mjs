#!/usr/bin/env node
import { Jimp } from 'jimp';
import { writeFileSync, readdirSync, existsSync } from 'fs';
import { deflateRawSync } from 'zlib';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

const FRAMES_DIR = process.env.FRAMES_DIR || '/tmp/cmem-banner-frames';
const OUT = join(repoRoot, 'src/npx-cli/banner-frames.ts');

const COLS = 128;
const VIDEO_ROWS = Math.round(COLS * (9 / 16) / 2); 
const ROWS = VIDEO_ROWS;
const TOP_PAD = 0;
const BOTTOM_PAD = 0;

const RAMP = ' .·~+=*x%$@#';
const BLACK_FLOOR = 50;
const WHITE_CEIL = 160;
const HALO_MIN = 70;
const HALO_MAX = 175;

function rasterize(img, gridW, gridH) {
  const resized = img.clone().resize({ w: gridW, h: gridH });
  const data = resized.bitmap.data;
  const density = new Float32Array(gridW * gridH);
  for (let cy = 0; cy < gridH; cy++) {
    for (let cx = 0; cx < gridW; cx++) {
      const idx = (cy * gridW + cx) * 4;
      const r = data[idx], g = data[idx + 1], b = data[idx + 2];
      density[cy * gridW + cx] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    }
  }
  return density;
}

function densityToChar(d) {
  if (d <= BLACK_FLOOR) return ' ';
  const range = WHITE_CEIL - BLACK_FLOOR;
  const norm = Math.min(1, (d - BLACK_FLOOR) / range);
  const t = Math.pow(norm, 1.3);
  const idx = Math.min(RAMP.length - 1, Math.max(1, Math.round(t * (RAMP.length - 1))));
  return RAMP[idx];
}

function renderASCII(density, w, h) {
  const lines = [];
  for (let y = 0; y < h; y++) {
    let line = '';
    let inSpan = false;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const d = density[i];
      const ch = densityToChar(d);
      const wantSpan = d > HALO_MIN && d < HALO_MAX && ch !== ' ';
      if (wantSpan && !inSpan) { line += '<span>'; inSpan = true; }
      if (!wantSpan && inSpan) { line += '</span>'; inSpan = false; }
      line += ch;
    }
    if (inSpan) line += '</span>';
    lines.push(line);
  }
  return lines.join('\n');
}

async function main() {
  if (!existsSync(FRAMES_DIR)) {
    throw new Error(`Frames directory not found: ${FRAMES_DIR}\n` +
      `Run: ffmpeg -y -i <video> -vf "scale=320:180" ${FRAMES_DIR}/frame_%04d.png`);
  }
  const files = readdirSync(FRAMES_DIR)
    .filter((f) => f.endsWith('.png'))
    .sort();
  if (files.length === 0) {
    throw new Error(`No PNG frames found in ${FRAMES_DIR}`);
  }

  const blankLine = ' '.repeat(COLS);
  const topPadding = Array(TOP_PAD).fill(blankLine).join('\n');
  const bottomPadding = Array(BOTTOM_PAD).fill(blankLine).join('\n');

  const frameStrings = [];
  for (let i = 0; i < files.length; i++) {
    const img = await Jimp.read(join(FRAMES_DIR, files[i]));
    const density = rasterize(img, COLS, VIDEO_ROWS);
    const body = renderASCII(density, COLS, VIDEO_ROWS);
    const padded = [topPadding, body, bottomPadding].filter(Boolean).join('\n');
    frameStrings.push(padded);
    if ((i + 1) % 32 === 0 || i === files.length - 1) {
      process.stdout.write(`  rasterized ${i + 1}/${files.length}\r`);
    }
  }
  process.stdout.write('\n');

  const joined = frameStrings.join('\x01');
  const compressed = deflateRawSync(Buffer.from(joined, 'utf8'), { level: 9 });
  const b64 = compressed.toString('base64');

  const FRAME_DELAY = 22; 

  const ts = `// @strip-comments-keep — auto-generated, do not edit by hand.
// Source: scripts/generate-banner-frames.mjs (webm video → ASCII via luminance ramp).
// Frames are gzip-deflated, base64-encoded, separated by \\x01.

export interface BannerData {
  /** Base64-encoded raw deflate of all frames joined by \\x01 */
  compressed: string;
  frameCount: number;
  width: number;
  height: number;
  /** Milliseconds per frame */
  frameDelay: number;
}

export const BANNER: BannerData = {
  compressed: ${JSON.stringify(b64)},
  frameCount: ${files.length},
  width: ${COLS},
  height: ${ROWS},
  frameDelay: ${FRAME_DELAY},
};
`;

  writeFileSync(OUT, ts);
  console.log(`✓ Generated ${files.length} ASCII frames at ${COLS}×${ROWS}`);
  console.log(`  Raw size: ${joined.length} bytes`);
  console.log(`  Compressed: ${compressed.length} bytes (${((compressed.length / joined.length) * 100).toFixed(1)}%)`);
  console.log(`  Base64: ${b64.length} bytes`);
  console.log(`  Written to: ${OUT}`);

  if (process.env.PREVIEW) {
    console.log('\n--- final frame preview ---');
    console.log(frameStrings[frameStrings.length - 1].replace(/<\/?span>/g, ''));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
