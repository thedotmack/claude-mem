// IO discipline (see src/shared/hook-io.ts): runs inside the Stop and
// SubagentStop handlers, so it is PURE toward stdout/stderr: logger.* only,
// never process.stdout.write / console.* / process.exit. Errors are caught by
// the caller and never fail the hook.
import { execFileSync } from 'child_process';
import { realpathSync, statSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'path';
import { spoolHookEvent } from './spool-hook-event.js';
import { logger } from '../utils/logger.js';
import { loadFromFileOnce } from '../shared/hook-settings.js';
import { normalizePlatformSource } from '../shared/platform-source.js';
import { copyDeliverableIntoBucket } from '../shared/deliverables.js';
import { extractTranscriptFileActivity, type TranscriptWorkStateWrite } from '../shared/deliverables-transcript.js';
import { DELIVERABLE_ERRORS_PER_EVENT, type SpooledDeliverable, type SpooledDeliverablesPayload } from '../shared/hook-spool.js';
import { usesRemoteHookSpool } from '../shared/hook-spool-remote.js';
import { getWorkerHost } from '../shared/worker-utils.js';
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
 *
 * Nothing is copied for a turn whose prompt was entirely <private>, the rule
 * the worker applies to observations and summaries, nor for a worker on
 * another host, which could not open a copy made on this disk. A file is
 * copied only from the checkout or the system temp folders (deliverableRoots):
 * a work-state field can name any path without a permission prompt, so a path
 * elsewhere is left out and logged.
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

/**
 * Where a deliverable may be copied from: the checkout the agent works in and
 * the system temp folders, where the host's scratchpad lives. The same
 * containment as claude-mem's own file tools (resolveWithinWorkspace, #3861),
 * realpath on both sides, so a symlink in the checkout that points outside it
 * is outside. A work_state_write can name any path without a permission
 * prompt; without this, `work_product: ~/.ssh/id_rsa` would land a copy of the
 * key in the bucket. A root that does not exist admits nothing.
 */
export function deliverableRoots(cwd: string): string[] {
  const roots = new Set<string>();
  for (const root of [cwd, tmpdir(), '/tmp']) {
    try { roots.add(realpathSync(root)); } catch { /* not on this machine */ }
  }
  return [...roots];
}

function isWithinRoots(realPath: string, roots: string[]): boolean {
  return roots.some(root => realPath === root || realPath.startsWith(root + sep));
}

/**
 * A field value as an existing regular file inside one of `roots`: absolute,
 * `~/…`, or relative to the checkout; URLs and plain words are not files. The
 * path is returned as the agent wrote it (the recorded sourcePath), the check
 * is made on what it resolves to.
 */
export function resolveCandidatePath(value: unknown, cwd: string, roots: string[] = deliverableRoots(cwd)): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || text.includes('\0') || /^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return null;
  const expanded = text.startsWith('~/') ? join(homedir(), text.slice(2)) : text;
  const path = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
  let real: string;
  try {
    real = realpathSync(path);
    if (!statSync(real).isFile()) return null;
  } catch {
    return null;
  }
  if (!isWithinRoots(real, roots)) {
    logger.warn('HOOK', 'A deliverable path is outside the checkout and the temp folders; not copied', { path, resolvesTo: real, roots });
    return null;
  }
  return path;
}

function parseJson(value: string): unknown {
  try { return JSON.parse(value); } catch { return null; }
}

