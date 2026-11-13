/**
 * owner-runs.json: the state of every run the owner started from My Work (owner-runs.mjs). The worker is its one
 * writer; every write is a whole-file read, change and atomic replace on the worker's main thread. It records what
 * happened. It is not a queue: nothing reads it to start, retry or resume a run.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { writeJsonFileAtomic } from '../../shared/atomic-json.js';
import { isOwnerRunInFlight, OWNER_RUNS_FILE, type AnswerRun, type FocusPlan, type OwnerRunsFile, type StageRecord } from './owner-runs.mjs';

const MAX_TOKENS = 500;
const MAX_ANSWERS = 200;
const INTERRUPTED = 'The worker stopped before this finished. Nothing was retried.';

const empty = (): OwnerRunsFile => ({ version: 1, tokens: [], answers: {}, stages: {}, plan: null });

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function readOwnerRuns(dir: string): OwnerRunsFile {
  let stored: Partial<OwnerRunsFile> | null = null;
  try { stored = JSON.parse(readFileSync(join(dir, OWNER_RUNS_FILE), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return { ...empty(), ...(stored && typeof stored === 'object' ? stored : {}) };
}

export class OwnerRunStore {
  constructor(private readonly dir: string, private readonly now: () => number = Date.now) {}

  read(): OwnerRunsFile { return readOwnerRuns(this.dir); }

  /** One synchronous read, edit and replace. An edit that answers false leaves the file as it was. */
  private change(edit: (file: OwnerRunsFile) => void | false): void {
    const file = this.read();
    if (edit(file) === false) return;
    writeJsonFileAtomic(join(this.dir, OWNER_RUNS_FILE), file, { mode: 0o600 });
  }

  iso(): string { return new Date(this.now()).toISOString(); }

  hasToken(token: string): boolean { return this.read().tokens.includes(token); }

  /** Starts a record and remembers its click, in one write, so a repeat of the click finds the token. */
  private begin(token: string | null, edit: (file: OwnerRunsFile) => void | false): void {
    this.change(file => {
      if (edit(file) === false) return false;
      if (token) file.tokens = [...file.tokens.filter(known => known !== token), token].slice(-MAX_TOKENS);
    });
  }

  beginAnswer(requestId: string, token: string, platform: string): void {
    this.begin(token, file => {
      file.answers[requestId] = { state: 'answering', token, platform, startedAt: this.iso(), finishedAt: null, error: null, pid: process.pid };
      // Only the newest answers are kept: an old one says nothing the request's own conversation does not.
      const newest = Object.entries(file.answers).sort(([, a], [, b]) => b.startedAt.localeCompare(a.startedAt)).slice(0, MAX_ANSWERS);
      file.answers = Object.fromEntries(newest);
    });
  }

  finishAnswer(requestId: string, token: string, error: string | null): void {
    this.change(file => {
      const run = file.answers[requestId];
      if (run?.token !== token) return;
      file.answers[requestId] = { ...run, state: error === null ? 'delivered' : 'failed', finishedAt: this.iso(), error };
    });
  }

  /**
   * Claims the one run of a stage: the in-flight check and the `generating` record are one synchronous write, so of
   * two callers exactly one gets a start time. Null while a run of this stage is in flight; nothing is written then.
   */
  beginStage(groupId: string, formatId: string, token: string | null, start: Pick<StageRecord, 'reviewedThrough' | 'trigger'>): string | null {
    let startedAt: string | null = null;
    this.begin(token, file => {
      if (isOwnerRunInFlight(file.stages[groupId]?.[formatId]?.state)) return false;
      startedAt = this.iso();
      file.stages[groupId] = { ...file.stages[groupId], [formatId]: { state: 'generating', file: null, url: null, startedAt, generatedAt: null, error: null, pid: process.pid, ...start } };
    });
    return startedAt;
  }

  /** True while the run that began at `startedAt` is still the stage's run in flight. */
  holdsStage(groupId: string, formatId: string, startedAt: string): boolean {
    const stage = this.read().stages[groupId]?.[formatId];
    return stage?.startedAt === startedAt && stage.state === 'generating';
  }

  /** Ends the stage run that began at `startedAt`; a later run of the same stage is left alone. */
  finishStage(groupId: string, formatId: string, startedAt: string, result: { file: string; url: string | null } | { error: string }): void {
    this.change(file => {
      const stage = file.stages[groupId]?.[formatId];
      if (stage?.startedAt !== startedAt || stage.state !== 'generating') return false;
      file.stages[groupId][formatId] = 'error' in result
        ? { ...stage, state: 'failed', error: result.error }
        : { ...stage, state: 'ready', file: result.file, url: result.url, generatedAt: this.iso(), error: null };
    });
  }

  beginPlan(token: string, focusAreaId: string | null): void {
    this.begin(token, file => { file.plan = { state: 'planning', focusAreaId, token, startedAt: this.iso(), generatedAt: null, proposals: [], skipped: [], error: null, pid: process.pid }; });
  }

  finishPlan(token: string, result: Pick<FocusPlan, 'proposals' | 'skipped'> | { error: string }): void {
    this.change(file => {
      if (file.plan?.token !== token || file.plan.state !== 'planning') return;
      file.plan = 'error' in result
        ? { ...file.plan, state: 'failed', error: result.error }
        : { ...file.plan, state: 'ready', generatedAt: this.iso(), proposals: result.proposals, skipped: result.skipped, error: null };
    });
  }

  /**
   * At worker start no run of this process exists, so a record still in flight whose worker is gone was cut off by a
   * restart. It is marked failed and left there: the owner may click again, and nothing starts it for them.
   */
  repairInterrupted(): void {
    const cutOff = (record: { state: string; pid: number }) => isOwnerRunInFlight(record.state as AnswerRun['state']) && (record.pid === process.pid || !processIsAlive(record.pid));
    const file = this.read();
    const answers = Object.values(file.answers).filter(cutOff);
    const stages = Object.values(file.stages).flatMap(formats => Object.values(formats)).filter(cutOff);
    if (!answers.length && !stages.length && !(file.plan && cutOff(file.plan))) return;
    this.change(current => {
      for (const [id, run] of Object.entries(current.answers)) if (cutOff(run)) current.answers[id] = { ...run, state: 'failed', finishedAt: this.iso(), error: INTERRUPTED };
      for (const formats of Object.values(current.stages)) for (const [id, stage] of Object.entries(formats)) if (cutOff(stage)) formats[id] = { ...stage, state: 'failed', error: INTERRUPTED };
      if (current.plan && cutOff(current.plan)) current.plan = { ...current.plan, state: 'failed', error: INTERRUPTED };
    });
  }
}
