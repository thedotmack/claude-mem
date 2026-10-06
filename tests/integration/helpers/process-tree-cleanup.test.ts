import { describe, expect, it } from 'bun:test';
import { classifyPostKillState } from './ghost-state.js';
import { reapSnapshottedDescendants, type ProcessIdentity } from './process-tree.js';

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
});
