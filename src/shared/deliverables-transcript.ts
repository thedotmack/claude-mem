import { existsSync } from 'fs';
import { readTranscriptTail } from './advisor-transcript.js';
import { stripMemoryTags, stripSystemReminderBlocks } from '../utils/tag-stripping.js';

/**
 * What a Claude Code transcript says the agent made this turn: the files its
 * Write / Edit / NotebookEdit calls touched, the work-state writes that may
 * attach a work product, and whether the prompt that started the turn was
 * private. The Stop hook reads these to find the turn's deliverables
 * (src/cli/deliverables-capture.ts).
 *
 * Same shape as the advisor scan (advisor-transcript.ts): assistant entries
 * carry `tool_use` content blocks `{ id, name, input }`; the following user
 * entry carries the paired `tool_result` block, `is_error: true` when the
 * call failed. A failed write made no file, so it is dropped.
 */

/**
 * The first read's bound, the same as ADVISOR_SCAN_TAIL_BYTES and for the same
 * reason: the scan runs on every Stop and a turn's calls sit at the end of the
 * file. A turn longer than this is read further back, the tail doubling until
 * its prompt is in view (extractTranscriptFileActivity), because the prompt
 * decides whether the turn is private.
 */
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
  /** True when the prompt that started the scan's last turn was in the text read; false when the read began after it. */
  promptSeen: boolean;
  /** True when that prompt was entirely <private>: the turn leaves no copy and no record (isPrivatePrompt). */
  privateTurn: boolean;
}

export interface ExtractFileActivityOptions {
  /** Only the transcript's final turn (after the last user prompt). The Stop hook runs once per turn, so each turn is scanned once. */
  currentTurnOnly?: boolean;
  maxTailBytes?: number;
  /**
   * Read entries marked `isSidechain` too. A session's transcript marks what
   * its subagents did that way, and Stop leaves those to SubagentStop; a
   * subagent's own transcript marks every entry that way, so SubagentStop
   * sets this when it scans the finished subagent's file.
   */
  includeSidechain?: boolean;
}

const NO_ACTIVITY: TranscriptFileActivity = { writes: [], workStateWrites: [], promptSeen: false, privateTurn: false };

/**
 * A prompt that is entirely <private> (or other memory tags) marks a private
 * turn: the same test the worker applies to the prompt it stores
 * (prompt-storage.ts), after which observations and summaries for the turn are
 * skipped (PrivacyCheckValidator). A prompt with a private section and other
 * text is not private as a whole.
 */
export function isPrivatePrompt(text: string): boolean {
  return text.trim() !== '' && stripMemoryTags(text).trim() === '';
}

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
  let maxTailBytes = options.maxTailBytes ?? DELIVERABLE_SCAN_TAIL_BYTES;
  for (;;) {
    const { text, startOffset } = readTranscriptTail(transcriptPath, maxTailBytes);
    if (!text.trim()) return NO_ACTIVITY;
    const activity = extractTranscriptFileActivityFromJsonl(text, options);
    // The turn's prompt decides its privacy, so a read that began after the prompt is widened until the prompt is in it or the file is read whole.
    if (activity.promptSeen || startOffset === 0 || options.currentTurnOnly === false) return activity;
    maxTailBytes *= 2;
  }
}

export function extractTranscriptFileActivityFromJsonl(content: string, options: ExtractFileActivityOptions = {}): TranscriptFileActivity {
  const currentTurnOnly = options.currentTurnOnly ?? true;
  const lines = content.split('\n');
  let lastUserLine = 0;
  let lastPrompt = '';
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
    if (entry?.isSidechain === true && !options.includeSidechain) continue;

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
      if (text || hasMedia) {
        lastUserLine = i + 1;
        lastPrompt = text;
      }
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
    promptSeen: lastUserLine > 0,
    privateTurn: isPrivatePrompt(lastPrompt),
  };
}
