#!/usr/bin/env node

import { readFileSync } from 'fs';
import { resolve } from 'path';

const filePath = process.argv[2];

if (!filePath) {
  console.error('Usage: node analyze-transcript-schema.js <transcript-file.jsonl>');
  process.exit(1);
}

const absolutePath = resolve(filePath);
const content = readFileSync(absolutePath, 'utf-8');
const lines = content.trim().split('\n');

console.log(`TRANSCRIPT FULL SCHEMA`);
console.log(`File: ${absolutePath}`);
console.log(`Total lines: ${lines.length}\n`);
console.log('='.repeat(100));

lines.forEach((line, index) => {
  if (!line.trim()) return;

  try {
    const json = JSON.parse(line);
    console.log(`\nLINE ${index + 1}`);
    console.log(JSON.stringify(json, null, 2));
    console.log('-'.repeat(100));
  } catch (error) {
    console.error(`\nLINE ${index + 1}: PARSE ERROR`);
    console.error(error.message);
    console.log('-'.repeat(100));
  }
});

console.log('');
