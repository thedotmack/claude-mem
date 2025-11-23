#!/usr/bin/env tsx
/**
 * Validate transcript files against claude-code-viewer schemas
 * Usage: npm run validate:transcripts [file1.jsonl] [file2.jsonl]
 *        npm run validate:transcripts (validates all transcripts in ~/.claude/projects/)
 */

import { readdirSync, statSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';
import { validateTranscript } from '../src/utils/transcript-validator.js';

const CLAUDE_PROJECTS_DIR = join(homedir(), '.claude', 'projects');

/**
 * Find all transcript files recursively
 */
function findTranscripts(dir: string): string[] {
  const transcripts: string[] = [];

  try {
    const entries = readdirSync(dir);

    for (const entry of entries) {
      const fullPath = join(dir, entry);
      const stat = statSync(fullPath);

      if (stat.isDirectory()) {
        transcripts.push(...findTranscripts(fullPath));
      } else if (entry.endsWith('.jsonl') && !entry.startsWith('agent-')) {
        transcripts.push(fullPath);
      }
    }
  } catch (error) {
    // Skip directories we can't read
  }

  return transcripts;
}

/**
 * Validate a single transcript and print results
 */
function validateAndReport(filePath: string): boolean {
  console.log(`\nValidating: ${basename(filePath)}`);
  console.log('─'.repeat(60));

  try {
    const results = validateTranscript(filePath);

    console.log(`Total lines: ${results.totalLines}`);
    console.log(`Valid: ${results.validLines} ✓`);
    console.log(`Invalid: ${results.invalidLines} ✗`);

    if (results.invalidLines > 0) {
      console.log('\nValidation Errors:');
      results.errors.forEach((error) => {
        console.log(`\nLine ${error.lineNumber}:`);
        console.log(`  Error: ${error.error}`);
        if (error.entry && typeof error.entry === 'object') {
          const entry = error.entry as any;
          console.log(`  Entry type: ${entry.type || 'unknown'}`);
          if (entry.message) {
            console.log(`  Message ID: ${entry.message.id || 'missing'}`);
            console.log(`  Message type: ${entry.message.type || 'missing'}`);
            console.log(`  Message model: ${entry.message.model || 'missing'}`);
          }
        }
      });
      return false;
    }

    console.log('\n✓ All entries valid');
    return true;
  } catch (error) {
    console.error(`\n✗ Failed to validate: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

/**
 * Main
 */
function main() {
  const args = process.argv.slice(2);

  let transcriptFiles: string[] = [];

  if (args.length > 0) {
    // Validate specific files
    transcriptFiles = args;
  } else {
    // Find all transcripts in ~/.claude/projects/
    console.log(`Searching for transcripts in: ${CLAUDE_PROJECTS_DIR}`);
    transcriptFiles = findTranscripts(CLAUDE_PROJECTS_DIR);

    if (transcriptFiles.length === 0) {
      console.log('No transcript files found');
      process.exit(0);
    }

    console.log(`Found ${transcriptFiles.length} transcript files`);
  }

  let allValid = true;

  for (const file of transcriptFiles) {
    const valid = validateAndReport(file);
    if (!valid) {
      allValid = false;
    }
  }

  console.log('\n' + '='.repeat(60));
  if (allValid) {
    console.log('✓ All transcripts are valid');
    process.exit(0);
  } else {
    console.log('✗ Some transcripts have validation errors');
    process.exit(1);
  }
}

main();
