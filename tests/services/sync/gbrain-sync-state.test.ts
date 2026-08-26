import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { GbrainSyncState } from '../../../src/services/sync/GbrainSyncState.js';

// GbrainSyncState resolves its file from CLAUDE_MEM_DATA_DIR dynamically
// (SettingsDefaultsManager.get reads process.env on every call), so isolation
// follows the chroma-sync-watermarks.test.ts pattern: a fresh temp
// CLAUDE_MEM_DATA_DIR per test + unique project names. The module-level cache
// survives across tests, so assertions never assume the file holds ONLY this
// test's projects.

const originalDataDir = process.env.CLAUDE_MEM_DATA_DIR;
let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'claude-mem-gbrain-state-'));
  process.env.CLAUDE_MEM_DATA_DIR = dataDir;
});

afterAll(() => {
  if (originalDataDir === undefined) {
    delete process.env.CLAUDE_MEM_DATA_DIR;
  } else {
    process.env.CLAUDE_MEM_DATA_DIR = originalDataDir;
  }
});

function statePath(): string {
  return join(dataDir, 'gbrain-sync-state.json');
}

function uniqueProject(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

describe('GbrainSyncState fresh-file defaults', () => {
  it('returns a zero watermark for a never-seen project', () => {
    const project = uniqueProject('fresh');
    expect(GbrainSyncState.get(project)).toEqual({ observations: 0 });
  });

  it('get alone does not create the state file in a fresh data dir', () => {
    const project = uniqueProject('fresh-nofile');
    GbrainSyncState.get(project);
    expect(existsSync(statePath())).toBe(false);
  });

  it('normalizes malformed watermarks to zero via replace', () => {
    const project = uniqueProject('malformed');
    GbrainSyncState.replace(project, { observations: 'nope' } as unknown as { observations: number });
    expect(GbrainSyncState.get(project)).toEqual({ observations: 0 });
  });
});

describe('GbrainSyncState bump monotonicity', () => {
  it('advances forward and never regresses', () => {
    const project = uniqueProject('monotonic');
    GbrainSyncState.bump(project, 10);
    expect(GbrainSyncState.get(project).observations).toBe(10);

    GbrainSyncState.bump(project, 5);
    expect(GbrainSyncState.get(project).observations).toBe(10);

    GbrainSyncState.bump(project, 10);
    expect(GbrainSyncState.get(project).observations).toBe(10);

    GbrainSyncState.bump(project, 11);
    expect(GbrainSyncState.get(project).observations).toBe(11);
  });

  it('ignores non-positive and non-integer ids', () => {
    const project = uniqueProject('guards');
    GbrainSyncState.bump(project, 0);
    GbrainSyncState.bump(project, -3);
    GbrainSyncState.bump(project, 2.5);
    GbrainSyncState.bump(project, NaN);
    expect(GbrainSyncState.get(project).observations).toBe(0);
  });

  it('a regressing bump does not rewrite the persisted file value', () => {
    const project = uniqueProject('persisted-monotonic');
    GbrainSyncState.bump(project, 20);
    GbrainSyncState.bump(project, 4);
    const onDisk = JSON.parse(readFileSync(statePath(), 'utf8'));
    expect(onDisk[project]).toEqual({ observations: 20 });
  });
});

describe('GbrainSyncState atomic persist', () => {
  it('after a bump the file exists, parses as JSON, and holds the watermark', () => {
    const project = uniqueProject('atomic');
    GbrainSyncState.bump(project, 7);

    expect(existsSync(statePath())).toBe(true);
    const onDisk = JSON.parse(readFileSync(statePath(), 'utf8'));
    expect(onDisk[project]).toEqual({ observations: 7 });
    // tmp+rename discipline: no stray tmp file left behind.
    expect(existsSync(`${statePath()}.tmp`)).toBe(false);
  });

  it('exists() reflects whether the state file has been persisted', () => {
    expect(GbrainSyncState.exists()).toBe(false);
    GbrainSyncState.bump(uniqueProject('exists'), 1);
    expect(GbrainSyncState.exists()).toBe(true);
  });
});

describe('GbrainSyncState per-project isolation', () => {
  it('bumping one project leaves another untouched, in memory and on disk', () => {
    const projectA = uniqueProject('proj-a');
    const projectB = uniqueProject('proj-b');

    GbrainSyncState.bump(projectA, 7);
    expect(GbrainSyncState.get(projectB).observations).toBe(0);

    GbrainSyncState.bump(projectB, 3);
    expect(GbrainSyncState.get(projectA).observations).toBe(7);
    expect(GbrainSyncState.get(projectB).observations).toBe(3);

    const onDisk = JSON.parse(readFileSync(statePath(), 'utf8'));
    expect(onDisk[projectA]).toEqual({ observations: 7 });
    expect(onDisk[projectB]).toEqual({ observations: 3 });
  });

  it('replace rewrites only the addressed project', () => {
    const projectA = uniqueProject('replace-a');
    const projectB = uniqueProject('replace-b');
    GbrainSyncState.bump(projectA, 9);
    GbrainSyncState.replace(projectB, { observations: 100 });

    expect(GbrainSyncState.get(projectA).observations).toBe(9);
    expect(GbrainSyncState.get(projectB).observations).toBe(100);
  });
});
