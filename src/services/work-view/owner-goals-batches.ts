/**
 * Progress for one initial owner-goals mapping. Only checked answers advance processed source keys.
 * This is not a queue of failed inference: the normal refresh scans the source again, skips completed
 * evidence, and stays on the agent chosen for that run. A ready save contains no remaining model work.
 */
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { OwnerPromptSection } from '../prompt-import/owner-prompts-file.js';

/** #5969 measured roughly flat quote misses through 177k input tokens, rising at 289k/444k.
 * 640 KiB is about 164k tokens at a nominal four UTF-8 bytes/token: a conservative byte
 * heuristic from that observation, not a provider limit or a tokenizer guarantee. Use this
 * same complete-question budget to decide whether an initial map needs batches at all.
 * Instructions, focus areas, cumulative goals and any refused answer all count. */
export const OWNER_GOALS_QUESTION_BYTES = 640 * 1024;
/** Reserve 128 KiB of that measured-input heuristic for the ~12 KB skill and growing draft,
 * instead of resending them for every 32 KiB of source. The actual remaining question space
 * can shrink this batch further; no source section is truncated or skipped to make it fit. */
export const OWNER_GOALS_BATCH_BYTES = 512 * 1024;
export const ownerGoalsCheckpointPath = (ledgerDir: string): string => join(ledgerDir, 'owner-goals', 'mapping-checkpoint.json');

export interface OwnerGoalsCheckpoint {
  version: 1;
  deviceId: string;
  baseGeneratedAt: string | null;
  exportedAt: string;
  processed: string[];
  goals: Record<string, unknown> | null;
  maps: string[];
  /** Fresh-answer quote drops, committed with the checked answer and its source positions. */
  droppedUnverifiedQuotes: string[];
  /** Once ready, the checked payload/key are immutable; saving still checks the current source export. */
  save: { key: string } | null;
}

export function batchFailure(message: string): Error {
  return Object.assign(new Error(message), { retryable: false, answerRefused: true });
}

export function readOwnerGoalsCheckpoint(path: string): OwnerGoalsCheckpoint | null {
  if (!existsSync(path)) return null;
  let value: any;
  try { value = JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw batchFailure('Cannot read the checked owner-goals progress at ' + path + '. It has not been replaced.'); }
  const object = (candidate: unknown) => candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate);
  if (!object(value) || value.version !== 1 || typeof value.deviceId !== 'string'
    || !(value.baseGeneratedAt === null || typeof value.baseGeneratedAt === 'string')
    || typeof value.exportedAt !== 'string' || !Number.isFinite(Date.parse(value.exportedAt))
    || !Array.isArray(value.processed) || !value.processed.every((key: unknown) => typeof key === 'string' && /^[a-f0-9]{64}$/.test(key))
    || !Array.isArray(value.maps) || !value.maps.every((map: unknown) => typeof map === 'string')
    || !(value.droppedUnverifiedQuotes === undefined || (Array.isArray(value.droppedUnverifiedQuotes)
      && value.droppedUnverifiedQuotes.every((quote: unknown) => typeof quote === 'string')))
    || !(value.goals === null || object(value.goals))
    || !(value.save === null || (object(value.save) && typeof value.save.key === 'string'
      && /^[a-f0-9]{24}:[a-f0-9]{64}$/.test(value.save.key) && object(value.goals)))) {
    throw batchFailure('Invalid checked owner-goals progress at ' + path + '. It has not been replaced.');
  }
  // Version 1 checkpoints written before quote-drop reporting remain recoverable.
  return { ...value, droppedUnverifiedQuotes: value.droppedUnverifiedQuotes ?? [] } as OwnerGoalsCheckpoint;
}

export function writeOwnerGoalsCheckpoint(path: string, progress: OwnerGoalsCheckpoint): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = path + '.' + randomBytes(6).toString('hex') + '.tmp';
  try {
    const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(progress)); fsyncSync(fd); }
    finally { closeSync(fd); }
    renameSync(temporary, path);
  } catch (error) {
    throw batchFailure('Could not retain the checked owner-goals answer at ' + path + ': ' + String(error));
  } finally {
    try { rmSync(temporary, { force: true }); } catch { /* Preserve the original checkpoint-write failure. */ }
  }
}

export function renderOwnerGoalsBatch(sections: OwnerPromptSection[]): string {
  return '# Owner prompts in this batch\n\n' + sections.length + ' prompts, oldest first.\n\n'
    + sections.map(section => section.markdown).join('\n---\n\n');
}

/** No minute boundary or count cap: each source turn is covered, including equal text and equal times. */
export function nextOwnerGoalsBatch(sections: OwnerPromptSection[], processed: Set<string>, maximumBytes: number): OwnerPromptSection[] {
  const batch: OwnerPromptSection[] = [];
  let contentsBytes = 0;
  for (const section of sections) {
    if (processed.has(section.key)) continue;
    const nextBytes = contentsBytes + (batch.length ? Buffer.byteLength('\n---\n\n') : 0)
      + Buffer.byteLength(section.markdown, 'utf8');
    const headerBytes = Buffer.byteLength('# Owner prompts in this batch\n\n' + (batch.length + 1) + ' prompts, oldest first.\n\n');
    if (headerBytes + nextBytes > maximumBytes) {
      if (!batch.length) throw batchFailure('The checked owner-goals state and one prompt exceed the question budget. Progress is retained; no prompt was skipped.');
      break;
    }
    batch.push(section);
    contentsBytes = nextBytes;
  }
  return batch;
}

/** Only a previously checked draft uses this carried-quote boundary. Fresh answers instead use
 * save_goals.py's fresh-save cleanup and report their dropped unverified quotes. The next civil
 * minute covers edits within the same minute without treating a new answer as carried. */
export function checkedGoalsQuoteBoundary(goals: Record<string, unknown>): string | null {
  const times = ['focus_areas', 'asks', 'rules'].flatMap(key => (Array.isArray(goals[key]) ? goals[key] as any[] : [])
    .flatMap(item => (Array.isArray(item.evidence) ? item.evidence : []).map((quote: any) => String(quote.at ?? '').slice(0, 16))))
    .filter(value => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(value)).sort();
  const latest = times.at(-1);
  if (!latest) return null;
  const after = Date.parse(latest.replace(' ', 'T') + ':00Z') + 60_000;
  return Number.isFinite(after) ? new Date(after).toISOString().slice(0, 16).replace('T', ' ') : null;
}
