// SPDX-License-Identifier: Apache-2.0

import { readFileSync, existsSync } from 'fs';
import { SYSTEM_REMINDER_REGEX } from '../utils/tag-stripping.js';

/**
 * Extraction of `advisor` tool calls from a Claude Code transcript.
 *
 * The advisor tool is a SERVER-side tool: it never goes through the client
 * tool-execution loop, so PostToolUse hooks never fire for it and it never
 * reaches the observation pipeline. Its only durable trace is in the
 * transcript JSONL, where an assistant entry carries a `server_tool_use`
 * content block (name: 'advisor', id: 'srvtoolu_...', empty input — the tool
 * forwards the whole conversation, it takes no arguments) and a following
 * assistant entry carries the paired `advisor_tool_result` block:
 *
 *   success: { type: 'advisor_tool_result', tool_use_id, content: { type: 'advisor_result', text } }
 *   failure: { type: 'advisor_tool_result', tool_use_id, content: { type: 'advisor_tool_result_error', error_code } }
 *
 * The entry-level `advisorModel` field names the model that served the call
 * (e.g. 'claude-fable-5'). Failed calls carry no advice and are skipped.
 */

export interface TranscriptAdvisorCall {
  /** `srvtoolu_...` id of the server_tool_use block — stable dedup key. */
  toolUseId: string;
  /** Entry-level advisorModel of the call entry (e.g. 'claude-fable-5'). */
  advisorModel: string | null;
  /** Full advice text, verbatim. */
  advice: string;
  /** Timestamp of the call entry (falls back to result-entry time). */
  occurredAtEpoch: number;
  /** 1-based line number of the call entry within the transcript. */
  transcriptLineNumber: number;
  /** Text of the user message that started the turn containing the call. */
  lastUserMessage: string | null;
}

interface PendingCall {
  advisorModel: string | null;
  occurredAtEpoch: number;
  transcriptLineNumber: number;
  lastUserMessage: string | null;
  userTurnLine: number;
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((c): c is { type: 'text'; text: string } =>
      !!c && typeof c === 'object' && (c as { type?: unknown }).type === 'text' && typeof (c as { text?: unknown }).text === 'string')
    .map(c => c.text)
    .join('\n');
}

function parseEpoch(timestamp: unknown): number | null {
  if (typeof timestamp !== 'string') return null;
  const ms = Date.parse(timestamp);
  return Number.isFinite(ms) ? ms : null;
}

export interface ExtractAdvisorCallsOptions {
  /**
   * Only return calls made during the transcript's final turn (after the last
   * user message with text content). The Stop hook runs once per turn, so
   * scanning just the turn that ended captures each call exactly once;
   * storage-level dedup on toolUseId is the backstop for re-fired hooks.
   */
  currentTurnOnly?: boolean;
}

export function extractAdvisorCalls(
  transcriptPath: string,
  options: ExtractAdvisorCallsOptions = {}
): TranscriptAdvisorCall[] {
  if (!transcriptPath || !existsSync(transcriptPath)) {
    return [];
  }
  const content = readFileSync(transcriptPath, 'utf-8');
  if (!content.trim()) {
    return [];
  }
  return extractAdvisorCallsFromJsonl(content, options);
}

export function extractAdvisorCallsFromJsonl(
  content: string,
  options: ExtractAdvisorCallsOptions = {}
): TranscriptAdvisorCall[] {
  const lines = content.split('\n');

  let lastUserMessage: string | null = null;
  let lastUserLine = 0;
  const pending = new Map<string, PendingCall>();
  const completed: Array<{ call: TranscriptAdvisorCall; userTurnLine: number }> = [];

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    if (!rawLine || !rawLine.trim()) continue;
    // Tolerate truncated/malformed JSONL lines (crash mid-write, partial
    // flush) — same policy as transcript-parser.ts.
    let entry: any;
    try {
      entry = JSON.parse(rawLine);
    } catch {
      continue;
    }
    if (entry?.isSidechain === true) continue;

    const entryType = entry?.type ?? entry?.message?.role;
    const msgContent = entry?.message?.content;

    if (entryType === 'user') {
      const text = textFromContent(msgContent)
        .replace(SYSTEM_REMINDER_REGEX, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      if (text) {
        lastUserMessage = text;
        lastUserLine = i + 1;
      }
      continue;
    }

    if (entryType !== 'assistant' || !Array.isArray(msgContent)) continue;

    for (const block of msgContent) {
      if (!block || typeof block !== 'object') continue;

      if (block.type === 'server_tool_use' && block.name === 'advisor' && typeof block.id === 'string') {
        pending.set(block.id, {
          advisorModel: typeof entry.advisorModel === 'string' ? entry.advisorModel : null,
          occurredAtEpoch: parseEpoch(entry.timestamp) ?? 0,
          transcriptLineNumber: i + 1,
          lastUserMessage,
          userTurnLine: lastUserLine,
        });
        continue;
      }

      if (block.type === 'advisor_tool_result' && typeof block.tool_use_id === 'string') {
        const started = pending.get(block.tool_use_id);
        if (!started) continue;
        pending.delete(block.tool_use_id);

        const result = block.content;
        if (!result || typeof result !== 'object' || result.type !== 'advisor_result') {
          // advisor_tool_result_error (or unknown shape) — no advice to record.
          continue;
        }
        const advice = typeof result.text === 'string' ? result.text.trim() : '';
        if (!advice) continue;

        completed.push({
          call: {
            toolUseId: block.tool_use_id,
            advisorModel: started.advisorModel,
            advice,
            occurredAtEpoch: started.occurredAtEpoch || (parseEpoch(entry.timestamp) ?? Date.now()),
            transcriptLineNumber: started.transcriptLineNumber,
            lastUserMessage: started.lastUserMessage,
          },
          userTurnLine: started.userTurnLine,
        });
      }
    }
  }

  return completed
    .filter(c => !options.currentTurnOnly || c.userTurnLine === lastUserLine)
    .map(c => c.call);
}
