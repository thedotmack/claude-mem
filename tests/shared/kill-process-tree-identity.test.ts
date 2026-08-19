import { describe, it, expect, afterAll } from 'bun:test';
import { spawn } from 'child_process';
import { collectDescendantIdentities } from '../../src/shared/kill-process-tree.js';
import { captureProcessStartToken } from '../../src/shared/process-identity.js';

/**
 * Format-agreement guard for the atomic descendant enumeration.
 *
 * collectDescendantIdentities() takes each PID's start token from the SAME
 * process-table read that discovered it — /proc/<pid>/stat on Linux, one
 * `ps -eo pid=,ppid=,lstart=` on macOS/BSD, one CIM query on Windows. Every
 * later revalidation re-reads that token through captureProcessStartToken().
 *
 * If those two ever disagree on FORMAT, the failure is silent and severe: no
 * comparison would ever match, every descendant would be skipped as "reused",
 * and the orphan bug (#2313) comes straight back while the code still looks
 * guarded. That is the one way this design fails closed-but-wrong, so it is
 * asserted rather than assumed — on whatever platform the suite runs.
 */

const strays: number[] = [];

function settle(ms = 500): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

afterAll(() => {
  for (const pid of strays) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
});

describe('descendant enumeration agrees with captureProcessStartToken', () => {
  it('produces tokens identical to an independent re-probe', async () => {
    const command = process.platform === 'win32'
      ? spawn('cmd.exe', ['/c', 'ping -n 60 127.0.0.1 > NUL'], { stdio: 'ignore', windowsHide: true })
      : spawn('/bin/sh', ['-c', 'sleep 60 & sleep 60 & wait'], { stdio: 'ignore' });

    const rootPid = command.pid!;
    strays.push(rootPid);
    await settle();

    const descendants = await collectDescendantIdentities(rootPid);
    expect(descendants.length).toBeGreaterThan(0);

    // At least one token must have been readable, or the comparison below is
    // vacuous — every entry would trivially "agree" via the null fallback.
    const withTokens = descendants.filter(entry => entry.startToken !== null);
    expect(withTokens.length).toBeGreaterThan(0);

    for (const entry of withTokens) {
      const reprobed = captureProcessStartToken(entry.pid);
      // A null re-probe means the process exited between the two reads, which
      // is legitimate; only a NON-null disagreement is a format bug.
      if (reprobed === null) continue;
      expect(reprobed).toBe(entry.startToken);
    }

    try { process.kill(rootPid, 'SIGKILL'); } catch { /* fine */ }
  }, 30_000);

  it('returns leaves before their ancestors', async () => {
    if (process.platform === 'win32') return;

    const command = spawn(
      '/bin/sh',
      ['-c', '/bin/sh -c "sleep 60 & wait" & wait'],
      { stdio: 'ignore' }
    );
    const rootPid = command.pid!;
    strays.push(rootPid);
    await settle();

    const descendants = await collectDescendantIdentities(rootPid);
    expect(descendants.length).toBeGreaterThanOrEqual(2);

    // The intermediate shell is a direct child of the root; the innermost
    // sleep is its child. Leaves-first means the deeper one comes first.
    const pids = descendants.map(entry => entry.pid);
    const intermediate = pids[pids.length - 1];
    expect(descendants[0]!.pid).not.toBe(intermediate);

    try { process.kill(rootPid, 'SIGKILL'); } catch { /* fine */ }
  }, 30_000);
});