/** The files one work-state write attached. */
export function declaredCandidates(write: TranscriptWorkStateWrite, cwd: string, roots: string[] = deliverableRoots(cwd)): Candidate[] {
  const candidates: Candidate[] = [];
  const base = { declared: true, list: write.list, toolUseId: write.toolUseId, occurredAtEpoch: write.occurredAtEpoch };
  for (const [field, value] of Object.entries(write.fields)) {
    if (isWorkProductField(field)) {
      // Several products arrive as one JSON string (WorkStateRenderer's rule); the agent may also pass a bare path.
      const decoded = typeof value === 'string' && /^\s*[[{]/.test(value) ? parseJson(value) ?? value : value;
      for (const entry of Array.isArray(decoded) ? decoded : [decoded]) {
        const record: Record<string, unknown> = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry as Record<string, unknown> : { url: entry };
        const path = resolveCandidatePath(record.path ?? record.url ?? record.link, cwd, roots);
        if (!path) continue;
        // Attached on purpose: any file counts, whatever its extension.
        candidates.push({ ...base, path, title: shortText(record.title ?? record.name) ?? basename(path), kind: shortText(record.kind) ?? deliverableKind(path), field });
      }
      continue;
    }
    const path = resolveCandidatePath(value, cwd, roots);
    if (path && fileKind(path)) candidates.push({ ...base, path, title: basename(path), kind: deliverableKind(path), field });
  }
  return candidates;
}

export interface GitResult {
  /** The exit status; null when git did not run (not installed) or did not finish (killed at GIT_TIMEOUT_MS). */
  status: number | null;
  stdout: string;
  stderr: string;
}
export type GitRunner = (args: string[], cwd: string) => GitResult;

const runGit: GitRunner = (args, cwd) => {
  try {
    const stdout = execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: GIT_TIMEOUT_MS });
    return { status: 0, stdout, stderr: '' };
  } catch (error: unknown) {
    const failure = error && typeof error === 'object' ? error as { status?: unknown; stderr?: unknown } : {};
    return {
      status: typeof failure.status === 'number' ? failure.status : null,
      stdout: '',
      stderr: typeof failure.stderr === 'string' ? failure.stderr : '',
    };
  }
};

/** Where git places the folder a written file is in: a repository, confirmed outside every repository, or unknown when git could not answer. */
export type RepositoryLookup =
  | { kind: 'repository'; root: string }
  | { kind: 'none' }
  | { kind: 'unknown'; detail: string };

/** Git's one answer that means no repository holds the folder; every other failure (git missing, hung, or refusing a repository it finds dubious) leaves the question open. */
const NOT_A_REPOSITORY = /not a git repository/i;

function lookupRepository(dir: string, git: GitRunner): RepositoryLookup {
  try {
    statSync(dir);
  } catch (error: unknown) {
    return { kind: 'unknown', detail: `the folder cannot be read: ${error instanceof Error ? error.message : String(error)}` };
  }
  const result = git(['rev-parse', '--show-toplevel'], dir);
  const root = result.stdout.trim();
  if (result.status === 0 && root) return { kind: 'repository', root };
  if (result.status === 128 && NOT_A_REPOSITORY.test(result.stderr)) return { kind: 'none' };
  const firstLine = result.stderr.trim().split('\n')[0];
  return {
    kind: 'unknown',
    detail: result.status === null ? 'git did not run or did not finish' : `git exited ${result.status}${firstLine ? `: ${firstLine}` : ''}`,
  };
}

/**
 * A written file is outside the source tree when no repository holds it or
 * the repository ignores it. In a repository and not ignored means source,
 * whether tracked yet or not. When git cannot say — it is missing, hung, or
 * refuses to open the repository — the file is treated as source, so a
 * failed check never copies anything.
 */
export function isOutsideSourceTree(path: string, repositoryCache: Map<string, RepositoryLookup> = new Map(), git: GitRunner = runGit): boolean {
  const dir = dirname(path);
  let lookup = repositoryCache.get(dir);
  if (!lookup) {
    lookup = lookupRepository(dir, git);
    repositoryCache.set(dir, lookup);
    if (lookup.kind === 'unknown') {
      logger.warn('HOOK', 'git could not say whether a folder is in a repository; files written there are left out of the deliverables bucket', { dir, detail: lookup.detail });
    }
  }
  if (lookup.kind === 'none') return true;
  if (lookup.kind === 'unknown') return false;
  const ignored = git(['check-ignore', '-q', '--', path], lookup.root);
  if (ignored.status === 0) return true;
  if (ignored.status === 1) return false;
  logger.warn('HOOK', 'git check-ignore could not tell whether a written file is source; leaving it out of the deliverables bucket', { path, status: ignored.status });
  return false;
}

/**
 * The error list kept to DELIVERABLE_ERRORS_PER_EVENT entries, the last one a
 * count of those cut, so a turn with more failures than that never costs the
 * records of the files that did copy. The hook log names every file.
 */
export function boundedErrors(errors: Array<{ sourcePath: string; error: string }>): Array<{ sourcePath: string; error: string }> {
  if (errors.length <= DELIVERABLE_ERRORS_PER_EVENT) return errors;
  const kept = errors.slice(0, DELIVERABLE_ERRORS_PER_EVENT - 1);
  return [...kept, { sourcePath: '', error: `${errors.length - kept.length} more files were not copied; the hook log names each one` }];
}

