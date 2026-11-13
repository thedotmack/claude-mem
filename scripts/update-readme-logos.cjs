#!/usr/bin/env node

// Replace the README symbol while retaining the original wordmark pixels.
// Run with: node scripts/update-readme-logos.cjs
const path = require('node:path');
const sharp = require('sharp');

const publicDir = path.resolve(__dirname, '../docs/public');
const symbolPath = path.join(publicDir, 'claude-mem-logo-mark.svg');
const wordmarkLeft = 650;
const symbolWidth = 600;

async function updateLogo(theme) {
  const outputPath = path.join(publicDir, `claude-mem-logo-for-${theme}-mode.webp`);
  const original = await sharp(outputPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = original.info;
  if (width !== 3196 || height !== 581 || channels !== 4) {
    throw new Error(`Unexpected README logo dimensions for ${theme}: ${width} × ${height}`);
  }

  const symbol = await sharp(symbolPath)
    .resize({ width: symbolWidth })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const symbolTop = Math.floor((height - symbol.info.height) / 2);
  const pixels = Buffer.alloc(width * height * channels);

  // Copy RGBA bytes directly: alpha compositing can alter antialiased lettering.
  for (let y = 0; y < height; y++) {
    const start = (y * width + wordmarkLeft) * channels;
    original.data.copy(pixels, start, start, (y + 1) * width * channels);
  }
  for (let y = 0; y < symbol.info.height; y++) {
    const start = y * symbol.info.width * channels;
    symbol.data.copy(pixels, (y + symbolTop) * width * channels, start, start + symbol.info.width * channels);
  }

  await sharp(pixels, { raw: { width, height, channels } })
    .webp({ lossless: true, effort: 6, exact: true })
    .toFile(outputPath);
  console.log(`Updated ${path.relative(process.cwd(), outputPath)}`);
}

async function main() {
  for (const theme of ['light', 'dark']) await updateLogo(theme);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
