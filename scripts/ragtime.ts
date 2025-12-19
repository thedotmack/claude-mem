#!/usr/bin/env bun
/**
 * RAGTIME Email Processor
 *
 * Processes email corpus using claude-mem as observer with email-investigation mode.
 * Creates Agent SDK sessions for each email with progressive context disclosure.
 */

import { loadEmails, type Email } from './email-loader.js';
import { buildContextForEmail } from './context-builder.js';
import { SessionStore } from '../src/services/sqlite/SessionStore.js';
import { getProjectName } from '../src/utils/project-name.js';

// @ts-ignore - Agent SDK types may not be available
import { query } from '@anthropic-ai/claude-agent-sdk';
import { execSync } from 'child_process';

const CORPUS_PATH = process.env.CORPUS_PATH || './corpus/emails.json';
const CLAUDE_MEM_MODE = process.env.CLAUDE_MEM_MODE || 'email-investigation';
const MODEL_ID = process.env.CLAUDE_MEM_MODEL || 'claude-sonnet-4-5-20250929';

const PRIMARY_PROMPT = `You are analyzing this email as part of a fraud investigation.

Focus on:
- **Entities**: Identify people, organizations, email addresses, locations
- **Relationships**: Who communicates with whom? What are the organizational ties?
- **Timeline**: When did events occur? What is the sequence of communications?
- **Evidence**: What documentation or proof is mentioned or provided?
- **Anomalies**: Unusual patterns, inconsistencies, red flags
- **Corroboration**: Does this email support or contradict previous findings?

Your observations will be recorded automatically by claude-mem. Focus on analyzing the email thoroughly.`;

function findClaudeExecutable(): string {
  try {
    return execSync('which claude', { encoding: 'utf-8' }).trim();
  } catch (error) {
    throw new Error('Claude Code executable not found. Make sure "claude" is in your PATH.');
  }
}

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

  const claudePath = findClaudeExecutable();

  const disallowedTools = [
    'Bash',
    'Read',
    'Write',
    'Edit',
    'Grep',
    'Glob',
    'WebFetch',
    'WebSearch',
    'Task',
    'NotebookEdit',
    'AskUserQuestion',
    'TodoWrite'
  ];

  async function* messageGenerator() {
    yield {
      role: 'user' as const,
      content: fullPrompt,
    };
  }

  try {
    const queryResult = query({
      prompt: messageGenerator(),
      options: {
        model: MODEL_ID,
        disallowedTools,
        pathToClaudeCodeExecutable: claudePath,
      },
    });

    let responseText = '';
    for await (const message of queryResult) {
      if (message.type === 'assistant') {
        const content = message.message.content;
        const textContent = Array.isArray(content)
          ? content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n')
          : typeof content === 'string' ? content : '';

        responseText += textContent;
      }
    }

    console.log(`  ✓ Processed successfully`);
  } catch (error) {
    console.error(`  ✗ Error processing email:`, error);
    throw error;
  }
}

async function main() {
  console.log('RAGTIME Email Processor');
  console.log('======================\n');
  console.log(`Corpus: ${CORPUS_PATH}`);
  console.log(`Mode: ${CLAUDE_MEM_MODE}`);
  console.log(`Model: ${MODEL_ID}\n`);

  if (process.env.CLAUDE_MEM_MODE !== CLAUDE_MEM_MODE) {
    console.warn(`⚠️  Warning: CLAUDE_MEM_MODE environment variable is not set to "${CLAUDE_MEM_MODE}"`);
    console.warn(`   Set it before running: export CLAUDE_MEM_MODE=${CLAUDE_MEM_MODE}\n`);
  }

  console.log('Loading emails...');
  const emails = await loadEmails(CORPUS_PATH);
  console.log(`Loaded ${emails.length} emails\n`);

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
