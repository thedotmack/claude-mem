// IO discipline (see src/shared/hook-io.ts): runs inside the Stop and
// SubagentStop handlers, so it is PURE toward stdout/stderr: logger.* only,
// never process.stdout.write / console.* / process.exit. Errors are caught by
// the caller and never fail the hook.
import { execFileSync } from 'child_process';
import { statSync } from 'fs';
import { homedir } from 'os';
import { basename, dirname, isAbsolute, join, resolve } from 'path';
import { spoolHookEvent } from './spool-hook-event.js';
import { logger } from '../utils/logger.js';
import { loadFromFileOnce } from '../shared/hook-settings.js';
import { normalizePlatformSource } from '../shared/platform-source.js';
import { copyDeliverableIntoBucket } from '../shared/deliverables.js';
import { extractTranscriptFileActivity, type TranscriptWorkStateWrite } from '../shared/deliverables-transcript.js';
import type { SpooledDeliverable, SpooledDeliverablesPayload } from '../shared/hook-spool.js';
import { resolveRuntimeContext } from '../services/hooks/runtime-selector.js';
import { getProjectContext } from '../utils/project-name.js';
import { fileKind, isWorkProductField } from '../services/work-view/work-product.mjs';
import type { NormalizedHookInput } from './types.js';

/**
 * Deliverables capture: at Stop, copy what the turn made for a person into
 * the project's bucket (~/.claude-mem/deliverables/<project>/) and tell the
 * worker, which records each copy and links it on the request's card in My
 * Work. Two sources, read from the transcript so no worker call is needed:
 *
 *  - declared: a work_state_write this turn attached a local file — through
 *    `work_product` / `deliverable(s)` (any file, the agent said it is one),
 *    or any other field whose value is a path to a file a person opens
 *    (`output_pdf=/…/slides.pdf`).
 *  - inferred: a Write / Edit this turn made a file a person opens
 *    (work-product.mjs FILE_KINDS: decks, documents, pages, images, video,
 *    spreadsheets) outside the project's source tree — in a git-ignored
 *    folder such as .scratch/, or outside any repository such as a scratchpad.
 *    A source file is never copied by inference; an agent attaches it if it
 *    is a deliverable.
 */

/** Each copy runs synchronously inside the Stop hook (120 s host timeout); 50 keeps the worst turn well inside it. Files past the cap are reported, not dropped silently. */
export const DELIVERABLES_PER_STOP = 50;
/** git answers rev-parse and check-ignore in milliseconds; 5 s bounds a hung git (a stale index lock) so the hook still exits. */
const GIT_TIMEOUT_MS = 5_000;
/** A title from a work-state field, cut like work-product.mjs cuts titles. */
const MAX_TITLE = 140;

export function isDeliverablesCaptureEnabled(value: string | undefined): boolean {
  return String(value ?? '').trim().toLowerCase() !== 'false';
}

/** The kind My Work shows: work-product.mjs's kind for files a person opens, document for text and markdown, otherwise file. */
export function deliverableKind(path: string): string {
  return fileKind(path) ?? (/\.(?:md|markdown|txt|rst)$/i.test(path) ? 'document' : 'file');
}

interface Candidate {
  path: string;
  title: string;
  kind: string;
  declared: boolean;
  list: string | null;
  field: string | null;
  toolUseId: string | null;
  occurredAtEpoch: number;
}

const shortText = (value: unknown): string | null => {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  if (!text) return null;
  return text.length > MAX_TITLE ? `${text.slice(0, MAX_TITLE - 1).trimEnd()}…` : text;
};

/** A field value as an existing regular file: absolute, `~/…`, or relative to the checkout. URLs and plain words are not files. */
export function resolveCandidatePath(value: unknown, cwd: string): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || text.includes('\0') || /^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return null;
  const expanded = text.startsWith('~/') ? join(homedir(), text.slice(2)) : text;
  const path = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
  try {
    return statSync(path).isFile() ? path : null;
  } catch {
    return null;
  }
}

function parseJson(value: string): unknown {
  try { return JSON.parse(value); } catch { return null; }
}

/** The files one work-state write attached. */
export function declaredCandidates(write: TranscriptWorkStateWrite, cwd: string): Candidate[] {
  const candidates: Candidate[] = [];
  const base = { declared: true, list: write.list, toolUseId: write.toolUseId, occurredAtEpoch: write.occurredAtEpoch };
  for (const [field, value] of Object.entries(write.fields)) {
    if (isWorkProductField(field)) {
      // Several products arrive as one JSON string (WorkStateRenderer's rule); the agent may also pass a bare path.
      const decoded = typeof value === 'string' && /^\s*[[{]/.test(value) ? parseJson(value) ?? value : value;
      for (const entry of Array.isArray(decoded) ? decoded : [decoded]) {
        const record: Record<string, unknown> = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry as Record<string, unknown> : { url: entry };
        const path = resolveCandidatePath(record.path ?? record.url ?? record.link, cwd);
        if (!path) continue;
        // Attached on purpose: any file counts, whatever its extension.
        candidates.push({ ...base, path, title: shortText(record.title ?? record.name) ?? basename(path), kind: shortText(record.kind) ?? deliverableKind(path), field });
      }
      continue;
    }
    const path = resolveCandidatePath(value, cwd);
    if (path && fileKind(path)) candidates.push({ ...base, path, title: basename(path), kind: deliverableKind(path), field });
  }
  return candidates;
}

function git(args: string[], cwd: string): { status: number | null; stdout: string } {
  try {
    const stdout = execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: GIT_TIMEOUT_MS });
    return { status: 0, stdout };
  } catch (error: unknown) {
    const status = error && typeof error === 'object' && typeof (error as { status?: unknown }).status === 'number' ? (error as { status: number }).status : null;
    return { status, stdout: '' };
  }
}

