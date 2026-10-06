import { describe, expect, it } from 'bun:test';
import { classifyPostKillState } from './ghost-state.js';
import { reapOwnedLiveTree, reapSnapshottedDescendants, runForMatchingProcess, snapshotDescendants, survivingProcesses, type ProcessIdentity } from './process-tree.js';

describe('ghost fixture descendant cleanup', () => {
  const snapshot: ProcessIdentity[] = [
    { pid: 21, startToken: 'root-1', name: 'chroma-mcp.exe' },
    { pid: 22, startToken: 'python-1', name: 'python.exe' },
    { pid: 23, startToken: 'python-2', name: 'python.exe' },
  ];

  it('reaps the identified sidecars even in the free-port runtime skip', () => {
    const state = classifyPostKillState({
      fixturePid: 20,
      fixtureAlive: false,
      portOwners: [],
      chainSurvived: true,
    });
    expect(state.kind).toBe('runtime-capability-skip');

    const killed: number[] = [];
    reapSnapshottedDescendants(
      snapshot,
      (pid, token) => snapshot.some(entry => entry.pid === pid && entry.startToken === token),
      pid => { killed.push(pid); }
    );
    expect(killed).toEqual([23, 22, 21]);
  });

  it('leaves reused and unverified PIDs alone', () => {
    const killed: number[] = [];
    const checked: number[] = [];
    reapSnapshottedDescendants(
      [
        ...snapshot,
        { pid: 24, startToken: null, name: 'python.exe' },
      ],
      (pid, token) => {
        checked.push(pid);
        // pid 22 was reused; pid 23 could not be read this time.
        return pid === 21 && token === 'root-1';
      },
      pid => { killed.push(pid); }
    );
    expect(checked).toEqual([23, 22, 21]);
    expect(killed).toEqual([21]);
  });

  it('keeps the discovery-row token when a child PID is reused before cleanup', () => {
    const rows = [
      { pid: 20, ppid: 1, name: 'fixture.exe', startToken: 'fixture-original' },
      { pid: 21, ppid: 20, name: 'chroma-mcp.exe', startToken: 'chroma-original' },
      { pid: 22, ppid: 21, name: 'python.exe', startToken: 'python-original' },
    ];
    // A later token probe of pid 22 would see `python-replacement`. The
    // snapshot must carry the token from the row that proved its ancestry.
    const takeSnapshot = snapshotDescendants as (...args: unknown[]) => ProcessIdentity[];
    const discovered = takeSnapshot(20, 'fixture-original', rows);
    expect(discovered.find(entry => entry.pid === 22)?.startToken).toBe('python-original');

    const killed: number[] = [];
    reapSnapshottedDescendants(
      discovered,
      (pid, token) => pid === 21 && token === 'chroma-original',
      pid => { killed.push(pid); }
    );
    expect(killed).toEqual([21]);
  });

  it('refuses to walk a recycled fixture root', () => {
    const rows = [
      { pid: 20, ppid: 1, name: 'unrelated.exe', startToken: 'replacement' },
      { pid: 21, ppid: 20, name: 'python.exe', startToken: 'unrelated-child' },
    ];
    const takeSnapshot = snapshotDescendants as (...args: unknown[]) => ProcessIdentity[];
    expect(() => takeSnapshot(20, 'fixture-original', rows)).toThrow('fixture root identity');
  });

  it('skips unverified roots in successful and failed-readiness cleanup', async () => {
    const killed: number[] = [];
    const action = (pid: number) => { killed.push(pid); };
    expect(await runForMatchingProcess(20, null, action, () => true)).toBe(false);
    expect(await runForMatchingProcess(20, 'fixture-original', action, () => false)).toBe(false);
    expect(await runForMatchingProcess(20, 'fixture-original', action, (_, token) => token === 'fixture-original')).toBe(true);
    expect(killed).toEqual([20]);
  });

  it('keeps reaping other descendants when one kill fails', () => {
    const attempted: number[] = [];
    expect(() => reapSnapshottedDescendants(
      snapshot,
      () => true,
      pid => {
        attempted.push(pid);
        if (pid === 23) throw new Error('Access is denied');
      }
    )).toThrow('Access is denied');
    expect(attempted).toEqual([23, 22, 21]);
  });

  it('never tree-kills a failed-readiness PID without its recorded identity', () => {
    const rows = [
      { pid: 20, ppid: 1, name: 'unrelated.exe', startToken: 'replacement' },
      { pid: 21, ppid: 20, name: 'python.exe', startToken: 'unrelated-child' },
    ];
    const killed: number[] = [];
    const kill = (pid: number) => { killed.push(pid); };
    expect(reapOwnedLiveTree(20, null, kill, () => true, rows)).toBeNull();
    expect(reapOwnedLiveTree(20, 'fixture-original', kill, (_, token) => token === 'replacement', rows)).toBeNull();
    expect(killed).toEqual([]);
  });

  it('reaps identified children then an identified live root', () => {
    const rows = [
      { pid: 20, ppid: 1, name: 'fixture.exe', startToken: 'fixture-original' },
      { pid: 21, ppid: 20, name: 'chroma-mcp.exe', startToken: 'chroma-original' },
      { pid: 22, ppid: 21, name: 'python.exe', startToken: 'python-original' },
    ];
    const killed: number[] = [];
    expect(reapOwnedLiveTree(20, 'fixture-original', pid => { killed.push(pid); }, () => true, rows)).toEqual([
      { pid: 21, name: 'chroma-mcp.exe', startToken: 'chroma-original' },
      { pid: 22, name: 'python.exe', startToken: 'python-original' },
    ]);
    expect(killed).toEqual([22, 21, 20]);

    let rootChecks = 0;
    killed.length = 0;
    expect(reapOwnedLiveTree(20, 'fixture-original', pid => { killed.push(pid); }, pid =>
      pid !== 20 || ++rootChecks === 1, rows)).toHaveLength(2);
    expect(killed).toEqual([22, 21]); // Root PID was reissued during cleanup.
  });

  it('retains a live null-token child for final verification without killing it', () => {
    const rows = [
      { pid: 20, ppid: 1, name: 'fixture.exe', startToken: 'fixture-original' },
      { pid: 21, ppid: 20, name: 'python.exe', startToken: null },
      { pid: 22, ppid: 20, name: 'uv.exe', startToken: 'uv-original' },
    ];
    const killed: number[] = [];
    let retained: ProcessIdentity[] = [];
    const discovered = reapOwnedLiveTree(
      20, 'fixture-original', pid => { killed.push(pid); }, () => true,
      rows, children => { retained = children; }
    );
    expect(discovered).toEqual(retained);
    expect(killed).toEqual([22, 20]);
    expect(survivingProcesses(retained, pid => pid === 21, () => null)).toEqual([
      { pid: 21, name: 'python.exe', startToken: null },
    ]);
  });

  it('retains failed-start children before a kill error interrupts cleanup', () => {
    const rows = [
      { pid: 20, ppid: 1, name: 'fixture.exe', startToken: 'fixture-original' },
      { pid: 21, ppid: 20, name: 'python.exe', startToken: 'python-original' },
    ];
    let retained: ProcessIdentity[] = [];
    expect(() => reapOwnedLiveTree(
      20, 'fixture-original', () => { throw new Error('Access is denied'); },
      () => true, rows, children => { retained = children; }
    )).toThrow('Access is denied');
    expect(retained).toEqual([{ pid: 21, name: 'python.exe', startToken: 'python-original' }]);
  });
});
