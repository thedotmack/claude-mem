import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { emptyDeepResult, type DeepSearchResult } from '../sqlite/tool-use-search.js';
import type { SearchOptions } from '../sqlite/types.js';
import { getDeepSearchProgram } from './child-program.js';
import { deepSearchRuntimeSupported } from './runtime-support.js';
import { sanitizeEnv } from '../../supervisor/env-sanitizer.js';
import { DEEP_SEARCH_DEADLINE_MS, MAX_REPLY_BYTES, MAX_REQUEST_BYTES, type DeepSearchExecutor } from './protocol.js';

type Job = {
  finish(result: DeepSearchResult): void;
  done: boolean;
  child?: ChildProcessWithoutNullStreams;
  exited: Promise<void>;
  release(): void;
  start(program: string): void;
};
type Dependencies = {
  deadlineMs?: number;
  program?: () => Promise<string>;
  spawn?: typeof spawn;
  runtimeSupported?: () => boolean;
  now?: () => number;
};

/** One disposable, read-only process per query. No queue and no inline fallback.
 * The slot includes startup and remains held until the OS confirms process exit. */
export class DeepSearchClient implements DeepSearchExecutor {
  private active?: Job;
  private closed = false;
  private nextId = 0;
  private program: string | undefined;
  private preparing = false;
  constructor(private dbPath: string, private dependencies: Dependencies = {}) {}

  search(query: string, options: SearchOptions = {}): Promise<DeepSearchResult> {
    if (this.closed) return Promise.resolve(emptyDeepResult('cancelled'));
    if (this.active) return Promise.resolve(emptyDeepResult('busy'));
    if (!(this.dependencies.runtimeSupported ?? deepSearchRuntimeSupported)()) return Promise.resolve(emptyDeepResult('unsupported'));
    const budget = this.dependencies.deadlineMs ?? DEEP_SEARCH_DEADLINE_MS;
    const deadline = Date.now() + budget;
    const now = this.dependencies.now ?? (() => performance.now());
    const expires = now() + budget;
    const id = ++this.nextId;
    let release!: () => void;
    const exited = new Promise<void>(resolve => { release = resolve; });
    let settle!: (result: DeepSearchResult) => void;
    const response = new Promise<DeepSearchResult>(resolve => { settle = resolve; });
    const job: Job = { done: false, exited, release: () => {
      if (this.active === job) this.active = undefined;
      release();
    }, start: program => launch(program), finish: result => {
      if (job.done) return;
      job.done = true;
      clearTimeout(timer);
      settle(result);
    } };
    this.active = job;
    const timer = setTimeout(() => this.stop(job, 'timeout'), Math.max(1, expires - now()));
    const cleanup = job.release;
    const launch = (program: string) => {
      try {
        if (job.done || now() >= expires) {
          this.stop(job, 'timeout'); cleanup(); return;
        }
        const input = JSON.stringify({ version: 1, id, parentPid: process.pid, deadline,
          dbPath: this.dbPath, query, options: {
            project: options.project, projects: options.projects, platformSource: options.platformSource,
            dateRange: options.dateRange, orderBy: options.orderBy, limit: options.limit,
          } });
        if (Buffer.byteLength(input) > MAX_REQUEST_BYTES) {
          job.finish(emptyDeepResult('invalid_query')); cleanup(); return;
        }
        const child = (this.dependencies.spawn ?? spawn)(process.execPath, ['-e', program], {
          env: sanitizeEnv({ ...process.env, BUN_BE_BUN: '1' }), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
        }) as ChildProcessWithoutNullStreams;
        job.child = child;
        const chunks: Buffer[] = [];
        let bytes = 0;
        child.stdout.on('data', (chunk: Buffer) => {
          if (job.done) return;
          bytes += chunk.length;
          if (bytes > MAX_REPLY_BYTES) this.stop(job, 'error');
          else chunks.push(chunk);
        });
        // Drain without retaining or logging potentially sensitive child output.
        child.stderr.resume();
        child.stdin.on('error', () => this.stop(job, 'error'));
        child.once('error', () => {
          this.stop(job, 'error');
          // Failed spawn has no process to reap. A running child retains its slot.
          if (!child.pid) cleanup();
        });
        child.once('close', (code, signal) => {
          if (!job.done) {
            try {
              const reply = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              const result = reply.result as DeepSearchResult;
              if (code !== 0 || signal || reply.version !== 1 || reply.id !== id || !validResult(result)) throw new Error('Invalid reply');
              job.finish(now() >= expires ? emptyDeepResult('timeout') : result);
            } catch { job.finish(emptyDeepResult(now() >= expires ? 'timeout' : 'error')); }
          }
          cleanup();
        });
        child.stdin.end(input);
      } catch { this.stop(job, 'error'); if (!job.child) cleanup(); }
    };
    this.prepare();
    return response;
  }

  close(): Promise<void> {
    this.closed = true;
    if (!this.active) return Promise.resolve();
    const job = this.active;
    this.stop(job, 'cancelled');
    return job.exited;
  }

  // One preparation and one continuation, regardless of how many requests time
  // out. A cancelled request leaves no subscriber on a possibly hung build.
  // When preparation completes, only the currently admitted request may start.
  private prepare(): void {
    if (this.program !== undefined) { this.active?.start(this.program); return; }
    if (this.preparing) return;
    this.preparing = true;
    void Promise.resolve().then(() => (this.dependencies.program ?? getDeepSearchProgram)()).then(program => {
      this.preparing = false;
      this.program = program;
      this.active?.start(program);
    }, () => {
      this.preparing = false;
      if (this.active) this.stop(this.active, 'error');
    });
  }

  private stop(job: Job, status: 'timeout' | 'error' | 'cancelled'): void {
    job.finish(emptyDeepResult(status));
    if (!job.child) { job.release(); return; }
    if (job.child && job.child.exitCode === null && job.child.signalCode === null) {
      // A failed kill must not crash the host or free a still-live process's
      // slot. The child's independent guard remains the last cleanup defense.
      try { job.child.kill('SIGKILL'); } catch { /* retain until confirmed exit */ }
    }
  }
}

function validResult(value: DeepSearchResult): boolean {
  if (!value || !value.deep || !Array.isArray(value.toolUses) || value.toolUses.length > 10) return false;
  const { deep } = value;
  if (deep.status !== 'ok') return ['building', 'disabled', 'not_ready', 'unsupported', 'error', 'not_applicable', 'invalid_query', 'timeout'].includes(deep.status)
    && deep.complete === false && deep.count === null && deep.hasMore === null && value.toolUses.length === 0;
  return deep.complete === true && deep.count === value.toolUses.length && typeof deep.hasMore === 'boolean'
    && value.toolUses.every(row => Number.isSafeInteger(row.id) && Number.isFinite(row.created_at_epoch)
      && ['tool_use_id', 'tool_name', 'project', 'content_session_id', 'platform_source', 'snippet'].every(key => typeof (row as any)[key] === 'string'));
}
