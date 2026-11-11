// SPDX-License-Identifier: Apache-2.0

/**
 * Line anchors (#4943, opt-in with CLAUDE_MEM_LINE_ANCHORS_ENABLED): where in
 * a file an observation's work is, kept so the file-context hook can point at
 * that code again after the file changes.
 *
 * An anchor is a path, a 1-based line and that line's exact text. The worker
 * takes it when it stores an observation, from the batch's own tool calls and
 * never from model output: a distinctive line inside the text a Claude Code
 * Edit or MultiEdit wrote, or one of a targeted Read's window that the stored
 * (stripped and redacted) tool response also holds as a whole line. A line is
 * anchored only when it occurs exactly once in the file, by its exact text
 * and by its whitespace-squashed text, so it can never point at two places.
 *
 * When the hook builds a file's timeline it finds each anchor again in the
 * file as it is now: by its exact text, else by its text with whitespace
 * squashed. Found exactly once, it reports the current line. Found nowhere, or
 * in two or more places, the code changed since: a line number is never
 * guessed. A squashed match can only be the line itself, moved or re-indented
 * since: no copy of it existed when it was anchored.
 *
 * The hook bundle (hook-service.cjs, hard size budget) imports this module:
 * keep it to Node built-ins.
 */
import { readFileSync, statSync } from 'fs';
import path from 'path';

/** The observations.metadata key the anchors live under, namespaced like cmem_media_v1. */
export const LINE_ANCHORS_METADATA_KEY = 'cmem_line_anchors_v1';
/** Per observation: enough to point at the places, small enough for every timeline row. */
export const MAX_LINE_ANCHORS_PER_OBSERVATION = 3;
/** Files above this are neither anchored by the worker nor read by the hook. */
export const LINE_ANCHOR_MAX_FILE_BYTES = 2 * 1024 * 1024;
/** A line needs this many letters or digits to count as distinctive (not `}` or `return;`). */
const MIN_DISTINCTIVE_CHARS = 8;
/** Longer lines are not anchored: minified or generated text. */
const MAX_LINE_ANCHOR_CHARS = 400;
/** The lines a Read without a limit is taken to cover, for picking an anchor from its window. */
const DEFAULT_READ_WINDOW_LINES = 50;
/** A cat -n line number, the form a Read result takes in a transcript: `    12→` or `    12<tab>`. */
const READ_LINE_NUMBER_PREFIX = /^\s*\d+(?:→|\t)/;

const EDIT_TOOL_NAMES = new Set(['Edit', 'MultiEdit']);
const READ_TOOL_NAME = 'Read';

export interface LineAnchor {
  /** The path as the tool input spelled it: the form files_read / files_modified store. */
  path: string;
  /** 1-based line when the observation was stored. */
  line: number;
  /** The line's exact text, without its line ending. */
  text: string;
}

/** The fields of a claimed tool call that anchors are taken from. */
export interface LineAnchorMessage {
  type?: string;
  tool_name?: string;
  tool_input?: unknown;
  /** What the worker stored: JSON text, with <private> stripped and secrets redacted. */
  tool_response?: unknown;
  cwd?: string;
}

/** One anchored observation's anchors on the file being read, found again in it. */
export interface LineAnchorStatus {
  /** Current 1-based lines of the anchors found again, ascending. */
  lines: number[];
  /** Anchors on this file that were not found again. */
  missing: number;
}

/**
 * Where an observation's code on the file being read stands, per Read:
 *
 *   found           every anchor on the file was found again
 *   partly-changed  some were, the rest are gone
 *   changed         none was found again
 *
 * Never stored: each lookup computes it afresh, so edits move an observation
 * found -> partly-changed -> changed as its lines go, and back if they return.
 * One writer, lineAnchorStateOf; LINE_ANCHOR_ROW_SUFFIX words it for the
 * file-context hook's timeline rows, and the read-gate eval checks the same words.
 */
export type LineAnchorState = 'found' | 'partly-changed' | 'changed';

export function lineAnchorStateOf(status: LineAnchorStatus): LineAnchorState {
  if (status.lines.length === 0) return 'changed';
  return status.missing > 0 ? 'partly-changed' : 'found';
}

/** How a timeline row ends for each state of its observation's line anchors on the file being read. */
export const LINE_ANCHOR_ROW_SUFFIX: Record<LineAnchorState, (lines: readonly number[]) => string> = {
  found: lines => ` @${lines.map(line => `L${line}`).join(',')}`,
  'partly-changed': lines => ` @${lines.map(line => `L${line}`).join(',')} (some code changed since)`,
  changed: () => ' (code changed since)',
};

