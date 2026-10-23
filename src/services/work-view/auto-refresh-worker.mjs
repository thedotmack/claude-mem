// Keeps My Work current without anyone running a skill: every ten minutes it
// asks refreshNeeds() whether anything is due (ungrouped conversations, due
// reviews, stale goals, unaligned groups) and, if so, runs one agent job.
// Owner rule (Oct 22): AI magic, not speed. No minimum interval, no day
// window, no group cap, and a run is never stopped for taking long; it ends
// when the agent finishes or fails. One run at a time.
// Status lives in refresh.json beside the ledger; My Work shows it live.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { refreshNeeds, writeJsonAtomic } from './request-groups.mjs';

const TEN_MINUTES_MS = 10 * 60000;

const processIsAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

export class AutoRefreshWorker {
  /**
   * @param {object} options
   * @param {string} options.dir                ledger folder (~/.claude-mem/work-view)
   * @param {() => any} options.openDatabase    read-only claude-mem.db handle with close()
   * @param {(job: {needs: object, reason: string}) => Promise<{state: string, agent: string|null, result: string|null, error: string|null}>} options.runJob
   * @param {() => Promise<boolean>} [options.hasUsableAgent]  is a logged-in agent installed? (agent-runner/detect.ts)
   * @param {() => boolean} [options.enabled]   CLAUDE_MEM_WORK_VIEW_AUTO_REFRESH, read on every check
   */
  constructor({ dir, openDatabase, runJob, hasUsableAgent = async () => true, enabled = () => true, checkMs = TEN_MINUTES_MS, now = Date.now, log = () => {} }) {
    Object.assign(this, { dir, openDatabase, runJob, hasUsableAgent, enabled, checkMs, now, log });
    this.timer = null; this.closed = false; this.busy = false; this.revision = 0;
  }

  path() { return join(this.dir, 'refresh.json'); }

  status() {
    try { return JSON.parse(readFileSync(this.path(), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }

  write(status) { writeJsonAtomic(this.path(), status); this.revision++; }

  start() { this.tick(); this.timer = setInterval(() => this.tick(), this.checkMs); this.timer.unref?.(); }

  /** A timer check: a failure (e.g. no database yet) is logged and the next check tries again. */
  tick() { this.check().catch((error) => this.log('warn', 'Work view refresh check failed', { error: String(error?.message ?? error) })); }

  close() { this.closed = true; clearInterval(this.timer); }

  iso(epoch = this.now()) { return new Date(epoch).toISOString(); }

  readNeeds() {
    const database = this.openDatabase();
    try { return refreshNeeds({ dir: this.dir, database, now: this.now() }); }
    finally { database.close(); }
  }

  /** The ten-minute check: run when something is due, otherwise record that nothing is. */
  async check() {
    if (this.closed) return 'closed';
    if (!this.enabled()) return 'disabled';
    if (this.busy) return 'running';
    const previous = this.status();
    // Another live worker process owns a run in progress.
    if (previous?.state === 'running' && previous.pid !== process.pid && previous.pid && processIsAlive(previous.pid)) return 'running';
    const needs = this.readNeeds();
    if (!needs.needed) {
      // A run this worker never finished was cut off by a restart.
      const interrupted = previous?.state === 'running';
      this.write({ ...previous, state: interrupted ? 'failed' : previous?.state ?? 'idle', ...(interrupted ? { error: 'The previous refresh stopped before finishing.' } : {}), checkedAt: this.iso(), nextAt: this.iso(this.now() + this.checkMs), needs });
      return 'idle';
    }
    return this.run(needs, 'scheduled');
  }

  /** Run now, whatever refreshNeeds() says (the install funnel after its scan). */
  async runNow({ reason }) {
    if (this.closed) return 'closed';
    if (this.busy) return 'running';
    return this.run(this.readNeeds(), reason);
  }

  async run(needs, reason) {
    this.busy = true;
    try {
      // No agent yet: say so, and the next ten-minute check tries again.
      if (!(await this.hasUsableAgent())) {
        this.write({ state: 'waiting-for-agent', reason, checkedAt: this.iso(), needs, error: 'No logged-in Claude Code, Codex or Gemini on this computer yet.', nextAt: this.iso(this.now() + this.checkMs) });
        return 'waiting-for-agent';
      }
      const startedAt = this.iso();
      this.write({ state: 'running', pid: process.pid, reason, startedAt, needs, nextAt: null });
      this.log('info', `Work view refresh started (${reason})`, { needs });
      let outcome;
      try { outcome = await this.runJob({ needs, reason }); }
      catch (error) { outcome = { state: 'failed', agent: null, result: null, error: String(error?.message ?? error).slice(0, 500) }; }
      const finishedAt = this.iso();
      this.write({
        state: outcome.state, reason, agent: outcome.agent ?? null, startedAt, finishedAt, needs,
        result: outcome.result ?? null, error: outcome.error ?? null, nextAt: this.iso(this.now() + this.checkMs),
      });
      this.log(outcome.state === 'ok' ? 'info' : 'warn', `Work view refresh ${outcome.state} (${reason})`, { agent: outcome.agent, error: outcome.error });
      return outcome.state;
    } finally { this.busy = false; }
  }
}
