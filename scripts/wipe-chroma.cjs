#!/usr/bin/env node
/**
 * Wipes the Chroma data directory so backfillAllProjects rebuilds it on next worker start.
 * Chroma is always rebuildable from SQLite — this is safe.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const chromaDir = path.join(os.homedir(), '.claude-mem', 'chroma');

if (fs.existsSync(chromaDir)) {
  const before = fs.readdirSync(chromaDir);
  console.log(`Wiping ${chromaDir} (${before.length} items)...`);
  fs.rmSync(chromaDir, { recursive: true, force: true });
  console.log('Done. Chroma will rebuild from SQLite on next worker restart.');
} else {
  console.log('Chroma directory does not exist, nothing to wipe.');
}
