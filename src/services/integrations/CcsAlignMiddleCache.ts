import { accessSync, constants, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import path from 'path';
import { homedir } from 'os';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH, DATA_DIR } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';

// CCS Align — Phase 0 breathing slice + Phase 1 exclude marks.
//
// Phase 0 (merged as #3934): a deliberate copy of the #3931 atomic append
// primitive with three — and only three — changes locked by the plan of record
// (`plans/2026-09-09-ccs-align.md`, D1/D2/§0.1):
//   1. Tag is `[ccs-align]`, NOT a second `[awareness]` writer.
//   2. Path root is seat-owned `~/.claude-mem/ccs-align/<viewerId>/`, never
//      `agents/<id>/memory/log/`.
//   3. File is `middle.jsonl` (one JSON record per line).
//
// Phase 1 (§1.1–1.4): exclude marks filter the *compiled* middle cache — the
// diary / SQLite stay authoritative. A mark records observation ids and
// tool-use ids; the grab→append→replace pipeline drops marked records so they
// never appear in the compiled file. Unmarking + rebuild restores them from
// the diary on the next pull. `DELETE /api/observation/:id` is FORBIDDEN.
//
// It does NOT delete history, does NOT write `profile.md`, and does NOT add a
// sixth `processAgentResponse` consumer. It is a seat-owned middle cache the
// hourly CCS Align seat lands observations into via grab -> append -> replace.

const MAX_LINE_CHARS = 500;
const CCS_ALIGN_TAG = '[ccs-align]';
const CCS_ALIGN_DIRNAME = 'ccs-align';
const MIDDLE_CACHE_FILENAME = 'middle.jsonl';
const CURSOR_FILENAME = 'cursor.json';
const EXCLUDE_MARKS_FILENAME = 'exclude-marks.json';
const RECORD_VERSION = 1;
const EXCLUDE_MARKS_VERSION = 1;

/**
 * The subset of an observation the middle cache lands. `id`/`created_at`/
 * `project`/`agent_id` come from the worker's full observation row
 * (`get_observations` / `POST /api/observations/batch`); the text fields mirror
 * `ParsedObservation`.
 */
export interface CcsAlignObservationInput {
  id: number;
  type: string;
  title?: string | null;
  subtitle?: string | null;
  facts?: string[];
  created_at?: string | null;
  project?: string | null;
  agent_id?: string | null;
  source?: string;
}

/** One line of `middle.jsonl`. Shape is LOCKED for Phase 0 — do not add fields. */
export interface CcsAlignMiddleRecord {
  v: number;
  id: number;
  type: string;
  title: string | null;
  created_at: string | null;
  project: string | null;
  agent_id: string | null;
  source: string;
  line: string;
}

/** Contents of `cursor.json`. Prevents re-pulling the whole diary every hour. */
export interface CcsAlignCursor {
  lastRunAt: string;
  lastObservationId: number | null;
  healthPath: string;
  workerPort: number | null;
}

// --- Phase 1: Exclude marks ---

export type ExcludeMarkReason = 'sibling-wall' | 'manual' | 'stripper' | 'secure-isolation';

export interface ExcludeMark {
  observationId: number;
  toolUseIds: (string | number)[];
  reason: ExcludeMarkReason;
  markedAt: string;
  markedBy: string;
}

export interface ExcludeMarksFile {
  v: number;
  marks: ExcludeMark[];
}

export interface CcsAlignConfig {
  enabled: boolean;
  viewerIds: string[];
  triggerTypes: string[];
  triggerConcepts: string[];
  dataRoot: string;
}

function splitCsv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0);
}

