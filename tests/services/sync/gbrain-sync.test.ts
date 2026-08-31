import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { GbrainSync } from '../../../src/services/sync/GbrainSync.js';
import { GbrainSyncState } from '../../../src/services/sync/GbrainSyncState.js';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import type { ParsedObservation } from '../../../src/sdk/parser.js';

// GbrainSync spawns the configured CLI path directly (no shell), so the fake
// `gbrain` is an executable /bin/sh script that appends argv + stdin to a log
// file and exits with a scripted code. Constructor injection is the seam for
// argv/stdin/watermark behavior; fromSettings gating is exercised via env
// overrides (SettingsDefaultsManager.loadFromFile applies process.env last).

const GBRAIN_ENV_KEYS = [
  'CLAUDE_MEM_GBRAIN_ENABLED',
  'CLAUDE_MEM_GBRAIN_CLI_PATH',
  'CLAUDE_MEM_GBRAIN_SOURCE',
  'CLAUDE_MEM_GBRAIN_SLUG_PREFIX',
  'CLAUDE_MEM_GBRAIN_PROJECTS',
  'CLAUDE_MEM_GBRAIN_BACKFILL_ENABLED',
] as const;

const originalEnv: Record<string, string | undefined> = {};
for (const key of [...GBRAIN_ENV_KEYS, 'CLAUDE_MEM_DATA_DIR']) {
  originalEnv[key] = process.env[key];
}

let testDir: string;
let logPath: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'claude-mem-gbrain-sync-'));
  logPath = join(testDir, 'gbrain-invocations.log');
  // Isolate the watermark file per test (GbrainSyncState reads
  // CLAUDE_MEM_DATA_DIR from process.env on every call).
  process.env.CLAUDE_MEM_DATA_DIR = mkdtempSync(join(tmpdir(), 'claude-mem-gbrain-sync-data-'));
  for (const key of GBRAIN_ENV_KEYS) {
    delete process.env[key];
  }
});

