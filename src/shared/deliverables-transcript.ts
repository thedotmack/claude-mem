import { existsSync } from 'fs';
import { readTranscriptTail } from './advisor-transcript.js';
import { stripSystemReminderBlocks } from '../utils/tag-stripping.js';

/**
 * What a Claude Code transcript says the agent made this turn: the files its
 * Write / Edit / NotebookEdit calls touched, and the work-state writes that
 * may attach a work product. The Stop hook reads these to find the turn's
 * deliverables (src/cli/deliverables-capture.ts).
 *
 * Same shape as the advisor scan (advisor-transcript.ts): assistant entries
 * carry `tool_use` content blocks `{ id, name, input }`; the following user
 * entry carries the paired `tool_result` block, `is_error: true` when the
 * call failed. A failed write made no file, so it is dropped.
 */

/** Same bound and reason as ADVISOR_SCAN_TAIL_BYTES: the scan runs on every Stop and a turn's calls sit at the end of the file. */
export const DELIVERABLE_SCAN_TAIL_BYTES = 2 * 1024 * 1024;

/** Tools whose call names the file they wrote: `file_path` (Write, Edit, MultiEdit) or `notebook_path` (NotebookEdit). */
const FILE_WRITING_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
/** claude-mem's own tool, however the host prefixes it (mcp__plugin_claude-mem_mcp-search__work_state_write). */
const WORK_STATE_WRITE_TOOL = /(?:^|__)work_state_write$/;

export interface TranscriptFileWrite {
  path: string;
  toolName: string;
  toolUseId: string;
  occurredAtEpoch: number;
}

export interface TranscriptWorkStateWrite {
  list: string | null;
  fields: Record<string, unknown>;
  toolUseId: string;
  occurredAtEpoch: number;
}

export interface TranscriptFileActivity {
  /** One entry per path, the last write to it. */
  writes: TranscriptFileWrite[];
  workStateWrites: TranscriptWorkStateWrite[];
}

export interface ExtractFileActivityOptions {
  /** Only the transcript's final turn (after the last user prompt). The Stop hook runs once per turn, so each turn is scanned once. */
  currentTurnOnly?: boolean;
  maxTailBytes?: number;
}

const NO_ACTIVITY: TranscriptFileActivity = { writes: [], workStateWrites: [] };

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block): block is { type: 'text'; text: string } =>
      !!block && typeof block === 'object' && (block as { type?: unknown }).type === 'text' && typeof (block as { text?: unknown }).text === 'string')
    .map(block => block.text)
    .join('\n');
}

function parseEpoch(timestamp: unknown): number | null {
  if (typeof timestamp !== 'string') return null;
  const ms = Date.parse(timestamp);
  return Number.isFinite(ms) ? ms : null;
}

export function extractTranscriptFileActivity(transcriptPath: string, options: ExtractFileActivityOptions = {}): TranscriptFileActivity {
  if (!transcriptPath || !existsSync(transcriptPath)) return NO_ACTIVITY;
  const { text } = readTranscriptTail(transcriptPath, options.maxTailBytes ?? DELIVERABLE_SCAN_TAIL_BYTES);
  if (!text.trim()) return NO_ACTIVITY;
  return extractTranscriptFileActivityFromJsonl(text, options);
}

export function extractTranscriptFileActivityFromJsonl(content: string, options: ExtractFileActivityOptions = {}): TranscriptFileActivity {
  const currentTurnOnly = options.currentTurnOnly ?? true;
  const lines = content.split('\n');
  let lastUserLine = 0;
  const failed = new Set<string>();
  const writes: Array<TranscriptFileWrite & { userTurnLine: number }> = [];
  const workStateWrites: Array<TranscriptWorkStateWrite & { userTurnLine: number }> = [];

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    if (!rawLine || !rawLine.trim()) continue;
    // Tolerate truncated or malformed JSONL lines (a crash mid-write, a partial flush): same policy as transcript-parser.ts.
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
      if (Array.isArray(msgContent)) {
        for (const block of msgContent) {
          if (block && typeof block === 'object' && block.type === 'tool_result' && block.is_error === true && typeof block.tool_use_id === 'string') {
            failed.add(block.tool_use_id);
          }
        }
      }
      const text = stripSystemReminderBlocks(textFromContent(msgContent)).trim();
      // Tool results are user-role records too, but do not start a turn; a prompt with only an image or document does.
      const hasMedia = Array.isArray(msgContent) && msgContent.some(block =>
        block && typeof block === 'object' && (block.type === 'image' || block.type === 'document'));
      if (text || hasMedia) lastUserLine = i + 1;
      continue;
    }

    if (entryType !== 'assistant' || !Array.isArray(msgContent)) continue;
    const occurredAtEpoch = parseEpoch(entry.timestamp) ?? 0;
    for (const block of msgContent) {
      if (!block || typeof block !== 'object' || block.type !== 'tool_use' || typeof block.name !== 'string' || typeof block.id !== 'string') continue;
      const input = block.input && typeof block.input === 'object' ? block.input as Record<string, unknown> : {};
      if (FILE_WRITING_TOOLS.has(block.name)) {
        const path = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : null;
        if (path && path.trim()) writes.push({ path: path.trim(), toolName: block.name, toolUseId: block.id, occurredAtEpoch, userTurnLine: lastUserLine });
        continue;
      }
      if (WORK_STATE_WRITE_TOOL.test(block.name)) {
        const fields = input.fields && typeof input.fields === 'object' && !Array.isArray(input.fields) ? input.fields as Record<string, unknown> : null;
        if (!fields) continue;
        workStateWrites.push({ list: typeof input.list === 'string' ? input.list : null, fields, toolUseId: block.id, occurredAtEpoch, userTurnLine: lastUserLine });
      }
    }
  }

  // With only the file's tail read, the turn may have started before it; then no user line was seen
  // (lastUserLine 0) and everything in the tail belongs to the current turn, which the filter keeps.
  const inTurn = <T extends { userTurnLine: number; toolUseId: string }>(record: T) =>
    (!currentTurnOnly || record.userTurnLine === lastUserLine) && !failed.has(record.toolUseId);
  const lastWriteByPath = new Map<string, TranscriptFileWrite>();
  for (const { userTurnLine: _turn, ...write } of writes.filter(inTurn)) lastWriteByPath.set(write.path, write);
  return {
    writes: [...lastWriteByPath.values()],
    workStateWrites: workStateWrites.filter(inTurn).map(({ userTurnLine: _turn, ...write }) => write),
  };
}