export function loadCcsAlignConfig(
  settingsPath: string = USER_SETTINGS_PATH,
  env: NodeJS.ProcessEnv = process.env,
): CcsAlignConfig {
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  const dataRoot = env.CLAUDE_MEM_DATA_DIR
    ? env.CLAUDE_MEM_DATA_DIR
    : (settings.CLAUDE_MEM_DATA_DIR || path.join(homedir(), '.claude-mem'));
  return {
    enabled: settings.CLAUDE_MEM_CCS_ALIGN_ENABLED === 'true',
    viewerIds: splitCsv(settings.CLAUDE_MEM_CCS_ALIGN_VIEWER_IDS),
    triggerTypes: splitCsv(settings.CLAUDE_MEM_CCS_ALIGN_TRIGGER_TYPES),
    triggerConcepts: [],
    dataRoot,
  };
}

/**
 * Needle match — copied from `observationMatchesAwarenessNeedle` (#3931). An
 * empty filter set never matches (fail closed).
 */
export function observationMatchesCcsAlignNeedle(
  obs: { type: string; concepts?: string[] },
  triggerTypes: string[],
  triggerConcepts: string[] = [],
): boolean {
  if (triggerTypes.length === 0 && triggerConcepts.length === 0) {
    return false;
  }
  const matchesType = triggerTypes.includes(obs.type);
  const matchesConcept = (obs.concepts ?? []).some(concept => triggerConcepts.includes(concept));
  return matchesType || matchesConcept;
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * `- YYYY-MM-DD [ccs-align] <type> — <title>: <subtitle>. <fact>`, truncated to
 * 500 chars. Copied verbatim from `formatAwarenessLine` (#3931) with the tag
 * swapped.
 */
export function formatCcsAlignLine(obs: CcsAlignObservationInput, now: Date = new Date()): string {
  const date = now.toISOString().slice(0, 10);
  const title = collapseWhitespace(obs.title ?? '');
  const subtitle = collapseWhitespace(obs.subtitle ?? '');
  const fact = collapseWhitespace((obs.facts ?? [])[0] ?? '');
  const headline = [title, subtitle].filter(Boolean).join(': ');
  const detail = [headline, fact].filter(Boolean).join('. ');
  const body = collapseWhitespace(`${obs.type}${detail ? ` — ${detail}` : ''}`);
  const line = `- ${date} ${CCS_ALIGN_TAG} ${body}`.trimEnd();
  if (line.length <= MAX_LINE_CHARS) return line;
  return `${line.slice(0, MAX_LINE_CHARS - 1)}…`;
}

/**
 * Dedupe key: the line from `[ccs-align]` onward (date excluded), so the same
 * fact on a new day is still skipped. Scope is one file. Copied from
 * `awarenessLineBody` (#3931).
 */
export function ccsAlignLineBody(line: string): string {
  const idx = line.indexOf(CCS_ALIGN_TAG);
  return idx >= 0 ? line.slice(idx).trim() : line.trim();
}

export function ccsAlignViewerDir(dataRoot: string, viewerId: string): string {
  return path.join(dataRoot, CCS_ALIGN_DIRNAME, viewerId);
}

export function ccsAlignMiddleCachePath(dataRoot: string, viewerId: string): string {
  return path.join(ccsAlignViewerDir(dataRoot, viewerId), MIDDLE_CACHE_FILENAME);
}

export function ccsAlignCursorPath(dataRoot: string, viewerId: string): string {
  return path.join(ccsAlignViewerDir(dataRoot, viewerId), CURSOR_FILENAME);
}

export function ccsAlignExcludeMarksPath(dataRoot: string, viewerId: string): string {
  return path.join(ccsAlignViewerDir(dataRoot, viewerId), EXCLUDE_MARKS_FILENAME);
}

/** Read the exclude-marks file for a viewer. Returns empty marks if missing or corrupt. */
export function readExcludeMarks(marksPath: string): ExcludeMarksFile {
  const empty: ExcludeMarksFile = { v: EXCLUDE_MARKS_VERSION, marks: [] };
  if (!existsSync(marksPath)) return empty;
  try {
    const parsed = JSON.parse(readFileSync(marksPath, 'utf8')) as ExcludeMarksFile;
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.marks)) {
      return { v: parsed.v ?? EXCLUDE_MARKS_VERSION, marks: parsed.marks };
    }
  } catch { /* corrupt file — treat as empty */ }
  return empty;
}

