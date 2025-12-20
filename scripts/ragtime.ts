#!/usr/bin/env bun
/**
 * RAGTIME runner (Email Investigation)
 *
 * Spec-aligned behavior:
 * - Materialize corpus entries to per-email files on disk
 * - Run Claude Code (via Agent SDK) with claude-mem plugin loaded
 * - Prompt the agent to use the Read tool to read the email file path
 * - Let claude-mem handle context injection + observation persistence
 */

import { loadEmails, type Email } from '../ragtime/email-loader.js';
import { SettingsDefaultsManager } from '../src/shared/SettingsDefaultsManager.js';
import { mkdir, writeFile } from 'fs/promises';
import { execSync } from 'child_process';
import { homedir } from 'os';
import path from 'path';

// @ts-ignore - Agent SDK types may not be available
import { query } from '@anthropic-ai/claude-agent-sdk';

const CORPUS_PATH = process.env.CORPUS_PATH || './datasets/epstein-emails/index.json';
const EMAIL_LIMIT = process.env.EMAIL_LIMIT ? parseInt(process.env.EMAIL_LIMIT, 10) : undefined;

// IMPORTANT: claude-mem reads this env var to choose the mode.
const MODE = process.env.CLAUDE_MEM_MODE || 'email-investigation';

// Controls which "project" claude-mem stores observations under.
// claude-mem uses basename(cwd) as the project name.
const RAGTIME_PROJECT = process.env.RAGTIME_PROJECT || 'ragtime-investigation';

// Override email materialization directory (defaults into CLAUDE_MEM_DATA_DIR).
const RAGTIME_EMAIL_DIR = process.env.RAGTIME_EMAIL_DIR;

// Plugin path:
// - Prefer local repo plugin during development
// - Fall back to marketplace install path
const RAGTIME_PLUGIN_PATH = process.env.RAGTIME_PLUGIN_PATH;

const MODEL_ID = process.env.CLAUDE_MEM_MODEL || process.env.RAGTIME_MODEL || 'claude-sonnet-4-5-20250929';
const RAGTIME_DEBUG = process.env.RAGTIME_DEBUG === '1' || process.env.RAGTIME_DEBUG === 'true';

const PRIMARY_PROMPT = 'Read this email and think about how it relates to the emails that came before it.';

function sanitizeFilenamePart(value: string): string {
  return value
    // Avoid spaces in paths to make tool-calling + prompts robust.
    .replace(/\s+/g, '_')
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/\.+/g, '.')
    .slice(0, 120);
}

function toIsoDateSafe(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'unknown-date';
  // YYYY-MM-DD
  return d.toISOString().slice(0, 10);
}

async function materializeEmails(args: {
  emails: Email[];
  baseDir: string;
  project: string;
  corpusPath: string;
}): Promise<Map<string, string>> {
  await mkdir(args.baseDir, { recursive: true });

  const index: Array<{ id: string; path: string; subject: string; date: string }> = [];
  const idToPath = new Map<string, string>();

  for (let i = 0; i < args.emails.length; i++) {
    const email = args.emails[i];
    const num = String(i + 1).padStart(6, '0');
    const datePart = toIsoDateSafe(email.date);
    const subjectPart = sanitizeFilenamePart(email.subject || 'no-subject');
    const idPart = sanitizeFilenamePart(email.id || `email-${i + 1}`);

    const filename = `${num}_${datePart}_${idPart}_${subjectPart}.md`;
    const filePath = path.join(args.baseDir, filename);

    const yaml = [
      '---',
      `project: ${JSON.stringify(args.project)}`,
      `corpus_path: ${JSON.stringify(args.corpusPath)}`,
      `email_number: ${i + 1}`,
      `total_emails: ${args.emails.length}`,
      `id: ${JSON.stringify(email.id)}`,
      `date: ${JSON.stringify(email.date)}`,
      `from: ${JSON.stringify(email.from)}`,
      `to: ${JSON.stringify(email.to)}`,
      email.cc ? `cc: ${JSON.stringify(email.cc)}` : 'cc: []',
      email.bcc ? `bcc: ${JSON.stringify(email.bcc)}` : 'bcc: []',
      `subject: ${JSON.stringify(email.subject)}`,
      '---',
      '',
      '# Body',
      '',
      email.body || ''
    ].join('\n');

    await writeFile(filePath, yaml, 'utf-8');

    idToPath.set(email.id, filePath);
    index.push({ id: email.id, path: filePath, subject: email.subject, date: email.date });
  }

  await writeFile(path.join(args.baseDir, 'index.json'), JSON.stringify(index, null, 2), 'utf-8');
  return idToPath;
}

function formatEmailHeader(email: Email, emailNumber: number, totalEmails: number): string {
  const toList = email.to.join(', ');
  const ccList = email.cc && email.cc.length > 0 ? `\nCC: ${email.cc.join(', ')}` : '';
  const bccList = email.bcc && email.bcc.length > 0 ? `\nBCC: ${email.bcc.join(', ')}` : '';

  return [
    `Email ${emailNumber}/${totalEmails}`,
    `From: ${email.from}`,
    `To: ${toList}${ccList}${bccList}`,
    `Date: ${email.date}`,
    `Subject: ${email.subject}`,
  ].join('\n');
}

