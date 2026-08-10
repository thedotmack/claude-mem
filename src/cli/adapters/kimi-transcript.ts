// SPDX-License-Identifier: Apache-2.0

// Kimi Code transcript converter.
//
// Kimi's Stop hook payload carries neither transcript_path nor
// last_assistant_message, so without this the summarize handler always
// skips. Kimi persists every session as a wire.jsonl event log under
// $KIMI_CODE_HOME/sessions/<workDirKey>/session_<id>/agents/main/wire.jsonl;
// this module locates that file and converts it to the Claude Code
// transcript JSONL shape the shared transcript parser already reads:
//   {"type":"assistant"|"user","message":{"content":[{"type":"text","text":...}]}}
//
// Verified against wire protocol_version 1.5 (Kimi Code v2, Node engine).

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

function kimiCodeHome(): string {
  return process.env.KIMI_CODE_HOME || path.join(process.env.HOME || '', '.kimi-code');
}

function findWireFile(sessionId: string): string | null {
  const sessionsRoot = path.join(kimiCodeHome(), 'sessions');
  const dirName = sessionId.startsWith('session_') ? sessionId : `session_${sessionId}`;
  let workdirs: string[];
  try {
    workdirs = readdirSync(sessionsRoot);
  } catch {
    return null;
  }
  const candidates: Array<{ wire: string; mtimeMs: number }> = [];
  for (const wd of workdirs) {
    const wire = path.join(sessionsRoot, wd, dirName, 'agents', 'main', 'wire.jsonl');
    try {
      const st = statSync(wire);
      if (st.isFile()) candidates.push({ wire, mtimeMs: st.mtimeMs });
    } catch {
      // not in this workdir bucket — keep looking
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0].wire;
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (c): c is { type: 'text'; text: string } =>
          !!c && typeof c === 'object' && (c as { type?: unknown }).type === 'text'
          && typeof (c as { text?: unknown }).text === 'string',
      )
      .map((c) => c.text)
      .join('\n');
  }
  return '';
}

interface TranscriptLine {
  type: 'user' | 'assistant';
  message: { role: 'user' | 'assistant'; content: Array<{ type: 'text'; text: string }> };
}

function convertWireToTranscript(wirePath: string): TranscriptLine[] {
  const out: TranscriptLine[] = [];
  for (const rawLine of readFileSync(wirePath, 'utf-8').split('\n')) {
    if (!rawLine.trim()) continue;
    let line: any;
    try {
      line = JSON.parse(rawLine);
    } catch {
      continue; // tolerate truncated writes, same as the shared parser
    }

    // User and system-injected messages
    if (line.type === 'context.append_message' && line.message) {
      const text = textFromContent(line.message.content);
      if (!text.trim()) continue;
      const role = line.message.role === 'user' ? 'user' : 'assistant';
      out.push({ type: role, message: { role, content: [{ type: 'text', text }] } });
      continue;
    }

    // Assistant streaming output: thinking parts are skipped — the shared
    // parser only reads text content.
    if (
      line.type === 'context.append_loop_event' &&
      line.event &&
      line.event.type === 'content.part' &&
      line.event.part &&
      line.event.part.type === 'text' &&
      typeof line.event.part.text === 'string' &&
      line.event.part.text.trim()
    ) {
      out.push({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: line.event.part.text }] },
      });
    }
  }
  return out;
}

/**
 * Convert the Kimi session's wire.jsonl to a Claude Code transcript in a temp
 * file and return its path. Returns null when the session wire file cannot be
 * found or yields no convertible messages.
 */
export function synthesizeKimiTranscript(sessionId: string): string | null {
  const wire = findWireFile(sessionId);
  if (!wire) return null;

  const lines = convertWireToTranscript(wire);
  if (lines.length === 0) return null;

  const outPath = path.join(
    tmpdir(),
    `claude-mem-kimi-transcript-${sessionId.replace(/[^A-Za-z0-9_-]/g, '')}.jsonl`,
  );
  writeFileSync(outPath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return outPath;
}
