#!/usr/bin/env node
// cmem-sdk import guard. Plan: plans/2026-05-25-cmem-sdk-and-server-rename.md §2,9.
//
// Reads the bundled SDK and fails the build if it imports any of the
// shell-only dependencies the SDK must never depend on (Express, BullMQ,
// ioredis, better-auth, React, `bun:sqlite`, the Claude Code agent SDK).
//
// This is a string match against the emitted JS — tsup leaves external
// imports as bare `from 'pkg'` / `require('pkg')` strings, so a flat
// regex search is sufficient and avoids running the bundle.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const BUNDLE_PATH = path.resolve(__dirname, '..', 'dist', 'sdk', 'index.js');

// Each token is rejected if it appears as an imported/required module
// specifier in the bundle. The check looks for both the static-import
// and CJS-require forms, plus the bare token as a final-net catchall.
const FORBIDDEN_TOKENS = [
  'express',
  'bullmq',
  'ioredis',
  'better-auth',
  'react',
  'bun:sqlite',
  '@anthropic-ai/claude-agent-sdk',
];

const CONTEXT_CHARS = 60;

function escapeForRegex(token) {
  return token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findMatches(bundle, token) {
  const t = escapeForRegex(token);
  // Match: from 'TOKEN', from "TOKEN", require('TOKEN', require("TOKEN"
  // The bare-token regex is intentional belt-and-suspenders for cases
  // like dynamic `import('TOKEN')` or string concatenation that the
  // specific forms above wouldn't catch.
  const patterns = [
    new RegExp(`from\\s+['"]${t}['"]`, 'g'),
    new RegExp(`require\\(\\s*['"]${t}['"]`, 'g'),
    new RegExp(`import\\(\\s*['"]${t}['"]`, 'g'),
    new RegExp(`['"]${t}['"]`, 'g'),
  ];
  const hits = [];
  for (const pattern of patterns) {
    let m;
    while ((m = pattern.exec(bundle)) !== null) {
      const start = Math.max(0, m.index - CONTEXT_CHARS);
      const end = Math.min(bundle.length, m.index + m[0].length + CONTEXT_CHARS);
      hits.push({
        token,
        offset: m.index,
        snippet: bundle.slice(start, end).replace(/\s+/g, ' ').trim(),
      });
    }
  }
  return hits;
}

function dedupeHits(hits) {
  // Multiple regexes may match the same offset; collapse them.
  const seen = new Set();
  const result = [];
  for (const hit of hits) {
    const key = `${hit.token}:${hit.offset}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(hit);
  }
  return result.sort((a, b) => a.offset - b.offset);
}

function main() {
  if (!fs.existsSync(BUNDLE_PATH)) {
    console.error(`check-sdk-bundle: bundle not found at ${BUNDLE_PATH}`);
    console.error('Did you run `npm run build:sdk` first?');
    process.exit(1);
  }

  const bundle = fs.readFileSync(BUNDLE_PATH, 'utf8');
  const allHits = [];
  for (const token of FORBIDDEN_TOKENS) {
    const hits = findMatches(bundle, token);
    allHits.push(...hits);
  }

  const unique = dedupeHits(allHits);

  if (unique.length === 0) {
    console.log(`check-sdk-bundle: ${path.relative(process.cwd(), BUNDLE_PATH)} is clean`);
    console.log(`  no references to: ${FORBIDDEN_TOKENS.join(', ')}`);
    process.exit(0);
  }

  console.error('check-sdk-bundle: FAILED');
  console.error(`Bundle ${path.relative(process.cwd(), BUNDLE_PATH)} references forbidden dependencies:`);
  console.error('');
  for (const hit of unique) {
    console.error(`  [${hit.token}] @ offset ${hit.offset}`);
    console.error(`      ...${hit.snippet}...`);
  }
  console.error('');
  console.error('These packages belong to the worker/HTTP shell and must not enter');
  console.error('the SDK bundle. See plans/2026-05-25-cmem-sdk-and-server-rename.md §2 line 181.');
  process.exit(1);
}

main();