/**
 * A written file is outside the source tree when no repository holds it or
 * the repository ignores it. In a repository and not ignored means source,
 * whether tracked yet or not; when git cannot say, the file is treated as
 * source so nothing is copied by accident.
 */
export function isOutsideSourceTree(path: string, repoRootCache: Map<string, string | null> = new Map()): boolean {
  const dir = dirname(path);
  let root = repoRootCache.get(dir);
  if (root === undefined) {
    try {
      statSync(dir);
      const result = git(['rev-parse', '--show-toplevel'], dir);
      root = result.status === 0 ? result.stdout.trim() || null : null;
    } catch {
      root = null;
    }
    repoRootCache.set(dir, root);
  }
  if (!root) return true;
  const ignored = git(['check-ignore', '-q', '--', path], root);
  if (ignored.status === 0) return true;
  if (ignored.status === 1) return false;
  logger.warn('HOOK', 'git check-ignore could not tell whether a written file is source; leaving it out of the deliverables bucket', { path, status: ignored.status });
  return false;
}

export interface CaptureDeliverablesOptions {
  /** The transcript to read; the session's by default, the subagent's for SubagentStop. */
  transcriptPath?: string;
  /** Only the final turn (Stop runs once per turn). A subagent's transcript is one run, so SubagentStop scans all of it. */
  currentTurnOnly?: boolean;
}

/**
 * Copies this turn's deliverables into the project bucket and spools one
 * `deliverables` event for the worker. Returns how many files were copied,
 * reused or failed; nothing when capture is off, when there is no transcript,
 * or when the turn made nothing for a person.
 */
export function captureDeliverables(input: NormalizedHookInput, options: CaptureDeliverablesOptions = {}): { copied: number; reused: number; failed: number } | null {
  const transcriptPath = options.transcriptPath ?? input.transcriptPath;
  const { sessionId, cwd } = input;
  if (!transcriptPath || !sessionId || !cwd) return null;
  if (!isDeliverablesCaptureEnabled(process.env.CLAUDE_MEM_DELIVERABLES_ENABLED ?? loadFromFileOnce().CLAUDE_MEM_DELIVERABLES_ENABLED)) return null;
  // Server runtime has no local worker to record the copies; the bucket is a worker-runtime feature.
  if (resolveRuntimeContext().runtime === 'server') return null;

  const activity = extractTranscriptFileActivity(transcriptPath, { currentTurnOnly: options.currentTurnOnly ?? true });
  if (activity.writes.length === 0 && activity.workStateWrites.length === 0) return null;

  // Declared first: an agent's title and kind win over what a write infers.
  const candidates = new Map<string, Candidate>();
  for (const write of activity.workStateWrites) {
    for (const candidate of declaredCandidates(write, cwd)) if (!candidates.has(candidate.path)) candidates.set(candidate.path, candidate);
  }
  const repoRootCache = new Map<string, string | null>();
  for (const write of activity.writes) {
    const path = resolveCandidatePath(write.path, cwd);
    if (!path || candidates.has(path) || !fileKind(path) || !isOutsideSourceTree(path, repoRootCache)) continue;
    candidates.set(path, { path, title: basename(path), kind: deliverableKind(path), declared: false, list: null, field: null, toolUseId: write.toolUseId, occurredAtEpoch: write.occurredAtEpoch });
  }
  if (candidates.size === 0) return null;

  const project = getProjectContext(cwd).primary;
  const ordered = [...candidates.values()];
  const files: SpooledDeliverable[] = [];
  const errors: Array<{ sourcePath: string; error: string }> = [];
  let reused = 0;
  if (ordered.length > DELIVERABLES_PER_STOP) {
    logger.warn('HOOK', `Deliverables: this turn made ${ordered.length} files; only the first ${DELIVERABLES_PER_STOP} are copied in one Stop`, { project });
    for (const candidate of ordered.slice(DELIVERABLES_PER_STOP)) errors.push({ sourcePath: candidate.path, error: `over the ${DELIVERABLES_PER_STOP}-file limit for one Stop` });
  }
  for (const candidate of ordered.slice(0, DELIVERABLES_PER_STOP)) {
    try {
      const copy = copyDeliverableIntoBucket(candidate.path, project);
      if (copy.reused) reused++;
      files.push({
        sourcePath: candidate.path, bucketPath: copy.bucketPath, title: candidate.title, kind: candidate.kind,
        bytes: copy.bytes, sha256: copy.sha256, declared: candidate.declared, list: candidate.list, field: candidate.field,
        toolUseId: candidate.toolUseId, occurredAtEpoch: candidate.occurredAtEpoch,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ sourcePath: candidate.path, error: message });
      logger.warn('HOOK', 'Deliverable could not be copied into the project bucket', { path: candidate.path, project, error: message });
    }
  }
  if (files.length === 0) return { copied: 0, reused, failed: errors.length };

  const payload: SpooledDeliverablesPayload = {
    contentSessionId: sessionId,
    platformSource: normalizePlatformSource(input.platform),
    cwd,
    project,
    ...(input.agentId ? { agentId: input.agentId } : {}),
    files,
    ...(errors.length ? { errors } : {}),
  };
  spoolHookEvent('deliverables', payload);
  logger.info('HOOK', 'Deliverables copied into the project bucket', { project, files: files.length, reused, failed: errors.length });
  return { copied: files.length - reused, reused, failed: errors.length };
}
