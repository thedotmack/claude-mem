#!/usr/bin/env node

/**
 * Direct transcript transformer - for testing Endless Mode
 * Usage: node scripts/transform-transcript.js <transcript-path>
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { transformTranscript } from '../plugin/scripts/save-hook.js';

const transcriptPath = process.argv[2];

if (!transcriptPath) {
  console.error('Usage: node scripts/transform-transcript.js <transcript-path>');
  console.error('Example: node scripts/transform-transcript.js ~/.claude/projects/-Users-alexnewman-Scripts-claude-mem/4094399f-bbd7-425b-855a-b985fe9c0dee.jsonl');
  process.exit(1);
}

const absolutePath = resolve(transcriptPath);

console.log('🔄 Transforming transcript:', absolutePath);
console.log('');

try {
  // Check if file exists
  readFileSync(absolutePath, 'utf-8');

  // Transform it
  const stats = await transformTranscript(absolutePath, 'manual-transform');

  console.log('✅ Transformation complete!');
  console.log('');
  console.log('Stats:');
  console.log(`  Original tokens:   ${stats.originalTokens}`);
  console.log(`  Compressed tokens: ${stats.compressedTokens}`);
  console.log(`  Savings:           ${stats.originalTokens > 0 ? Math.round((1 - stats.compressedTokens / stats.originalTokens) * 100) : 0}%`);

} catch (error) {
  console.error('❌ Transform failed:', error.message);
  console.error(error);
  process.exit(1);
}
