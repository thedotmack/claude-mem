// IO discipline (see src/shared/hook-io.ts): this handler is PURE. It returns a
// HookResult and MUST NOT call process.stderr.write / process.stdout.write /
// console.* / process.exit. logger.* calls are DIAGNOSTIC; thrown errors are
// caught by hookCommand, logged, and answered with a no-op (never exit 2).
import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { executeWithWorkerFallback, isWorkerFallback } from '../../shared/worker-utils.js';
import { logger } from '../../utils/logger.js';
import { parseJsonArray, formatTime, formatDate, formatHeaderDateTime } from '../../shared/timeline-formatting.js';
import { closeSync, openSync, readSync, statSync } from 'fs';
import path from 'path';
import { shouldTrackProject } from '../../shared/should-track-project.js';
import { loadFromFileOnce } from '../../shared/hook-settings.js';
import { getProjectContext } from '../../utils/project-name.js';
import { detectLanguage } from '../../services/smart-file-read/language-map.js';
import { isTreeSitterCliAvailable } from '../../services/smart-file-read/tree-sitter-bin-path.js';
import { resolveWithinWorkspace } from '../../services/smart-file-read/workspace-path.js';
import { claimFileContextInjection } from './file-context-dedupe.js';
import { isQwenCodeHookEvent } from './session-init.js';

/** Below this a file gets neither the timeline nor a deny: reading it costs about what the timeline would. */
const FILE_CONTEXT_MIN_BYTES = 1_500;

/**
 * The File Read Gate denies a whole-file Read only from this size up; smaller
 * files get the timeline as context. A deny costs turns: the denied Read and
 * every smart-tool or targeted Read after it, each re-reading the whole
 * context, against the file it keeps out. evals/read-gate asked one question
 * with the gate on and off: on a 19 KB file it cost -6% on Sonnet and +20% on
 * Opus, on a 49 KB file -35% and -32%.
 */
export const FILE_READ_GATE_DENY_MIN_BYTES = 32 * 1024;

const FETCH_LOOKAHEAD_LIMIT = 40;

const DISPLAY_LIMIT = 15;
const MAX_FILE_CONTEXT_PATHS = 10;

// The PreToolUse Read hook is synchronous so the File Read Gate can deny, which
// makes every Read wait on it. One budget covers the whole worker round trip
// (liveness check + by-file query); a slow or absent worker fails open.
export const FILE_CONTEXT_WORKER_BUDGET_MS = 3_000;

// smart_outline cannot outline these (unknown) or smart-explore itself says to
// Read them (markdown, config), so a full-file Read of them is never denied.
const UNGATED_LANGUAGES = new Set(['unknown', 'markdown', 'yaml', 'toml']);

const TYPE_ICONS: Record<string, string> = {
  decision: '\u2696\uFE0F',
  bugfix: '\uD83D\uDD34',
  feature: '\uD83D\uDFE3',
  refactor: '\uD83D\uDD04',
  discovery: '\uD83D\uDD35',
  change: '\u2705',
};

function compactTime(timeStr: string): string {
  return timeStr.toLowerCase().replace(' am', 'a').replace(' pm', 'p');
}

interface ObservationRow {
  id: number;
  memory_session_id: string;
  title: string | null;
  type: string;
  created_at_epoch: number;
  files_read: string | null;
  files_modified: string | null;
}

function deduplicateObservations(
  observations: ObservationRow[],
  targetPath: string,
  displayLimit: number
): ObservationRow[] {
  const seenSessions = new Set<string>();
  const dedupedBySession: ObservationRow[] = [];
  for (const obs of observations) {
    const sessionKey = obs.memory_session_id ?? `no-session-${obs.id}`;
    if (!seenSessions.has(sessionKey)) {
      seenSessions.add(sessionKey);
      dedupedBySession.push(obs);
    }
  }

  const scored = dedupedBySession.map(obs => {
    const filesRead = parseJsonArray(obs.files_read);
    const filesModified = parseJsonArray(obs.files_modified);
    const totalFiles = filesRead.length + filesModified.length;
    const normalizedTarget = targetPath.replace(/\\/g, '/');
    const inModified = filesModified.some(f => f.replace(/\\/g, '/') === normalizedTarget);

    let specificityScore = 0;
    if (inModified) specificityScore += 2;
    if (totalFiles <= 3) specificityScore += 2;
    else if (totalFiles <= 8) specificityScore += 1;

    return { obs, specificityScore };
  });

  scored.sort((a, b) => b.specificityScore - a.specificityScore);

  return scored.slice(0, displayLimit).map(s => s.obs);
}

