/**
 * Progress for one initial owner-goals mapping. Only checked answers advance processed source keys.
 * This is not a queue of failed inference: the normal refresh scans the source again, skips completed
 * evidence, and stays on the agent chosen for that run. A ready save contains no remaining model work.
 */
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { OwnerPromptSection } from '../prompt-import/owner-prompts-file.js';

export const OWNER_GOALS_BATCH_BYTES = 32 * 1024;
/** Includes instructions, focus areas, cumulative goals, this batch, and a refused answer on retry. */
export const OWNER_GOALS_QUESTION_BYTES = 96 * 1024;
export const ownerGoalsCheckpointPath = (ledgerDir: string): string => join(ledgerDir, 'owner-goals', 'mapping-checkpoint.json');

export interface OwnerGoalsCheckpoint {
  version: 1;
  deviceId: string;
  baseGeneratedAt: string | null;
  exportedAt: string;
  processed: string[];
  goals: Record<string, unknown> | null;
  maps: string[];
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
    || !(value.goals === null || object(value.goals))
    || !(value.save === null || (object(value.save) && typeof value.save.key === 'string'
      && /^[a-f0-9]{24}:[a-f0-9]{64}$/.test(value.save.key) && object(value.goals)))) {
    throw batchFailure('Invalid checked owner-goals progress at ' + path + '. It has not been replaced.');
  }
  return value as OwnerGoalsCheckpoint;
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
  for (const section of sections) {
    if (processed.has(section.key)) continue;
    if (Buffer.byteLength(renderOwnerGoalsBatch([...batch, section]), 'utf8') > maximumBytes) {
      if (!batch.length) throw batchFailure('The checked owner-goals state and one prompt exceed the question budget. Progress is retained; no prompt was skipped.');
      break;
    }
    batch.push(section);
  }
  return batch;
}

/** Only a previously checked draft uses this boundary; new model answers always get strict validation.
 * The next civil minute also covers edits within the same minute, without treating a new answer as carried. */
export function checkedGoalsQuoteBoundary(goals: Record<string, unknown>): string | null {
  const times = ['focus_areas', 'asks', 'rules'].flatMap(key => (Array.isArray(goals[key]) ? goals[key] as any[] : [])
    .flatMap(item => (Array.isArray(item.evidence) ? item.evidence : []).map((quote: any) => String(quote.at ?? '').slice(0, 16))))
    .filter(value => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(value)).sort();
  const latest = times.at(-1);
  if (!latest) return null;
  const after = Date.parse(latest.replace(' ', 'T') + ':00Z') + 60_000;
  return Number.isFinite(after) ? new Date(after).toISOString().slice(0, 16).replace('T', ' ') : null;
}
