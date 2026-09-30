import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  cacheWorkerScriptCandidates,
  compareVersionsDescending,
  selectWorkerScript,
} from '../src/shared/worker-utils.js';
import { buildCodexWindowsCommand, buildShellCommand } from '../src/build/hook-shell-template.js';

// Regression tests for the 2026-07-22 restart storm: the worker-script
// resolver ranked plugin cache dirs by directory mtime, so Claude Code
// stamping the OLD version dir with .orphaned_at made it "newest" and every
// restart respawned the stale worker under a newer plugin, forever. The
// resolver must rank by version, never mtime, and must skip orphaned dirs.

const tmpRoots: string[] = [];

afterAll(() => {
  for (const root of tmpRoots) rmSync(root, { recursive: true, force: true });
});

function makeCacheRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'claude-mem-cache-'));
  tmpRoots.push(root);
  return root;
}

function makeVersionDir(
  cacheRoot: string,
  version: string,
  options: { orphaned?: boolean; mtimeSecondsAgo?: number } = {}
): string {
  const versionDir = join(cacheRoot, version);
  mkdirSync(join(versionDir, 'scripts'), { recursive: true });
  const scriptPath = join(versionDir, 'scripts', 'worker-service.cjs');
  writeFileSync(scriptPath, '// fake worker\n');
  if (options.orphaned) {
    writeFileSync(join(versionDir, '.orphaned_at'), String(Date.now()));
  }
  if (options.mtimeSecondsAgo !== undefined) {
    const when = new Date(Date.now() - options.mtimeSecondsAgo * 1000);
    utimesSync(versionDir, when, when);
  }
  return scriptPath;
}

describe('compareVersionsDescending', () => {
  test('ranks the highest version first', () => {
    const sorted = ['13.11.0', '13.12.0', '13.10.4'].sort(compareVersionsDescending);
    expect(sorted).toEqual(['13.12.0', '13.11.0', '13.10.4']);
  });

  test('compares segments numerically, not lexically', () => {
    expect(compareVersionsDescending('13.10.0', '13.2.0')).toBeLessThan(0);
    expect(compareVersionsDescending('2.0.0', '13.0.0')).toBeGreaterThan(0);
  });

  test('ranks a release ahead of its own prerelease', () => {
    expect(compareVersionsDescending('13.10.3', '13.10.3-community-edge.0')).toBeLessThan(0);
  });

  test('ranks a higher-base prerelease ahead of a lower release', () => {
    expect(compareVersionsDescending('13.11.0-beta.1', '13.10.4')).toBeLessThan(0);
  });

  test('returns 0 for equal versions', () => {
    expect(compareVersionsDescending('13.12.0', '13.12.0')).toBe(0);
  });
});

describe('cacheWorkerScriptCandidates', () => {
  test('excludes .orphaned_at-stamped version dirs even when their mtime is newest', () => {
    const cacheRoot = makeCacheRoot();
    // The storm layout: the orphan stamp made 13.11.0 the newest dir by mtime.
    makeVersionDir(cacheRoot, '13.11.0', { orphaned: true, mtimeSecondsAgo: 0 });
    makeVersionDir(cacheRoot, '13.12.0', { mtimeSecondsAgo: 600 });

    const versions = cacheWorkerScriptCandidates(cacheRoot).map(candidate => candidate.version);
    expect(versions).toEqual(['13.12.0']);
  });

  test('skips entries that are not version-named directories', () => {
    const cacheRoot = makeCacheRoot();
    makeVersionDir(cacheRoot, '13.12.0');
    writeFileSync(join(cacheRoot, '13.9.9'), 'plain file, not a dir');
    mkdirSync(join(cacheRoot, 'not-a-version'));

    const versions = cacheWorkerScriptCandidates(cacheRoot).map(candidate => candidate.version);
    expect(versions).toEqual(['13.12.0']);
  });

  test('returns an empty list for a missing cache root', () => {
    expect(cacheWorkerScriptCandidates(join(tmpdir(), 'claude-mem-no-such-cache'))).toEqual([]);
  });
});

describe('selectWorkerScript', () => {
  test('picks the highest version regardless of directory mtime', () => {
    const cacheRoot = makeCacheRoot();
    // No orphan stamps at all: even then, a newest-mtime old dir must lose.
    makeVersionDir(cacheRoot, '13.11.0', { mtimeSecondsAgo: 0 });
    const newestScript = makeVersionDir(cacheRoot, '13.12.0', { mtimeSecondsAgo: 600 });

    const selected = selectWorkerScript(cacheWorkerScriptCandidates(cacheRoot));
    expect(selected?.version).toBe('13.12.0');
    expect(selected?.scriptPath).toBe(newestScript);
  });

  test('ranks versionless candidates behind every versioned one', () => {
    const cacheRoot = makeCacheRoot();
    const versionedScript = makeVersionDir(cacheRoot, '1.0.0');
    const versionlessScript = makeVersionDir(cacheRoot, '9-no-version-known');

    const selected = selectWorkerScript([
      { scriptPath: versionlessScript, version: null },
      { scriptPath: versionedScript, version: '1.0.0' },
    ]);
    expect(selected?.version).toBe('1.0.0');
  });

  test('keeps candidate order on version ties (cache-before-marketplace precedence)', () => {
    const cacheRoot = makeCacheRoot();
    const first = makeVersionDir(cacheRoot, '13.12.0');
    const marketplaceRoot = makeCacheRoot();
    const second = makeVersionDir(marketplaceRoot, '13.12.0');

    const selected = selectWorkerScript([
      { scriptPath: first, version: '13.12.0' },
      { scriptPath: second, version: '13.12.0' },
    ]);
    expect(selected?.scriptPath).toBe(first);
  });

  test('filters candidates whose script does not exist', () => {
    expect(selectWorkerScript([
      { scriptPath: join(tmpdir(), 'claude-mem-missing', 'worker-service.cjs'), version: '99.0.0' },
    ])).toBeNull();
  });
});

describe('inline bootstrap resolvers stay in lockstep', () => {
  const mcpCommand = buildShellCommand({
    host: 'mcp',
    requireFile: 'mcp-server.cjs',
    notFoundMessage: 'claude-mem: mcp server not found',
    mcpExtraCandidates: ['$PWD/plugin', '$PWD'],
    mcpExtraCacheRoots: [
      '$HOME/.codex/plugins/cache/claude-mem-local/claude-mem',
      '$HOME/.codex/plugins/cache/thedotmack/claude-mem',
    ],
  });
  const codexWindowsCommand = buildCodexWindowsCommand(['hook', 'codex', 'context']);

  test.each([
    ['mcp node launcher', mcpCommand],
    ['codex windows launcher', codexWindowsCommand],
  ])('%s ranks cache dirs by version, never mtime, and skips orphaned dirs', (_name, command) => {
    expect(command).not.toContain('mtimeMs');
    expect(command).toContain('.orphaned_at');
    expect(command).toContain('W(p.basename(a),p.basename(b))');
  });
});