/** The context's direction, when a listed row has a line found again. */
export const LINE_ANCHOR_CONTEXT_HINT = '- **Need the code past work touched?** Read with offset and limit around its @L number: where that line is now, found again by its text. (code changed since) means the line is gone; no number is guessed.';
/** The deny reason's direction, when a listed row has a line found again. */
export const LINE_ANCHOR_DENY_HINT = '- Lines of past work: the @L numbers below are where that code is now, found again by its text; call Read with offset and limit around them. (code changed since) means the line is gone.';
/** Over the timeline of a file changed after its newest observation (#1719). */
export const LINE_ANCHOR_CHANGED_FILE_NOTE = 'The file changed after these observations: @L numbers are where their code is now; (code changed since) marks code that is gone.';

/** A file's lines, indexed once by exact text and by whitespace-squashed text. */
export interface FileLineIndex {
  readonly lines: readonly string[];
  /** The lines joined with LF: the content with CRLF endings made LF, built on first use. */
  lfText(): string;
  /** 1-based lines holding exactly `text`. */
  linesWithText(text: string): readonly number[];
  /** 1-based lines equal to `text` once runs of whitespace are squashed and the ends trimmed. */
  linesWithSquashedText(text: string): readonly number[];
}

const squashWhitespace = (line: string): string => line.replace(/\s+/g, ' ').trim();

function addLine(index: Map<string, number[]>, key: string, line: number): void {
  const lines = index.get(key);
  if (lines) lines.push(line);
  else index.set(key, [line]);
}

/** Splits `content` the way anchors count lines (LF or CRLF) and indexes it; the squashed index is built on first use. */
export function indexFileLines(content: string): FileLineIndex {
  const lines = content.split(/\r?\n/);
  const exact = new Map<string, number[]>();
  lines.forEach((line, index) => addLine(exact, line, index + 1));
  let squashed: Map<string, number[]> | null = null;
  let joined: string | null = null;
  return {
    lines,
    lfText: () => (joined ??= lines.join('\n')),
    linesWithText: text => exact.get(text) ?? [],
    linesWithSquashedText: text => {
      if (!squashed) {
        const built = new Map<string, number[]>();
        lines.forEach((line, index) => addLine(built, squashWhitespace(line), index + 1));
        squashed = built;
      }
      return squashed.get(squashWhitespace(text)) ?? [];
    },
  };
}

/**
 * The 1-based line where `anchor` is in the indexed file now: its exact text
 * found exactly once, else its whitespace-squashed text found exactly once.
 * Null otherwise, whether the text is gone or now in two or more places.
 */
export function findLineAnchor(anchor: Pick<LineAnchor, 'text'>, index: FileLineIndex): number | null {
  const exact = index.linesWithText(anchor.text);
  if (exact.length === 1) return exact[0];
  if (!squashWhitespace(anchor.text)) return null;
  const squashed = index.linesWithSquashedText(anchor.text);
  return squashed.length === 1 ? squashed[0] : null;
}

/** A path as anchors compare it: forward slashes, no leading `./`. */
export function normalizeLineAnchorPath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string' || !value.trim().startsWith('{')) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function isDistinctive(line: string): boolean {
  return line.length <= MAX_LINE_ANCHOR_CHARS && (line.match(/[\p{L}\p{N}]/gu)?.length ?? 0) >= MIN_DISTINCTIVE_CHARS;
}

/** A Read offset/limit as a whole number; anything else counts as absent. */
function readWindowValue(value: unknown): number | undefined {
  const numeric = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof numeric === 'number' && Number.isInteger(numeric) && numeric >= 0 ? numeric : undefined;
}

/**
 * The file indexed for anchoring, or null: not a regular file, over
 * LINE_ANCHOR_MAX_FILE_BYTES, holding a NUL byte (binary), or unreadable.
 */