export interface CaptureDeliverablesOptions {
  /**
   * SubagentStop: the finished subagent's own transcript, scanned whole and
   * with its sidechain entries (every entry in it is one) for what the
   * subagent made. The session's transcript still decides the turn's privacy.
   */
  subagentTranscriptPath?: string;
}

/**
 * Copies this turn's deliverables into the project bucket and spools one
 * `deliverables` event for the worker. Returns how many files were copied,
 * reused or failed; nothing when capture is off, when there is no transcript,
 * when the turn is private, when the worker is on another host, or when the
 * turn made nothing for a person.
 */
export function captureDeliverables(input: NormalizedHookInput, options: CaptureDeliverablesOptions = {}): { copied: number; reused: number; failed: number } | null {
  const { sessionId, cwd, transcriptPath } = input;
  if (!sessionId || !cwd || !(options.subagentTranscriptPath ?? transcriptPath)) return null;
  if (!isDeliverablesCaptureEnabled(process.env.CLAUDE_MEM_DELIVERABLES_ENABLED ?? loadFromFileOnce().CLAUDE_MEM_DELIVERABLES_ENABLED)) return null;
  // Server runtime has no local worker to record the copies; the bucket is a worker-runtime feature.
  if (resolveRuntimeContext().runtime === 'server') return null;
  // A worker on another host could not open a copy made on this disk, and My Work would hide its record: the bucket is for a worker that shares the disk.
  const workerHost = getWorkerHost();
  if (usesRemoteHookSpool(workerHost)) {
    logger.debug('HOOK', 'Deliverables are not captured for a worker on another host', { workerHost });
    return null;
  }

  // The prompt that started the session's current turn decides its privacy, for a subagent's files too: they belong to
  // that turn. A prompt that cannot be read (no session transcript, none in it) decides nothing, and nothing is copied.
  const turn = transcriptPath ? extractTranscriptFileActivity(transcriptPath, { currentTurnOnly: true }) : null;
  if (!turn?.promptSeen) {
    logger.debug('HOOK', 'Deliverables are not captured when the turn\'s prompt cannot be read', { sessionId, transcriptPath: transcriptPath ?? null });
    return null;
  }
  if (turn.privateTurn) {
    logger.debug('HOOK', 'Deliverables are not captured for a private turn', { sessionId });
    return null;
  }
  const activity = options.subagentTranscriptPath
    ? extractTranscriptFileActivity(options.subagentTranscriptPath, { currentTurnOnly: false, includeSidechain: true })
    : turn;
  if (!activity || (activity.writes.length === 0 && activity.workStateWrites.length === 0)) return null;

  // Declared first: an agent's title and kind win over what a write infers.
  const roots = deliverableRoots(cwd);
  const candidates = new Map<string, Candidate>();
  for (const write of activity.workStateWrites) {
    for (const candidate of declaredCandidates(write, cwd, roots)) if (!candidates.has(candidate.path)) candidates.set(candidate.path, candidate);
  }
  const repositoryCache = new Map<string, RepositoryLookup>();
  for (const write of activity.writes) {
    const path = resolveCandidatePath(write.path, cwd, roots);
    if (!path || candidates.has(path) || !fileKind(path) || !isOutsideSourceTree(path, repositoryCache)) continue;
    candidates.set(path, { path, title: basename(path), kind: deliverableKind(path), declared: false, list: null, field: null, toolUseId: write.toolUseId, occurredAtEpoch: write.occurredAtEpoch });
  }
  if (candidates.size === 0) return null;

  const project = getProjectContext(cwd).primary;
  const ordered = [...candidates.values()];
  const files: SpooledDeliverable[] = [];
  const errors: Array<{ sourcePath: string; error: string }> = [];
  let reused = 0;
  if (ordered.length > DELIVERABLES_PER_STOP) {
    const leftOut = ordered.slice(DELIVERABLES_PER_STOP);
    logger.warn('HOOK', `Deliverables: this turn made ${ordered.length} files; only the first ${DELIVERABLES_PER_STOP} are copied in one Stop`, { project, leftOut: leftOut.map(candidate => candidate.path) });
    for (const candidate of leftOut) errors.push({ sourcePath: candidate.path, error: `over the ${DELIVERABLES_PER_STOP}-file limit for one Stop` });
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
    ...(errors.length ? { errors: boundedErrors(errors) } : {}),
  };
  spoolHookEvent('deliverables', payload);
  logger.info('HOOK', 'Deliverables copied into the project bucket', { project, files: files.length, reused, failed: errors.length });
  return { copied: files.length - reused, reused, failed: errors.length };
}