interface FileObservationHistory {
  /** The path as the tool input spelled it; the routing hints quote it back. */
  filePath: string;
  /** Canonical absolute path: the dedupe key and the gate's subject. */
  absolutePath: string;
  relativePath: string;
  newestObservationMs: number;
  /** Deduped and ranked down to DISPLAY_LIMIT, then ordered oldest first for display. */
  displayedObservations: ObservationRow[];
  /**
   * The lookup stat'ed the file, so its size and mtime checks ran. False when
   * stat failed with anything but ENOENT: the timeline is still context, but
   * the gate never denies a Read it could not check.
   */
  fileStatVerified: boolean;
  /** The size the lookup stat'ed; 0 when the stat failed. */
  fileSizeBytes: number;
}

/** Escapes a path for the quoted tool-call hints (backslashes, quotes, newlines). */
function escapePathForHint(filePath: string): string {
  return filePath.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/**
 * The day-grouped history both outputs share: `### <day>`, then one
 * `<id> <time> <icon> <title>` line per observation. Expects oldest-first rows.
 */
function formatObservationTimeline(observationsOldestFirst: ObservationRow[]): string[] {
  const lines: string[] = [];
  let currentDay: string | null = null;
  for (const obs of observationsOldestFirst) {
    const day = formatDate(obs.created_at_epoch);
    if (day !== currentDay) {
      lines.push(`### ${day}`);
      currentDay = day;
    }
    const title = (obs.title || 'Untitled').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
    const icon = TYPE_ICONS[obs.type] || '\u2753';
    const time = compactTime(formatTime(obs.created_at_epoch));
    lines.push(`${obs.id} ${time} ${icon} ${title}`);
  }
  return lines;
}

function formatFileContextTimeline(history: FileObservationHistory): string {
  const safePath = escapePathForHint(history.filePath);
  return [
    `Current: ${formatHeaderDateTime()}`,
    `This file has prior observations — supplementary context follows. The Read result below is the full requested section.`,
    `- **Need details on a past observation?** get_observations([IDs]) — ~300 tokens each.`,
    `- **Need a structural map first?** smart_outline("${safePath}") — line numbers only, cheaper than re-reading.`,
    ...formatObservationTimeline(history.displayedObservations),
  ].join('\n');
}

// The `Full-file Read blocked by claude-mem:` line is the read-gate eval's trace
// anchor (evals/read-gate) — keep it verbatim.
function formatFullFileReadDenyReason(history: FileObservationHistory): string {
  const safePath = escapePathForHint(history.filePath);
  const displayedIds = history.displayedObservations.map(obs => obs.id).join(', ');
  return [
    `Current: ${formatHeaderDateTime()}`,
    `Full-file Read blocked by claude-mem: ${safePath} has prior observations (listed below). Get what you need without reading the whole file:`,
    `- Current code: call smart_outline(file_path="${safePath}") for its symbols and line numbers, then smart_unfold(file_path="${safePath}", symbol_name="<name>") for the ones you need (MCP tools mcp__plugin_claude-mem_mcp-search__smart_outline / __smart_unfold; load them with ToolSearch if they are deferred).`,
    `- Past work: call get_observations(ids=[${displayedIds}]) for the observations below that matter (~300 tokens each).`,
    `- Exact lines, e.g. before an Edit: call Read on this file again with offset and limit around the lines smart_outline reported. Partial reads are allowed and satisfy Edit's read requirement.`,
    `The titles below are history from earlier sessions, not the file's current contents.`,
    ...formatObservationTimeline(history.displayedObservations),
  ].join('\n');
}

/** A Read offset/limit as a usable number; anything else counts as absent. */
function readWindowValue(value: unknown): number | undefined {
  const numeric = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof numeric === 'number' && Number.isFinite(numeric) && numeric >= 0 ? numeric : undefined;
}

/** fileHasMoreLinesThan reads this much at a time, so it never holds a whole file. */
export const LINE_COUNT_CHUNK_BYTES = 64 * 1024;

/** Whether an open file has more lines than `lineCount`, read a chunk at a time until the answer is known. */
function openFileHasMoreLinesThan(fileDescriptor: number, lineCount: number): boolean {
  const chunk = Buffer.allocUnsafe(LINE_COUNT_CHUNK_BYTES);
  let newlineCount = 0;
  let endsWithNewline = false;
  for (;;) {
    const bytesRead = readSync(fileDescriptor, chunk, 0, chunk.length, null);
    if (bytesRead === 0) break;
    const bytes = chunk.subarray(0, bytesRead);
    for (let newlineIndex = bytes.indexOf(0x0a); newlineIndex !== -1; newlineIndex = bytes.indexOf(0x0a, newlineIndex + 1)) {
      newlineCount += 1;
      // Every newline ends a line, so the file has at least this many: stop here.
      if (newlineCount > lineCount) return true;
    }
    endsWithNewline = bytes[bytesRead - 1] === 0x0a;
  }
  return (endsWithNewline ? newlineCount : newlineCount + 1) > lineCount;
}

/**
 * Whether the file has more lines than `lineCount`, counting the lines the
 * Read tool would return: one per `\n`, plus a last line without one (so an
 * empty file counts as one line). Reads LINE_COUNT_CHUNK_BYTES at a time and
 * stops as soon as the count passes `lineCount`, so a one-line Read of a huge
 * file reads one chunk. Null when the file cannot be read: no deny then.
 */
export function fileHasMoreLinesThan(absolutePath: string, lineCount: number): boolean | null {
  let fileDescriptor: number | undefined;
  try {
    fileDescriptor = openSync(absolutePath, 'r');
    return openFileHasMoreLinesThan(fileDescriptor, lineCount);
  } catch (err) {
    logger.debug('HOOK', 'Could not count file lines, not gating this Read', {
      absolutePath,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  } finally {
    if (fileDescriptor !== undefined) closeSync(fileDescriptor);
  }
}

/**
 * Whether smart_outline / smart_unfold would accept `filePath` from this cwd:
 * resolveWithinWorkspace is their own containment check, realpath on both
 * sides. A symlink in the project that points outside it is outside, and a cwd
 * that is itself a symlink (macOS /var -> /private/var) still holds its files.
 */
async function fileResolvesInsideWorkspace(filePath: string, workspaceCwd: string): Promise<boolean> {
  try {
    await resolveWithinWorkspace(filePath, workspaceCwd);
    return true;
  } catch (err) {
    logger.debug('HOOK', 'File resolves outside the workspace, where the smart tools refuse it: not gating this Read', {
      filePath,
      workspaceCwd,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * The File Read Gate's conditions that touch no file system, cheapest first:
 * Claude Code main session (not Qwen Code, which runs the same command), gate
 * setting not 'false', a single `file_path` Read of a file smart_outline can
 * outline, with observation history whose lookup stat'ed the file (it enforced
 * size >= FILE_CONTEXT_MIN_BYTES and mtime older than the newest
 * observation), a size of at least FILE_READ_GATE_DENY_MIN_BYTES, a session
 * cwd, and a Read that starts at line 1. Only a Read
 * that meets all of them pays for the workspace check, which resolves symlinks.
 */
function isFullFileReadGateCandidate(
  input: NormalizedHookInput,
  fileHistory: Pick<FileObservationHistory, 'absolutePath' | 'fileStatVerified' | 'fileSizeBytes'>,
  fileReadGateSetting: string | undefined,
): boolean {
  if (input.platform !== 'claude-code') return false;
  // Qwen Code runs the same `hook claude-code …` commands: context, never a deny.
  if (isQwenCodeHookEvent(input.transcriptPath)) return false;
  if (fileReadGateSetting === 'false') return false;
  if (input.agentId) return false;

  const toolInput = input.toolInput;
  if (!toolInput || typeof toolInput !== 'object' || Array.isArray(toolInput)) return false;
  const readInput = toolInput as Record<string, unknown>;
  if (typeof readInput.file_path !== 'string' || Array.isArray(readInput.filePaths)) return false;

  // A failed stat skipped the size and mtime checks; a claude-mem failure must never block a Read.
  if (!fileHistory.fileStatVerified) return false;
  if (fileHistory.fileSizeBytes < FILE_READ_GATE_DENY_MIN_BYTES) return false;
  if (UNGATED_LANGUAGES.has(detectLanguage(fileHistory.absolutePath))) return false;
  if (!input.cwd) return false;
  return (readWindowValue(readInput.offset) ?? 0) <= 1;
}

/**
 * File Read Gate: deny a Read only when ALL hold — it is a gate candidate
 * (isFullFileReadGateCandidate), the file resolves inside the workspace by the
 * rule smart_outline / smart_unfold apply (the deny routes Claude to them, so
 * a path they refuse is never denied), the Read would return the whole file,
 * and the smart tools can parse here.
 * Targeted reads always pass: Edit's read-before-edit rule needs one (#2094).
 * Conditions run cheapest first; `fileHasMoreLinesThan` runs only when the
 * Read sets a limit, and `isSmartReadAvailable` runs last.
 */
export function shouldDenyFullFileRead(
  input: NormalizedHookInput,
  fileHistory: Pick<FileObservationHistory, 'absolutePath' | 'fileStatVerified' | 'fileSizeBytes'> | null,
  fileReadGateSetting: string | undefined,
  fileIsInsideWorkspace: boolean,
  fileHasMoreLinesThan: (absolutePath: string, lineCount: number) => boolean | null,
  isSmartReadAvailable: () => boolean,
): boolean {
  if (!fileHistory || !isFullFileReadGateCandidate(input, fileHistory, fileReadGateSetting)) return false;
  if (!fileIsInsideWorkspace) return false;

  const readLimit = readWindowValue((input.toolInput as Record<string, unknown>).limit);
  // More lines than the limit is a targeted Read; null (unreadable) never denies.
  if (readLimit !== undefined && fileHasMoreLinesThan(fileHistory.absolutePath, readLimit) !== false) return false;

  // An install whose tree-sitter-cli never downloaded its binary answers
  // "Could not parse" to every smart_outline call, so routing Claude there
  // would strand it; the Read goes through with the timeline as context.
  return isSmartReadAvailable();
}

export const fileContextHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    if (input.agentId) {
      logger.debug('HOOK', 'Skipping file context: subagent context detected', {
        sessionId: input.sessionId,
        agentId: input.agentId,
        agentType: input.agentType
      });
      return { continue: true, suppressOutput: true };
    }

    const toolInput = input.toolInput as Record<string, unknown> | undefined;
    const filePaths = Array.isArray(toolInput?.filePaths)
      ? (toolInput.filePaths as unknown[]).filter((p): p is string => typeof p === 'string').slice(0, MAX_FILE_CONTEXT_PATHS)
      : [];
    const filePath = toolInput?.file_path as string | undefined;
    const candidatePaths = filePaths.length > 0 ? filePaths : (filePath ? [filePath] : []);

    if (candidatePaths.length === 0) {
      return { continue: true, suppressOutput: true };
    }

    if (input.cwd && !shouldTrackProject(input.cwd)) {
      logger.debug('HOOK', 'Project excluded from tracking, skipping file context', { cwd: input.cwd });
      return { continue: true, suppressOutput: true };
    }

    const lookupResults = await Promise.allSettled(
      candidatePaths.map(candidatePath => lookupFileObservationHistory(input, candidatePath))
    );
    const histories: FileObservationHistory[] = [];

    lookupResults.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        if (result.value) histories.push(result.value);
        return;
      }
      logger.debug('HOOK', 'File context timeline lookup failed, skipping path', {
        filePath: candidatePaths[index],
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    });

    if (histories.length === 1) {
      const history = histories[0];
      const fileReadGateSetting = loadFromFileOnce().CLAUDE_MEM_FILE_READ_GATE_ENABLED;
      // Resolving symlinks costs syscalls: only a Read every cheaper condition gates pays for it.
      const fileIsInsideWorkspace = isFullFileReadGateCandidate(input, history, fileReadGateSetting)
        && await fileResolvesInsideWorkspace(history.filePath, input.cwd);
      if (shouldDenyFullFileRead(
        input,
        history,
        fileReadGateSetting,
        fileIsInsideWorkspace,
        fileHasMoreLinesThan,
        isTreeSitterCliAvailable,
      )) {
        // Record the claim so a targeted Read that follows this denial does not
        // re-inject the timeline it already carried. The result is ignored on
        // purpose: every whole-file Read of a gated file is denied, so the claim
        // never opens a free retry.
        claimFileContextInjection(input.sessionId, history.absolutePath, history.newestObservationMs);
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            additionalContext: '',
            permissionDecision: 'deny',
            permissionDecisionReason: formatFullFileReadDenyReason(history),
          },
        };
      }
    }

    const timelines: string[] = [];
    for (const history of histories) {
      // #3480 — skip re-injecting the same still-valid timeline for a file already
      // surfaced this session; re-inject only once a newer observation has landed.
      // Claimed last, after every other reason to bail out, so a suppressed
      // injection never burns the claim — and claiming IS recording, so two
      // concurrent Reads of this file cannot both inject.
      if (!claimFileContextInjection(input.sessionId, history.absolutePath, history.newestObservationMs)) {
        logger.debug('HOOK', 'File context already surfaced this session, skipping re-injection', {
          filePath: history.relativePath,
          sessionId: input.sessionId,
          newestObservationMs: history.newestObservationMs,
        });
        continue;
      }
      timelines.push(formatFileContextTimeline(history));
    }

    if (timelines.length === 0) {
      return { continue: true, suppressOutput: true };
    }

    // Context only, no permissionDecision: on a synchronous hook 'allow' would
    // skip the user's permission prompt for this Read.
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: timelines.join('\n\n---\n\n'),
      },
    };
  },
};

