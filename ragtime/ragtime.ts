#!/usr/bin/env bun
/**
 * RAGTIME Email Investigation Runner
 *
 * Simple script that:
 * 1. Reads markdown emails from directory
 * 2. For each email, creates ONE Agent SDK session with mode='email-investigation'
 * 3. Tells agent to read the markdown file
 * 4. Claude-mem plugin handles observation storage and context injection automatically
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import { existsSync, readdirSync } from 'fs';
import { homedir } from 'os';
import path from 'path';

// Environment configuration
const EMAILS_DIR = process.env.EMAILS_DIR || './datasets/emails-markdown';
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

async function processEmail(emailPath: string, emailNumber: number, totalEmails: number, pluginPath: string): Promise<void> {
  const absolutePath = path.resolve(emailPath);
  console.log(`\n[${emailNumber}/${totalEmails}] ${path.basename(emailPath)}`);

  // Simple prompt - just tell it to read the file
  const prompt = `Read ${absolutePath}`;

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
  // Set mode and project for claude-mem plugin hooks
  process.env.CLAUDE_MEM_MODE = 'email-investigation';
  process.env.CLAUDE_MEM_PROJECT = 'epstein-emails';

  console.log('RAGTIME Email Investigation');
  console.log('===========================\n');

  // Load markdown emails
  const emailsDir = path.resolve(EMAILS_DIR);
  if (!existsSync(emailsDir)) {
    throw new Error(`Emails directory not found: ${emailsDir}\nRun 'npm run ragtime:export' first.`);
  }

  console.log(`Emails: ${emailsDir}`);

  let emailFiles = readdirSync(emailsDir)
    .filter(f => f.endsWith('.md'))
    .sort();

  if (EMAIL_LIMIT && EMAIL_LIMIT < emailFiles.length) {
    emailFiles = emailFiles.slice(0, EMAIL_LIMIT);
    console.log(`Limited to ${emailFiles.length} emails\n`);
  } else {
    console.log(`Found ${emailFiles.length} emails\n`);
  }

  const pluginPath = resolvePluginPath();
  console.log(`Plugin: ${pluginPath}\n`);

  // Process each email in its own session
  for (let i = 0; i < emailFiles.length; i++) {
    const emailPath = path.join(emailsDir, emailFiles[i]);
    await processEmail(emailPath, i + 1, emailFiles.length, pluginPath);
  }

  console.log('\n===========================');
  console.log('Processing Complete!');
  console.log(`Total: ${emailFiles.length} emails`);
  console.log('View results: http://localhost:37777');
}

main().catch(error => {
  console.error('\nError:', error);
  process.exit(1);
});