function resolvePluginPath(repoRoot: string): string {
  if (RAGTIME_PLUGIN_PATH && RAGTIME_PLUGIN_PATH.trim()) {
    return RAGTIME_PLUGIN_PATH.trim();
  }

  const local = path.join(repoRoot, 'plugin');
  const marketplace = path.join(homedir(), '.claude', 'plugins', 'marketplaces', 'thedotmack', 'claude-mem');
  return local || marketplace;
}

function findClaudeExecutable(): string {
  const cmd = process.platform === 'win32' ? 'where claude' : 'which claude';
  return execSync(cmd, { encoding: 'utf8', windowsHide: true }).trim().split('\n')[0].trim();
}

async function runEmailThroughClaude(args: {
  pluginPath: string;
  prompt: string;
  model: string;
}): Promise<void> {
  const claudePath = findClaudeExecutable();

  const stream = query({
    prompt: args.prompt,
    options: {
      model: args.model,
      plugins: [{ type: 'local', path: args.pluginPath }],
      pathToClaudeCodeExecutable: claudePath,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      includePartialMessages: true,
    }
  });

  for await (const message of stream) {
    if (message.type === 'assistant') {
      const content = message.message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text') process.stdout.write(block.text);
        }
      } else if (typeof content === 'string') {
        process.stdout.write(content);
      }
      continue;
    }

    // Debug: surface tool usage and other stream events so we can confirm Read is happening.
    if (RAGTIME_DEBUG) {
      try {
        const maybeTool = (message as any).tool?.name || (message as any).message?.name || (message as any).name;
        const maybeInput = (message as any).tool?.input || (message as any).input || (message as any).message?.input;
        if (maybeTool) {
          console.error(`\n[RAGTIME_DEBUG] event=${(message as any).type} tool=${maybeTool}`);
          if (maybeInput) console.error(`[RAGTIME_DEBUG] input=${JSON.stringify(maybeInput).slice(0, 500)}`);
        } else {
          console.error(`\n[RAGTIME_DEBUG] event=${(message as any).type}`);
        }
      } catch {
        console.error(`\n[RAGTIME_DEBUG] event=(unprintable)`);
      }
    }
  }
}

async function main(): Promise<void> {
  // Ensure mode is set for claude-mem hooks.
  process.env.CLAUDE_MEM_MODE = MODE;

  const corpusAbsPath = path.resolve(CORPUS_PATH);
  const repoRoot = process.cwd();
  const project = RAGTIME_PROJECT.trim();

  console.log('RAGTIME Email Processor');
  console.log('======================\n');
  console.log(`Corpus: ${corpusAbsPath}`);
  console.log(`Mode: ${MODE}`);
  console.log(`Model: ${MODEL_ID}`);
  console.log(`Project: ${project}\n`);

  console.log('Loading emails...');
  let emails = await loadEmails(corpusAbsPath);

  if (EMAIL_LIMIT && EMAIL_LIMIT < emails.length) {
    emails = emails.slice(0, EMAIL_LIMIT);
    console.log(`Limited to ${emails.length} emails (EMAIL_LIMIT=${EMAIL_LIMIT})\n`);
  } else {
    console.log(`Loaded ${emails.length} emails\n`);
  }

  // chdir into a dedicated directory so claude-mem uses this as the project name.
  const dataDir = SettingsDefaultsManager.get('CLAUDE_MEM_DATA_DIR');
  const projectDir = path.join(dataDir, 'ragtime', project);
  await mkdir(projectDir, { recursive: true });
  process.chdir(projectDir);

  // Materialize emails to stable files for the Read tool.
  const emailDir = RAGTIME_EMAIL_DIR && RAGTIME_EMAIL_DIR.trim()
    ? RAGTIME_EMAIL_DIR.trim()
    : path.join(dataDir, 'ragtime', project, 'emails');

  console.log(`Materializing ${emails.length} emails to: ${emailDir}`);
  const emailPaths = await materializeEmails({
    emails,
    baseDir: emailDir,
    project,
    corpusPath: corpusAbsPath
  });

  const pluginPath = resolvePluginPath(repoRoot);

  for (let i = 0; i < emails.length; i++) {
    const email = emails[i];
    const emailNumber = i + 1;

    console.log(`\n[${emailNumber}/${emails.length}] ${email.subject}`);

    const emailPath = emailPaths.get(email.id);
    if (!emailPath) {
      throw new Error(`Missing materialized path for email id: ${email.id}`);
    }

    // Exact prompt requested.
    const prompt = `Read this email ${emailPath} and think about how it relates to the emails that came before it.`;

    await runEmailThroughClaude({
      pluginPath,
      prompt,
      model: MODEL_ID
    });

    if (emailNumber % 100 === 0) {
      console.log(`\n--- Progress: ${emailNumber}/${emails.length} processed ---\n`);
    }
  }

  console.log('\n======================');
  console.log('Processing Complete!');
  console.log('======================');
  console.log(`Total emails processed: ${emails.length}`);
  console.log(`\nExplore: http://localhost:37777`);
}

main().catch(error => {
  console.error('\nFatal error:', error);
  process.exit(1);
});