function readAnchorableFile(absolutePath: string): FileLineIndex | null {
  try {
    const stat = statSync(absolutePath);
    if (!stat.isFile() || stat.size > LINE_ANCHOR_MAX_FILE_BYTES) return null;
    const bytes = readFileSync(absolutePath);
    if (bytes.length > LINE_ANCHOR_MAX_FILE_BYTES || bytes.includes(0)) return null;
    return indexFileLines(bytes.toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * The first candidate that is distinctive, occurs exactly once in the file,
 * by its exact text and by its whitespace-squashed text, and passes `accept`
 * (asked last, with that line's number), as an anchor. Unique when squashed
 * too, because the hook's whitespace-ignoring lookup would otherwise land on
 * a copy that was there all along once the line itself is gone.
 */
function firstUniqueLine(
  filePath: string,
  file: FileLineIndex,
  candidates: readonly string[],
  accept: (text: string, line: number) => boolean = () => true,
): LineAnchor | null {
  for (const candidate of candidates) {
    if (!isDistinctive(candidate)) continue;
    const lines = file.linesWithText(candidate);
    if (lines.length !== 1) continue;
    if (file.linesWithSquashedText(candidate).length !== 1) continue;
    if (accept(candidate, lines[0])) return { path: filePath, line: lines[0], text: candidate };
  }
  return null;
}

/** new_string's lines, the ones old_string did not have first: those are what the edit changed. */
function changedLinesFirst(newString: string, oldString: unknown): string[] {
  const lines = newString.split(/\r?\n/);
  const before = new Set(typeof oldString === 'string' ? oldString.split(/\r?\n/) : []);
  return [...lines.filter(line => !before.has(line)), ...lines.filter(line => before.has(line))];
}

/** The 1-based line of the character at `offset` in LF text. */
function lineAtOffset(text: string, offset: number): number {
  let line = 1;
  for (let newline = text.indexOf('\n'); newline !== -1 && newline < offset; newline = text.indexOf('\n', newline + 1)) line += 1;
  return line;
}

/**
 * The first and last 1-based lines an edit's new_string occupies in the file
 * now, or null unless it occurs there exactly once: gone (changed since) or in
 * two or more places (a replace_all, or a fragment that other lines also
 * hold), no line can be told to be one the edit wrote.
 */
function writtenSpan(file: FileLineIndex, written: string): { first: number; last: number } | null {
  const text = written.replace(/\r\n/g, '\n');
  const content = file.lfText();
  const start = content.indexOf(text);
  if (start === -1 || content.indexOf(text, start + 1) !== -1) return null;
  return { first: lineAtOffset(content, start), last: lineAtOffset(content, start + text.length - 1) };
}

/**
 * Every line of every string in a stored tool response (JSON text), each
 * also without a cat -n line number, the form a transcript's Read result
 * carries. Null when the text does not parse: a response that stripping or
 * redaction left as no JSON cannot tell a whole line from part of one.
 */
function storedResponseLines(response: string): Set<string> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(response);
  } catch {
    return null;
  }
  const lines = new Set<string>();
  const pending: unknown[] = [parsed];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === 'string') {
      for (const line of value.split(/\r?\n/)) {
        lines.add(line);
        lines.add(line.replace(READ_LINE_NUMBER_PREFIX, ''));
      }
    } else if (Array.isArray(value)) {
      for (const item of value) pending.push(item);
    } else if (value && typeof value === 'object') {
      for (const item of Object.values(value)) pending.push(item);
    }
  }
  return lines;
}

/**
 * Anchors for a batch's claimed tool calls, read against the files as they
 * are now. The caller passes only calls that succeeded. Edit and MultiEdit
 * anchor at most one line per edit, a line inside the text it wrote (its
 * new_string, found exactly once in the file), preferring the lines it
 * changed. A Read with an offset above 1 anchors at most one line of its
 * window (limit, or 50 lines), and only a line the stored tool response also
 * holds as a whole line, so <private> content, redacted secrets and lines
 * changed after the Read are never recorded. Whole-file Reads, Writes and
 * other tools point at no line and are skipped, and so is a relative path
 * without the call's cwd.
 */