async function lookupFileObservationHistory(
  input: NormalizedHookInput,
  filePath: string,
): Promise<FileObservationHistory | null> {
  let fileMtimeMs = 0;
  let fileStatVerified = false;
  let fileSizeBytes = 0;
  try {
    const statPath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(input.cwd || process.cwd(), filePath);
    const stat = statSync(statPath);
    if (!stat.isFile() || stat.size < FILE_CONTEXT_MIN_BYTES) {
      return null;
    }
    fileMtimeMs = stat.mtimeMs;
    fileStatVerified = true;
    fileSizeBytes = stat.size;
  } catch (err) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    logger.debug('HOOK', 'File stat failed: timeline as context only, the gate will not deny this Read', { error: err instanceof Error ? err.message : String(err) });
  }

  const context = getProjectContext(input.cwd);
  const cwd = input.cwd || process.cwd();
  // path.resolve normalizes dot-segments (`a/../b` -> `b`) for BOTH absolute and
  // relative inputs, so `/p/src/../src/f.ts` and `/p/src/f.ts` collapse to one
  // canonical dedupe key instead of two. It ignores `cwd` when `filePath` is
  // already absolute, so absolute inputs are still honored verbatim (minus the
  // redundant `.`/`..` segments).
  const absolutePath = path.resolve(cwd, filePath);
  const relativePath = path.relative(cwd, absolutePath).split(path.sep).join("/");

  // #2691 — PostToolUse stores whatever path form the observer recorded
  // (absolute tool-input path, or project-root-relative per the prompt). The
  // PreToolUse:Read query previously sent ONLY the cwd-relative form, so it
  // never matched absolute-path storage. Send both candidate forms (forward-
  // slashed, de-duped) as repeated `path` params so the key matches across
  // both events regardless of how the path was stored.
  const candidateQueryPaths = Array.from(new Set([
    absolutePath.split(path.sep).join("/"),
    relativePath,
  ].filter(Boolean)));
  const queryParams = new URLSearchParams();
  for (const candidate of candidateQueryPaths) {
    queryParams.append('path', candidate);
  }
  if (context.allProjects.length > 0) {
    queryParams.set('projects', context.allProjects.join(','));
  }
  queryParams.set('limit', String(FETCH_LOOKAHEAD_LIMIT));

  const result = await executeWithWorkerFallback<{ observations: ObservationRow[]; count: number }>(
    `/api/observations/by-file?${queryParams.toString()}`,
    'GET',
    undefined,
    { timeoutMs: FILE_CONTEXT_WORKER_BUDGET_MS },
  );
  if (isWorkerFallback(result)) {
    return null;
  }
  if (!result || !Array.isArray((result as any).observations)) {
    logger.warn('HOOK', 'File context query returned malformed body, skipping', { filePath });
    return null;
  }
  const data = result;

  if (!data.observations || data.observations.length === 0) {
    return null;
  }

  const newestObservationMs = Math.max(...data.observations.map(o => o.created_at_epoch));

  if (fileMtimeMs > 0 && fileMtimeMs >= newestObservationMs) {
    logger.debug('HOOK', 'File modified since last observation, skipping context injection', {
      filePath: relativePath,
      fileMtimeMs,
      newestObservationMs,
    });
    return null;
  }

  // Never empty: the `observations.length === 0` guard above already returned,
  // and deduplicateObservations only ever drops same-session duplicates and
  // truncates to DISPLAY_LIMIT, so at least one row always survives.
  const displayedObservations = deduplicateObservations(data.observations, relativePath, DISPLAY_LIMIT)
    .sort((a, b) => a.created_at_epoch - b.created_at_epoch);

  return { filePath, absolutePath, relativePath, newestObservationMs, displayedObservations, fileStatVerified, fileSizeBytes };
}
