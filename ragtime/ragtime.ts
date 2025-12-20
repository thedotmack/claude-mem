#!/usr/bin/env bun
/**
 * RAGTIME Email Processor
 *
 * Processes email corpus using claude-mem plugin as observer with email-investigation mode.
 * Uses Agent SDK v2 createSession API to properly load claude-mem plugin.
 */

import { loadEmails, type Email } from './email-loader.js';
import { buildContextForEmail } from './context-builder.js';
import { SessionStore } from '../src/services/sqlite/SessionStore.js';
import { getProjectName } from '../src/utils/project-name.js';
import { homedir } from 'os';
import { join } from 'path';

// @ts-ignore - Agent SDK types may not be available
import { query } from '@anthropic-ai/claude-agent-sdk';

const CORPUS_PATH = process.env.CORPUS_PATH || './datasets/epstein-emails/index.json';
const MODEL_ID = process.env.CLAUDE_MEM_MODEL || 'claude-sonnet-4-5-20250929';
const EMAIL_LIMIT = process.env.EMAIL_LIMIT ? parseInt(process.env.EMAIL_LIMIT, 10) : undefined;

// Path to claude-mem plugin
const CLAUDE_MEM_PLUGIN_PATH = join(homedir(), '.claude', 'plugins', 'marketplaces', 'thedotmack', 'claude-mem');

const PRIMARY_PROMPT = `Read this email and think about how it relates to the emails that came before it.

Focus on:
- **Entities**: Identify people, organizations, email addresses, locations
- **Relationships**: Who communicates with whom? What are the organizational ties?
- **Timeline**: When did events occur? What is the sequence of communications?
- **Evidence**: What documentation or proof is mentioned or provided?
- **Anomalies**: Unusual patterns, inconsistencies, red flags
- **Corroboration**: Does this email support or contradict previous findings`;

async function processEmail(
  email: Email,
  emailNumber: number,
  totalEmails: number,
  sessionStore: SessionStore,
  project: string
): Promise<void> {
  console.log(`\n[${emailNumber}/${totalEmails}] Processing email: ${email.subject}`);
  console.log(`  From: ${email.from}`);
  console.log(`  Date: ${email.date}`);

  const context = buildContextForEmail(sessionStore, email, emailNumber, totalEmails, project);
  const fullPrompt = `${context}\n\n---\n\n${PRIMARY_PROMPT}`;

  try {
    // Create query with claude-mem plugin loaded
    // The plugin will observe all agent activity and record observations
    const queryResult = query({
      prompt: fullPrompt,
      options: {
        model: MODEL_ID,
        plugins: [
          { type: 'local', path: CLAUDE_MEM_PLUGIN_PATH }
        ]
      }
    });

    // Consume response (claude-mem plugin observes automatically)
    for await (const message of queryResult) {
      if (message.type === 'assistant') {
        const content = message.message.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text') {
              process.stdout.write(block.text);
            }
          }
        } else if (typeof content === 'string') {
          process.stdout.write(content);
        }
      }
    }

    console.log(`\n  ✓ Processed successfully`);
  } catch (error) {
    console.error(`\n  ✗ Error processing email:`, error);
    throw error;
  }
}

async function main() {
  // Set mode for claude-mem plugin
  process.env.CLAUDE_MEM_MODE = 'email-investigation';

  console.log('RAGTIME Email Processor');
  console.log('======================\n');
  console.log(`Corpus: ${CORPUS_PATH}`);
  console.log(`Mode: ${process.env.CLAUDE_MEM_MODE}`);
  console.log(`Model: ${MODEL_ID}\n`);

  console.log('Loading emails...');
  let emails = await loadEmails(CORPUS_PATH);

  if (EMAIL_LIMIT && EMAIL_LIMIT < emails.length) {
    emails = emails.slice(0, EMAIL_LIMIT);
    console.log(`Limited to ${emails.length} emails (EMAIL_LIMIT=${EMAIL_LIMIT})\n`);
  } else {
    console.log(`Loaded ${emails.length} emails\n`);
  }

  const sessionStore = new SessionStore();
  const project = getProjectName(process.cwd());

  console.log(`Project: ${project}`);
  console.log('Starting processing...\n');

  for (let i = 0; i < emails.length; i++) {
    const email = emails[i];
    await processEmail(email, i + 1, emails.length, sessionStore, project);

    if ((i + 1) % 100 === 0) {
      console.log(`\n--- Progress: ${i + 1}/${emails.length} emails processed ---\n`);
    }
  }

  const finalObservationCount = sessionStore.getAllRecentObservations(10000).filter(
    obs => obs.project === project
  ).length;

  console.log('\n======================');
  console.log('Processing Complete!');
  console.log('======================');
  console.log(`Total emails processed: ${emails.length}`);
  console.log(`Total observations recorded: ${finalObservationCount}`);
  console.log(`\nView results with: npm run ragtime:explore`);
}

main().catch(error => {
  console.error('\nFatal error:', error);
  process.exit(1);
});