afterAll(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

interface FakeInvocation {
  args: string[];
  stdin: string;
}

function writeFakeGbrain(exitCode: number, importOutput: 'valid' | 'invalid' = 'valid'): string {
  const suffix = importOutput === 'valid' ? '' : '-invalid-json';
  const scriptPath = join(testDir, (exitCode === 0 ? 'fake-gbrain' : `fake-gbrain-exit${exitCode}`) + suffix);
  const script = [
    '#!/bin/sh',
    '{',
    '  echo "INVOCATION"',
    '  for a in "$@"; do',
    '    echo "ARG:$a"',
    '  done',
    '  echo "STDIN-BEGIN"',
    '  cat',
    '  echo "STDIN-END"',
    `} >> "${logPath}"`,
    'if [ "$1" = "import" ]; then',
    ...(importOutput === 'valid'
      ? [
          '  count=$(find "$2" -type f -name "*.md" | wc -l | tr -d " ")',
          '  printf \'{"status":"success","errors":0,"total_files":%s}\\n\' "$count"',
        ]
      : ['  echo "not-json"']),
    'fi',
    `exit ${exitCode}`,
    '',
  ].join('\n');
  writeFileSync(scriptPath, script, 'utf8');
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}

function readInvocations(): FakeInvocation[] {
  if (!existsSync(logPath)) return [];
  const invocations: FakeInvocation[] = [];
  let current: FakeInvocation | null = null;
  let inStdin = false;
  for (const line of readFileSync(logPath, 'utf8').split('\n')) {
    if (line === 'INVOCATION') {
      current = { args: [], stdin: '' };
      invocations.push(current);
      inStdin = false;
    } else if (line === 'STDIN-BEGIN') {
      inStdin = true;
    } else if (line === 'STDIN-END') {
      inStdin = false;
    } else if (current && inStdin) {
      current.stdin += (current.stdin ? '\n' : '') + line;
    } else if (current && line.startsWith('ARG:')) {
      current.args.push(line.slice('ARG:'.length));
    }
  }
  return invocations;
}

function makeSync(cliPath: string, overrides: Partial<{
  sourceId: string;
  slugPrefix: string;
  projectsFilter: string[];
}> = {}): GbrainSync {
  return new GbrainSync({
    cliPath,
    sourceId: '',
    slugPrefix: 'claude-mem',
    projectsFilter: [],
    ...overrides,
  });
}

function makeObservation(overrides: Partial<ParsedObservation> = {}): ParsedObservation {
  return {
    type: 'discovery',
    title: 'Found the bug',
    subtitle: 'It was the cache',
    narrative: 'The cache was stale.',
    facts: ['Fact one'],
    concepts: ['caching'],
    files_read: ['src/a.ts'],
    files_modified: [],
    ...overrides,
  };
}

function uniqueProject(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

describe('GbrainSync.fromSettings gating', () => {
  it('returns null when the connector is not enabled', () => {
    process.env.CLAUDE_MEM_GBRAIN_ENABLED = 'false';
    expect(GbrainSync.fromSettings()).toBeNull();
  });

  it('returns a configured instance when enabled', () => {
    process.env.CLAUDE_MEM_GBRAIN_ENABLED = 'true';
    process.env.CLAUDE_MEM_GBRAIN_PROJECTS = 'alpha, beta';
    const sync = GbrainSync.fromSettings();
    expect(sync).not.toBeNull();
    expect(sync!.shouldSyncProject('alpha')).toBe(true);
    expect(sync!.shouldSyncProject('beta')).toBe(true);
    expect(sync!.shouldSyncProject('gamma')).toBe(false);
  });
});

describe('GbrainSync.syncObservation live lane', () => {
  it('spawns capture with the expected argv and leaves the contiguous backfill watermark unchanged', async () => {
    const project = uniqueProject('capture');
    const sync = makeSync(writeFakeGbrain(0));

    await sync.syncObservation(42, project, makeObservation(), 1_700_000_000_000, 'mem-session-1');

    const invocations = readInvocations();
    expect(invocations.length).toBe(1);
    expect(invocations[0].args).toEqual([
      'capture',
      '--stdin',
      '--slug',
      `claude-mem/${project}/obs-42`,
      '--type',
      'note',
      '--json',
    ]);
    expect(invocations[0].stdin).toContain('type: note');
    expect(invocations[0].stdin).toContain("title: 'Found the bug'");
    expect(invocations[0].stdin).toContain('observation_id: 42');
    expect(invocations[0].stdin).toContain('## [DISCOVERY] Found the bug');

    expect(GbrainSyncState.get(project).observations).toBe(0);
  });

  it('appends --source when a source id is configured', async () => {
    const project = uniqueProject('source');
    const sync = makeSync(writeFakeGbrain(0), { sourceId: 'src-123' });

    await sync.syncObservation(7, project, makeObservation(), 1_700_000_000_000, 'mem-session-1');

    const invocations = readInvocations();
    expect(invocations.length).toBe(1);
    expect(invocations[0].args.slice(-2)).toEqual(['--source', 'src-123']);
  });

  it('does not bump the watermark on a failing CLI, and disables itself after 3 consecutive failures', async () => {
    const project = uniqueProject('failing');
    const sync = makeSync(writeFakeGbrain(1));

    await sync.syncObservation(1, project, makeObservation(), 1_700_000_000_000, 'mem-1');
    expect(GbrainSyncState.get(project).observations).toBe(0);
    expect(sync.isDisabledForSession()).toBe(false);

    await sync.syncObservation(2, project, makeObservation(), 1_700_000_000_000, 'mem-2');
    expect(sync.isDisabledForSession()).toBe(false);

    await sync.syncObservation(3, project, makeObservation(), 1_700_000_000_000, 'mem-3');
    expect(sync.isDisabledForSession()).toBe(true);
    expect(readInvocations().length).toBe(3);
    expect(GbrainSyncState.get(project).observations).toBe(0);

    // Disabled for session: no further spawns.
    await sync.syncObservation(4, project, makeObservation(), 1_700_000_000_000, 'mem-4');
    expect(readInvocations().length).toBe(3);
    expect(GbrainSyncState.get(project).observations).toBe(0);
  });

  it('serializes a concurrent batch so the failure circuit breaker caps it at three spawns', async () => {
    const project = uniqueProject('concurrent-failing');
    const sync = makeSync(writeFakeGbrain(1));

    await Promise.all(Array.from({ length: 8 }, (_, index) =>
      sync.syncObservation(index + 1, project, makeObservation(), 1_700_000_000_000, `mem-${index + 1}`)
    ));

    expect(sync.isDisabledForSession()).toBe(true);
    expect(readInvocations().length).toBe(3);
    expect(GbrainSyncState.get(project).observations).toBe(0);
  });

  it('a success resets the failure streak', async () => {
    const project = uniqueProject('streak-reset');
    const failing = writeFakeGbrain(1);
    const succeeding = writeFakeGbrain(0);

    const sync = makeSync(failing) as GbrainSync & { config: { cliPath: string } };
    await sync.syncObservation(1, project, makeObservation(), 1_700_000_000_000, 'mem-1');
    await sync.syncObservation(2, project, makeObservation(), 1_700_000_000_000, 'mem-2');
    sync.config.cliPath = succeeding;
    await sync.syncObservation(3, project, makeObservation(), 1_700_000_000_000, 'mem-3');
    expect(GbrainSyncState.get(project).observations).toBe(0);
    sync.config.cliPath = failing;
    await sync.syncObservation(4, project, makeObservation(), 1_700_000_000_000, 'mem-4');
    // One failure after a success is a streak of 1 — still enabled.
    expect(sync.isDisabledForSession()).toBe(false);
  });

  it('skips projects outside the configured filter without spawning', async () => {
    const project = uniqueProject('filtered-out');
    const sync = makeSync(writeFakeGbrain(0), { projectsFilter: ['allowed-project'] });

    await sync.syncObservation(5, project, makeObservation(), 1_700_000_000_000, 'mem-1');

    expect(readInvocations().length).toBe(0);
    expect(GbrainSyncState.get(project).observations).toBe(0);
    expect(sync.shouldSyncProject('allowed-project')).toBe(true);
    expect(sync.shouldSyncProject(project)).toBe(false);
  });

  it('resolves without throwing when the CLI path does not exist (spawn ENOENT)', async () => {
    const project = uniqueProject('enoent');
    const sync = makeSync(join(testDir, 'no-such-gbrain'));

    await sync.syncObservation(9, project, makeObservation(), 1_700_000_000_000, 'mem-1');

    expect(GbrainSyncState.get(project).observations).toBe(0);
    expect(readInvocations().length).toBe(0);
  });
});

describe('GbrainSync backfill lane', () => {
  function storeObservations(store: SessionStore, project: string, count: number): number[] {
    const memorySessionId = store.getOrCreateManualSession(project);
    const observations = Array.from({ length: count }, (_, index) => ({
      type: 'discovery',
      title: `Observation ${index + 1}`,
      subtitle: null,
      narrative: `Narrative ${index + 1}`,
      facts: [`Fact ${index + 1}`],
      concepts: ['testing'],
      files_read: [],
      files_modified: [],
    }));
    return store.storeObservations(memorySessionId, project, observations, null).observationIds;
  }

  it('advances the watermark only after a confirmed bulk import', async () => {
    const project = uniqueProject('backfill');
    const store = new SessionStore(':memory:');
    try {
      const ids = storeObservations(store, project, 2);
      const sync = makeSync(writeFakeGbrain(0));

      await sync.ensureBackfilled(project, store);

      expect(GbrainSyncState.get(project).observations).toBe(ids[1]);
      const invocations = readInvocations();
      expect(invocations.map(invocation => invocation.args[0])).toEqual(['import', 'embed']);
    } finally {
      store.close();
    }
  });

  it('does not trust exit zero when --json output cannot confirm per-file success', async () => {
    const project = uniqueProject('backfill-invalid-json');
    const store = new SessionStore(':memory:');
    try {
      storeObservations(store, project, 1);
      const sync = makeSync(writeFakeGbrain(0, 'invalid'));

      await sync.ensureBackfilled(project, store);

      expect(GbrainSyncState.get(project).observations).toBe(0);
      expect(readInvocations().map(invocation => invocation.args[0])).toEqual(['import']);
    } finally {
      store.close();
    }
  });
});
