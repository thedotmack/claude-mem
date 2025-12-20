#!/usr/bin/env bun
/**
 * RAGTIME Email Investigation Runner
 *
 * Simple script that:
 * 1. Loads emails from corpus
 * 2. For each email, creates ONE Agent SDK session with mode='email-investigation'
 * 3. Passes email content to the agent
 * 4. Claude-mem plugin handles observation storage and context injection automatically
 */

import { loadEmails, type Email } from '../ragtime/email-loader.js';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { existsSync } from 'fs';
import { homedir } from 'os';
import path from 'path';

// Environment configuration
const CORPUS_PATH = process.env.CORPUS_PATH || './datasets/epstein-emails/index.json';
const EMAIL_LIMIT = process.env.EMAIL_LIMIT ? parseInt(process.env.EMAIL_LIMIT, 10) : undefined;
const MODEL_ID = process.env.CLAUDE_MEM_MODEL || 'claude-sonnet-4-5-20250929';

function resolvePluginPath(): string {
  // If explicitly set, use that
  if (process.env.RAGTIME_PLUGIN_PATH) {
    return process.env.RAGTIME_PLUGIN_PATH;
  }

  // Try local plugin first (for development)
  const local = path.resolve(process.cwd(), 'plugin');
  if (existsSync(local)) {
    return local;
  }

  // Fall back to marketplace install
  return path.join(homedir(), '.claude', 'plugins', 'marketplaces', 'thedotmack', 'claude-mem');
}

async function processEmail(email: Email, emailNumber: number, totalEmails: number, pluginPath: string): Promise<void> {
  console.log(`\n[${emailNumber}/${totalEmails}] ${email.subject}`);

  // Simple prompt with email content
  const prompt = `Analyze this email and extract key entities, relationships, and events:

From: ${email.from}
To: ${email.to.join(', ')}
${email.cc ? `CC: ${email.cc.join(', ')}\n` : ''}Date: ${email.date}
Subject: ${email.subject}

${email.body}`;

  // Create ONE session for this email with mode='email-investigation'
  const stream = query({
    prompt,
    options: {
      model: MODEL_ID,
      plugins: [{ type: 'local', path: pluginPath }],
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      includePartialMessages: true
    }
  });

  // Stream output
  for await (const message of stream) {
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

  console.log('\n');
}

async function main(): Promise<void> {
  // Set mode for claude-mem plugin hooks to read
  process.env.CLAUDE_MEM_MODE = 'email-investigation';

  console.log('RAGTIME Email Investigation');
  console.log('===========================\n');

  // Load emails
  const corpusAbsPath = path.resolve(CORPUS_PATH);
  console.log(`Corpus: ${corpusAbsPath}`);

  let emails = await loadEmails(corpusAbsPath);

  if (EMAIL_LIMIT && EMAIL_LIMIT < emails.length) {
    emails = emails.slice(0, EMAIL_LIMIT);
    console.log(`Limited to ${emails.length} emails\n`);
  } else {
    console.log(`Loaded ${emails.length} emails\n`);
  }

  const pluginPath = resolvePluginPath();
  console.log(`Plugin: ${pluginPath}\n`);

  // Process each email in its own session
  for (let i = 0; i < emails.length; i++) {
    await processEmail(emails[i], i + 1, emails.length, pluginPath);

    if ((i + 1) % 10 === 0) {
      console.log(`\n--- Progress: ${i + 1}/${emails.length} ---\n`);
    }
  }

  console.log('\n===========================');
  console.log('Processing Complete!');
  console.log(`Total: ${emails.length} emails`);
  console.log('View results: http://localhost:37777');
}

main().catch(error => {
  console.error('\nError:', error);
  process.exit(1);
});