/** Write the exclude-marks file atomically (temp + rename). */
export function writeExcludeMarks(marksPath: string, data: ExcludeMarksFile): void {
  const dir = path.dirname(marksPath);
  mkdirSync(dir, { recursive: true });
  const tmpPath = `${marksPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    renameSync(tmpPath, marksPath);
  } catch (error) {
    try { unlinkSync(tmpPath); } catch { /* ignore cleanup */ }
    throw error;
  }
}

/** Add an exclude mark for an observation (and its tool-use ids). Idempotent per observationId. */
export function addExcludeMark(
  marksPath: string,
  observationId: number,
  toolUseIds: (string | number)[] = [],
  reason: ExcludeMarkReason = 'manual',
  markedBy: string = 'ccs-align',
  now: Date = new Date(),
): ExcludeMarksFile {
  const data = readExcludeMarks(marksPath);
  if (data.marks.some(m => m.observationId === observationId)) {
    return data;
  }
  data.marks.push({
    observationId,
    toolUseIds,
    reason,
    markedAt: now.toISOString(),
    markedBy,
  });
  writeExcludeMarks(marksPath, data);
  return data;
}

/** Remove an exclude mark by observationId. Returns the updated file (unchanged if not found). */
export function removeExcludeMark(marksPath: string, observationId: number): ExcludeMarksFile {
  const data = readExcludeMarks(marksPath);
  const before = data.marks.length;
  data.marks = data.marks.filter(m => m.observationId !== observationId);
  if (data.marks.length < before) {
    writeExcludeMarks(marksPath, data);
  }
  return data;
}

/**
 * Build the set of observation ids and tool-use ids that are excluded for a
 * given viewer. Used by the grab→append→replace pipeline to filter the
 * compiled middle cache.
 */
export function buildExcludeSet(marks: ExcludeMark[]): {
  excludedObsIds: Set<number>;
  excludedToolUseIds: Set<string | number>;
} {
  const excludedObsIds = new Set<number>();
  const excludedToolUseIds = new Set<string | number>();
  for (const mark of marks) {
    excludedObsIds.add(mark.observationId);
    for (const tid of mark.toolUseIds) {
      excludedToolUseIds.add(tid);
    }
  }
  return { excludedObsIds, excludedToolUseIds };
}

/**
 * Refuse any write that escapes the seat-owned CCS Align root, targets
 * `profile.md`, or lands inside an `agents/.../memory/log` tree (that is the
 * #3931 pusher's seam, never Align's). Shape copied from
 * `assertSafeAwarenessLogPath` (#3931).
 */
export function assertSafeMiddleCachePath(dataRoot: string, viewerId: string, filePath: string): void {
  const expectedRoot = path.resolve(ccsAlignViewerDir(dataRoot, viewerId));
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(expectedRoot + path.sep) && resolved !== expectedRoot) {
    throw new Error('Refusing CCS Align write outside the seat-owned ccs-align root');
  }
  if (path.basename(resolved) === 'profile.md') {
    throw new Error('Refusing CCS Align write to profile.md');
  }
  if (/(^|[\\/])agents[\\/].*[\\/]memory[\\/]log([\\/]|$)/.test(resolved)) {
    throw new Error('Refusing CCS Align write into agents/**/memory/log (that seam belongs to #3931)');
  }
}

export function buildCcsAlignRecord(obs: CcsAlignObservationInput, now: Date = new Date()): CcsAlignMiddleRecord {
  return {
    v: RECORD_VERSION,
    id: obs.id,
    type: obs.type,
    title: obs.title ?? null,
    created_at: obs.created_at ?? null,
    project: obs.project ?? null,
    agent_id: obs.agent_id ?? null,
    source: obs.source ?? 'worker',
    line: formatCcsAlignLine(obs, now),
  };
}

function parseRecordLine(rawLine: string): CcsAlignMiddleRecord | null {
  const trimmed = rawLine.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as CcsAlignMiddleRecord;
    if (parsed && typeof parsed === 'object' && typeof parsed.line === 'string') {
      return parsed;
    }
  } catch {
    // Not a valid record line — ignore for dedupe purposes.
  }
  return null;
}

/** Read and parse the existing middle cache (empty array if it does not exist). */
export function readMiddleCache(cachePath: string): CcsAlignMiddleRecord[] {
  if (!existsSync(cachePath)) return [];
  const raw = readFileSync(cachePath, 'utf8');
  const records: CcsAlignMiddleRecord[] = [];
  for (const rawLine of raw.split('\n')) {
    const record = parseRecordLine(rawLine);
    if (record) records.push(record);
  }
  return records;
}

/**
 * Grab -> append -> filter exclude marks -> replace, atomically.
 *
 * grab:    read `middle.jsonl` if it exists, else empty.
 * filter:  drop any existing record whose `id` is in `excludedObsIds`.
 * append:  keep only records whose observation id AND body are not already
 *          present (body key excludes the date, matching #3931). Also skip
 *          records whose id is in `excludedObsIds`.
 * replace: write a temp file + `renameSync` (never `appendFileSync`).
 *
 * Returns the records actually appended. A no-op that also removes no
 * excluded records returns `[]` and does not rewrite the file.
 */
export function appendMiddleCacheRecordsAtomic(
  cachePath: string,
  records: CcsAlignMiddleRecord[],
  excludedObsIds: Set<number> = new Set(),
): { appended: CcsAlignMiddleRecord[]; dropped: number } {
  const dir = path.dirname(cachePath);
  mkdirSync(dir, { recursive: true });

  const existingRaw = existsSync(cachePath) ? readFileSync(cachePath, 'utf8') : '';
  const seenIds = new Set<number>();
  const seenBodies = new Set<string>();

  const survivingLines: string[] = [];
  let dropped = 0;
  for (const rawLine of existingRaw.split('\n')) {
    const record = parseRecordLine(rawLine);
    if (!record) continue;
    if (excludedObsIds.has(record.id)) {
      dropped++;
      continue;
    }
    seenIds.add(record.id);
    seenBodies.add(ccsAlignLineBody(record.line));
    survivingLines.push(rawLine.trim());
  }

  const toAppend: CcsAlignMiddleRecord[] = [];
  for (const record of records) {
    if (excludedObsIds.has(record.id)) continue;
    const body = ccsAlignLineBody(record.line);
    if (seenIds.has(record.id) || seenBodies.has(body)) continue;
    seenIds.add(record.id);
    seenBodies.add(body);
    toAppend.push(record);
  }

  if (toAppend.length === 0 && dropped === 0) {
    return { appended: [], dropped: 0 };
  }

  const appendedLines = toAppend.map(record => JSON.stringify(record));
  const allLines = [...survivingLines, ...appendedLines];
  const next = allLines.length > 0 ? `${allLines.join('\n')}\n` : '';
  const tmpPath = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmpPath, next, 'utf8');
    renameSync(tmpPath, cachePath);
  } catch (error) {
    try { unlinkSync(tmpPath); } catch { /* ignore cleanup */ }
    throw error;
  }
  return { appended: toAppend, dropped };
}

export function readCursor(cursorPath: string): CcsAlignCursor | null {
  if (!existsSync(cursorPath)) return null;
  try {
    return JSON.parse(readFileSync(cursorPath, 'utf8')) as CcsAlignCursor;
  } catch {
    return null;
  }
}

/** Write `cursor.json` atomically (temp + rename), same primitive as the cache. */
export function writeCursor(cursorPath: string, cursor: CcsAlignCursor): void {
  const dir = path.dirname(cursorPath);
  mkdirSync(dir, { recursive: true });
  const tmpPath = `${cursorPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmpPath, `${JSON.stringify(cursor, null, 2)}\n`, 'utf8');
    renameSync(tmpPath, cursorPath);
  } catch (error) {
    try { unlinkSync(tmpPath); } catch { /* ignore cleanup */ }
    throw error;
  }
}

