#!/usr/bin/env npx tsx
/**
 * Ingest archived Claude Code transcript JSONL files into claude-mem.
 *
 * Reads .jsonl.archive files, extracts tool_use / tool_result pairs from
 * assistant and user messages, and sends each observation to the worker
 * API with the original historical timestamp.
 *
 * Usage:
 *   npx tsx scripts/ingest-archived-transcripts.ts <glob-or-dir> [--project=name]
 *
 * Examples:
 *   npx tsx scripts/ingest-archived-transcripts.ts ~/.claude-mem-backup/archives/memedeck-ui/
 *   npx tsx scripts/ingest-archived-transcripts.ts ~/.claude-mem-backup/archives/memedeck-ui/ --project=memedeck-ui
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, resolve } from 'path';

const WORKER_BASE = 'http://127.0.0.1:37777';

interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}

interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: unknown;
  is_error?: boolean;
}

interface TranscriptEntry {
  type: 'user' | 'assistant' | 'summary' | 'system';
  sessionId: string;
  cwd: string;
  timestamp: string;
  message?: {
    role: string;
    content: string | Array<Record<string, unknown>>;
  };
}

async function sendObservation(
  contentSessionId: string,
  cwd: string,
  toolName: string,
  toolInput: unknown,
  toolResponse: unknown,
  timestampEpoch: number,
  platformSource: string
): Promise<boolean> {
  try {
    const response = await fetch(`${WORKER_BASE}/api/sessions/observations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contentSessionId,
        platformSource,
        tool_name: toolName,
        tool_input: toolInput,
        tool_response: toolResponse,
        cwd,
        override_timestamp_epoch: timestampEpoch
      })
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function sendSessionInit(
  contentSessionId: string,
  cwd: string,
  prompt: string,
  platformSource: string
): Promise<void> {
  try {
    await fetch(`${WORKER_BASE}/api/sessions/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contentSessionId,
        cwd,
        prompt,
        platformSource
      })
    });
  } catch {
    // Best effort
  }
}

async function sendSummarize(
  contentSessionId: string,
  lastAssistantMessage: string,
  platformSource: string
): Promise<void> {
  try {
    await fetch(`${WORKER_BASE}/api/sessions/summarize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contentSessionId,
        last_assistant_message: lastAssistantMessage,
        platformSource
      })
    });
  } catch {
    // Best effort
  }
}

function extractToolPairs(entries: TranscriptEntry[]): Array<{
  sessionId: string;
  cwd: string;
  timestamp: string;
  toolName: string;
  toolInput: unknown;
  toolResponse: unknown;
}> {
  const pendingTools = new Map<string, { name: string; input: unknown; timestamp: string; sessionId: string; cwd: string }>();
  const pairs: Array<{
    sessionId: string;
    cwd: string;
    timestamp: string;
    toolName: string;
    toolInput: unknown;
    toolResponse: unknown;
  }> = [];

  for (const entry of entries) {
    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (block.type === 'tool_use') {
        const tu = block as unknown as ToolUseBlock;
        pendingTools.set(tu.id, {
          name: tu.name,
          input: tu.input,
          timestamp: entry.timestamp,
          sessionId: entry.sessionId,
          cwd: entry.cwd
        });
      }

      if (block.type === 'tool_result') {
        const tr = block as unknown as ToolResultBlock;
        const pending = pendingTools.get(tr.tool_use_id);
        if (pending) {
          pairs.push({
            sessionId: pending.sessionId,
            cwd: pending.cwd,
            timestamp: pending.timestamp,
            toolName: pending.name,
            toolInput: pending.input,
            toolResponse: tr.content
          });
          pendingTools.delete(tr.tool_use_id);
        }
      }
    }
  }

  return pairs;
}

async function ingestFile(filePath: string, projectOverride?: string): Promise<{ sent: number; failed: number; sessions: Set<string> }> {
  const raw = readFileSync(filePath, 'utf-8');
  const lines = raw.split('\n').filter(l => l.trim());

  const entries: TranscriptEntry[] = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      // Skip malformed lines
    }
  }

  if (entries.length === 0) return { sent: 0, failed: 0, sessions: new Set() };

  const sessions = new Set<string>();
  const sessionFirstPrompts = new Map<string, { prompt: string; cwd: string }>();

  // Collect first user prompt per session for init
  for (const entry of entries) {
    if (entry.type === 'user' && entry.sessionId) {
      sessions.add(entry.sessionId);
      if (!sessionFirstPrompts.has(entry.sessionId)) {
        const msgContent = entry.message?.content;
        const prompt = typeof msgContent === 'string' ? msgContent : '';
        sessionFirstPrompts.set(entry.sessionId, { prompt, cwd: entry.cwd });
      }
    }
  }

  // Send session inits
  const platformSource = 'claude-code-archive';
  for (const [sessionId, { prompt, cwd }] of sessionFirstPrompts) {
    await sendSessionInit(sessionId, cwd, prompt, platformSource);
  }

  // Extract and send tool pairs
  const pairs = extractToolPairs(entries);
  let sent = 0;
  let failed = 0;

  for (const pair of pairs) {
    const timestampEpoch = new Date(pair.timestamp).getTime();
    const ok = await sendObservation(
      pair.sessionId,
      pair.cwd,
      pair.toolName,
      pair.toolInput,
      pair.toolResponse,
      timestampEpoch,
      platformSource
    );
    if (ok) sent++;
    else failed++;
  }

  // Send summarize for each session so the worker generates summaries
  const lastAssistantBySession = new Map<string, string>();
  for (const entry of entries) {
    if (entry.type === 'assistant' && entry.sessionId) {
      const content = entry.message?.content;
      if (Array.isArray(content)) {
        const textBlocks = content.filter((b: any) => b.type === 'text').map((b: any) => b.text);
        if (textBlocks.length > 0) {
          lastAssistantBySession.set(entry.sessionId, textBlocks.join('\n'));
        }
      } else if (typeof content === 'string') {
        lastAssistantBySession.set(entry.sessionId, content);
      }
    }
  }

  for (const [sessionId, lastMsg] of lastAssistantBySession) {
    await sendSummarize(sessionId, lastMsg, platformSource);
  }

  return { sent, failed, sessions };
}

async function main() {
  const args = process.argv.slice(2);
  const projectArg = args.find(a => a.startsWith('--project='));
  const projectOverride = projectArg?.split('=')[1];
  const pathArg = args.find(a => !a.startsWith('--'));

  if (!pathArg) {
    console.error('Usage: npx tsx scripts/ingest-archived-transcripts.ts <dir-or-glob> [--project=name]');
    process.exit(1);
  }

  const resolvedPath = resolve(pathArg.replace(/^~/, process.env.HOME || ''));

  let files: string[] = [];
  try {
    const stat = statSync(resolvedPath);
    if (stat.isDirectory()) {
      files = readdirSync(resolvedPath)
        .filter(f => f.endsWith('.jsonl.archive') || f.endsWith('.jsonl'))
        .map(f => join(resolvedPath, f));
    } else {
      files = [resolvedPath];
    }
  } catch (err) {
    console.error(`Cannot access: ${resolvedPath}`);
    process.exit(1);
  }

  console.log(`Found ${files.length} archive files to ingest`);

  let totalSent = 0;
  let totalFailed = 0;
  const allSessions = new Set<string>();

  for (const file of files) {
    const basename = file.split('/').pop();
    const result = await ingestFile(file, projectOverride);
    result.sessions.forEach(s => allSessions.add(s));
    totalSent += result.sent;
    totalFailed += result.failed;
    console.log(`  ${basename}: ${result.sent} observations sent, ${result.failed} failed (${result.sessions.size} sessions)`);
  }

  console.log(`\nDone: ${totalSent} observations ingested across ${allSessions.size} sessions (${totalFailed} failures)`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