export function deriveLineAnchors(messages: ReadonlyArray<LineAnchorMessage>): LineAnchor[] {
  const anchors: LineAnchor[] = [];
  const seen = new Set<string>();
  const files = new Map<string, FileLineIndex | null>();
  const fileAt = (absolutePath: string): FileLineIndex | null => {
    if (!files.has(absolutePath)) files.set(absolutePath, readAnchorableFile(absolutePath));
    return files.get(absolutePath) ?? null;
  };
  const push = (absolutePath: string, anchor: LineAnchor | null): void => {
    if (!anchor) return;
    const key = `${absolutePath}\0${anchor.line}`;
    if (seen.has(key)) return;
    seen.add(key);
    anchors.push(anchor);
  };

  for (const message of messages) {
    if (message.type !== 'observation' || typeof message.tool_name !== 'string') continue;
    const toolName = message.tool_name;
    if (!EDIT_TOOL_NAMES.has(toolName) && toolName !== READ_TOOL_NAME) continue;
    const input = asObject(message.tool_input);
    const filePath = typeof input?.file_path === 'string' && input.file_path.trim() ? input.file_path : null;
    if (!input || !filePath) continue;
    // A relative path needs the call's own cwd; the worker's says nothing about the session.
    const cwd = typeof message.cwd === 'string' && path.isAbsolute(message.cwd) ? message.cwd : null;
    if (!path.isAbsolute(filePath) && !cwd) continue;
    const absolutePath = cwd ? path.resolve(cwd, filePath) : path.resolve(filePath);

    if (EDIT_TOOL_NAMES.has(toolName)) {
      const edits = toolName === 'MultiEdit' && Array.isArray(input.edits) ? input.edits.map(asObject) : [input];
      for (const edit of edits) {
        const written = edit?.new_string;
        if (typeof written !== 'string' || !written) continue;
        const file = fileAt(absolutePath);
        if (!file) break;
        // A line inside the text this edit wrote, never a copy of one of its lines elsewhere in the file.
        const span = writtenSpan(file, written);
        if (!span) continue;
        push(absolutePath, firstUniqueLine(
          filePath, file, changedLinesFirst(written, edit?.old_string), (_text, line) => line >= span.first && line <= span.last,
        ));
      }
      continue;
    }

    const offset = readWindowValue(input.offset);
    if (offset === undefined || offset <= 1) continue;
    const response = typeof message.tool_response === 'string' ? message.tool_response : '';
    if (!response) continue;
    const file = fileAt(absolutePath);
    if (!file) continue;
    const limit = readWindowValue(input.limit) ?? DEFAULT_READ_WINDOW_LINES;
    const window = file.lines.slice(offset - 1, offset - 1 + limit);
    // Parsed when a candidate first needs it, once per Read.
    let returned: Set<string> | null | undefined;
    push(absolutePath, firstUniqueLine(filePath, file, window, text => {
      if (returned === undefined) returned = storedResponseLines(response);
      return returned?.has(text) ?? false;
    }));
  }
  return anchors;
}

/**
 * The anchors on files this observation names (files_read and
 * files_modified, separators normalized), at most
 * MAX_LINE_ANCHORS_PER_OBSERVATION, taken round-robin so every named file
 * gets one before any file gets a second.
 */
export function lineAnchorsForObservation(
  observation: { files_read?: readonly string[]; files_modified?: readonly string[] },
  anchors: ReadonlyArray<LineAnchor>,
): LineAnchor[] {
  if (anchors.length === 0) return [];
  const named = new Set([...(observation.files_read ?? []), ...(observation.files_modified ?? [])].map(normalizeLineAnchorPath));
  const byFile = new Map<string, LineAnchor[]>();
  for (const anchor of anchors) {
    const file = normalizeLineAnchorPath(anchor.path);
    if (!named.has(file)) continue;
    const queue = byFile.get(file);
    if (queue) queue.push(anchor);
    else byFile.set(file, [anchor]);
  }
  const queues = [...byFile.values()];
  const picked: LineAnchor[] = [];
  for (let round = 0; picked.length < MAX_LINE_ANCHORS_PER_OBSERVATION && queues.some(queue => round < queue.length); round++) {
    for (const queue of queues) {
      if (round < queue.length && picked.length < MAX_LINE_ANCHORS_PER_OBSERVATION) picked.push(queue[round]);
    }
  }
  return picked;
}

/**
 * `metadata` JSON with the anchors set under LINE_ANCHORS_METADATA_KEY, every
 * other key kept. Unchanged when there are no anchors, and when the existing
 * value is not a JSON object: it is never overwritten.
 */
export function withLineAnchors(metadata: string | null | undefined, anchors: ReadonlyArray<LineAnchor>): string | null {
  if (anchors.length === 0) return metadata ?? null;
  const existing = metadata ? asObject(metadata) : {};
  if (!existing) return metadata ?? null;
  return JSON.stringify({
    ...existing,
    [LINE_ANCHORS_METADATA_KEY]: anchors.map(({ path: filePath, line, text }) => ({ path: filePath, line, text })),
  });
}

/** The anchors an observation's metadata holds, at most MAX_LINE_ANCHORS_PER_OBSERVATION; malformed entries are dropped. */
export function readLineAnchors(metadata: string | null | undefined): LineAnchor[] {
  const raw = asObject(metadata ?? null)?.[LINE_ANCHORS_METADATA_KEY];
  if (!Array.isArray(raw)) return [];
  const anchors: LineAnchor[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.path !== 'string' || !record.path.trim()) continue;
    if (typeof record.text !== 'string' || !record.text.trim()) continue;
    if (typeof record.line !== 'number' || !Number.isInteger(record.line) || record.line < 1) continue;
    anchors.push({ path: record.path, line: record.line, text: record.text });
    if (anchors.length === MAX_LINE_ANCHORS_PER_OBSERVATION) break;
  }
  return anchors;
}