/**
 * D2 fallback probe. There is NO compiled laminate in-repo, so this helper
 * exists only so the seat can honor an OPTIONAL original-cache path if a later
 * PASS names one: if that path is missing or not writable, the seat appends to
 * the middle cache only (which it does anyway) and never invents a laminate.
 */
export function isOriginalCacheWritable(originalCachePath: string | null | undefined): boolean {
  if (!originalCachePath) return false;
  try {
    if (existsSync(originalCachePath)) {
      accessSync(originalCachePath, constants.W_OK);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export interface LandObservationsInput {
  viewerId: string;
  observations: CcsAlignObservationInput[];
  dataRoot?: string;
  now?: Date;
  /** OPTIONAL. Only honored if writable; never created. See {@link isOriginalCacheWritable}. */
  originalCachePath?: string | null;
}

export interface LandObservationsResult {
  appended: CcsAlignMiddleRecord[];
  dropped: number;
  cachePath: string;
}

/**
 * Land needle observations into the seat's middle cache. Never throws into the
 * caller — a broken write path is logged and swallowed, matching the #3931
 * pusher's never-throw contract.
 *
 * Phase 1: loads the viewer's exclude-marks file and passes the excluded
 * observation ids into the atomic pipeline so marked records are filtered from
 * the compiled output. The diary / SQLite stay authoritative — this is a
 * compile-time omit, not a delete.
 */
export function landObservationsInMiddleCache(input: LandObservationsInput): LandObservationsResult {
  const dataRoot = input.dataRoot ?? DATA_DIR;
  const now = input.now ?? new Date();
  const cachePath = ccsAlignMiddleCachePath(dataRoot, input.viewerId);
  try {
    assertSafeMiddleCachePath(dataRoot, input.viewerId, cachePath);

    if (input.originalCachePath && !isOriginalCacheWritable(input.originalCachePath)) {
      logger.debug('AWARENESS', 'CCS Align original cache missing or not writable; append-only to seat file', {
        viewerId: input.viewerId,
        originalCachePath: input.originalCachePath,
      });
    }

    const marksPath = ccsAlignExcludeMarksPath(dataRoot, input.viewerId);
    const marksFile = readExcludeMarks(marksPath);
    const { excludedObsIds } = buildExcludeSet(marksFile.marks);

    const records = input.observations.map(obs => buildCcsAlignRecord(obs, now));
    const { appended, dropped } = appendMiddleCacheRecordsAtomic(cachePath, records, excludedObsIds);
    if (appended.length > 0 || dropped > 0) {
      logger.debug('AWARENESS', 'CCS Align landed observations in middle cache', {
        viewerId: input.viewerId,
        appended: appended.length,
        dropped,
      });
    }
    return { appended, dropped, cachePath };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.warn('AWARENESS', 'CCS Align middle-cache write skipped', {
      viewerId: input.viewerId,
    }, err);
    return { appended: [], dropped: 0, cachePath };
  }
}

/**
 * Rebuild the middle cache from scratch: clear the file, re-land the given
 * observations, and apply current exclude marks. This is the unmark+rebuild
 * path — after removing a mark, the caller re-pulls the diary through the
 * three-layer ladder and rebuilds the compiled file.
 */
export function rebuildMiddleCache(input: LandObservationsInput): LandObservationsResult {
  const dataRoot = input.dataRoot ?? DATA_DIR;
  const cachePath = ccsAlignMiddleCachePath(dataRoot, input.viewerId);
  try {
    if (existsSync(cachePath)) {
      unlinkSync(cachePath);
    }
  } catch { /* if it can't be removed, landObservationsInMiddleCache will handle it */ }
  return landObservationsInMiddleCache(input);
}
