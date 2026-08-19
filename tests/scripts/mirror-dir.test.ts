import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

/**
 * Tests for the mirror that replaced `rsync -av --delete` in
 * scripts/sync-marketplace.cjs.
 *
 * rsync does not exist on Windows and nothing in this repo installs it, so
 * Windows users could not run `npm run build-and-sync` at all. These tests pin
 * the two rsync behaviours the sync depends on:
 *
 *   1. `--delete` removes destination files the source no longer has (without
 *      it you rebuild and silently keep testing stale code).
 *   2. `--delete` still *protects* excluded paths on the receiving side, so the
 *      marketplace's .git and node_modules survive every sync.
 *
 * They run on Linux, macOS and Windows CI - the mirror is pure fs/path, so
 * this is where the cross-platform claim is actually checked.
 */

const { mirrorDirectory } = require('../../scripts/mirror-dir.cjs');
const { getMarketplaceExcludes } = require('../../scripts/sync-marketplace.cjs');

describe('mirrorDirectory', () => {
  let root: string;
  let source: string;
  let dest: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'claude-mem-mirror-'));
    source = join(root, 'source');
    dest = join(root, 'dest');
    mkdirSync(source, { recursive: true });
    mkdirSync(dest, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function write(base: string, relativePath: string, contents: string): void {
    const target = join(base, ...relativePath.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }

  function read(base: string, relativePath: string): string {
    return readFileSync(join(base, ...relativePath.split('/')), 'utf-8');
  }

  function has(base: string, relativePath: string): boolean {
    return existsSync(join(base, ...relativePath.split('/')));
  }

  it('copies a nested tree', () => {
    write(source, 'package.json', '{}');
    write(source, 'plugin/hooks/session-start.cjs', 'hook');
    write(source, 'plugin/.claude-plugin/plugin.json', '{"version":"1.0.0"}');

    const stats = mirrorDirectory(source, dest);

    expect(stats.copied).toBe(3);
    expect(read(dest, 'plugin/hooks/session-start.cjs')).toBe('hook');
    expect(read(dest, 'plugin/.claude-plugin/plugin.json')).toBe('{"version":"1.0.0"}');
  });

  it('deletes destination files the source no longer has', () => {
    write(source, 'keep.js', 'keep');
    write(dest, 'keep.js', 'stale contents');
    write(dest, 'removed.js', 'stale');
    write(dest, 'removed-dir/nested/deep.js', 'stale');

    const stats = mirrorDirectory(source, dest);

    expect(has(dest, 'removed.js')).toBe(false);
    expect(has(dest, 'removed-dir')).toBe(false);
    expect(read(dest, 'keep.js')).toBe('keep');
    expect(stats.deleted).toBe(2);
  });

  it('deletes stale files nested inside directories that survive', () => {
    write(source, 'plugin/current.js', 'current');
    write(dest, 'plugin/current.js', 'current');
    write(dest, 'plugin/stale.js', 'stale');

    mirrorDirectory(source, dest);

    expect(has(dest, 'plugin/stale.js')).toBe(false);
    expect(has(dest, 'plugin/current.js')).toBe(true);
  });

  it('protects excluded destination paths from deletion', () => {
    write(source, 'package.json', '{}');
    write(dest, 'node_modules/some-dep/index.js', 'dep');
    write(dest, '.git/HEAD', 'ref: refs/heads/main');
    write(dest, 'debug.log', 'log');

    const stats = mirrorDirectory(source, dest, {
      exclude: ['.git', 'node_modules/', '*.log'],
    });

    expect(has(dest, 'node_modules/some-dep/index.js')).toBe(true);
    expect(has(dest, '.git/HEAD')).toBe(true);
    expect(has(dest, 'debug.log')).toBe(true);
    expect(stats.deleted).toBe(0);
  });

  it('does not descend into excluded source directories', () => {
    write(source, 'src/index.ts', 'src');
    write(source, 'node_modules/dep/index.js', 'dep');
    write(source, 'dist/bundle.js', 'built');

    mirrorDirectory(source, dest, { exclude: ['node_modules/', 'dist/'] });

    expect(has(dest, 'src/index.ts')).toBe(true);
    expect(has(dest, 'node_modules')).toBe(false);
    expect(has(dest, 'dist')).toBe(false);
  });

  it('anchors patterns that start with a slash to the mirror root', () => {
    write(source, 'workers/sync-hub/index.ts', 'hub');
    write(source, 'plugin/workers/keep.ts', 'keep');

    mirrorDirectory(source, dest, { exclude: ['/workers'] });

    expect(has(dest, 'workers')).toBe(false);
    expect(has(dest, 'plugin/workers/keep.ts')).toBe(true);
  });

  it('matches slash-free patterns at any depth', () => {
    write(source, '.DS_Store', 'junk');
    write(source, 'plugin/.DS_Store', 'junk');
    write(source, 'plugin/keep.js', 'keep');

    mirrorDirectory(source, dest, { exclude: ['.DS_Store'] });

    expect(has(dest, '.DS_Store')).toBe(false);
    expect(has(dest, 'plugin/.DS_Store')).toBe(false);
    expect(has(dest, 'plugin/keep.js')).toBe(true);
  });

  it('applies trailing-slash patterns to directories only', () => {
    write(source, 'data', 'a file named data');
    write(source, 'plugin/data/memories.db', 'db');

    mirrorDirectory(source, dest, { exclude: ['plugin/data/'] });

    expect(has(dest, 'data')).toBe(true);
    expect(has(dest, 'plugin/data')).toBe(false);
  });

  it('replaces a changed file and skips unchanged ones on re-run', () => {
    write(source, 'a.js', 'one');
    write(source, 'b.js', 'two');

    expect(mirrorDirectory(source, dest).copied).toBe(2);
    expect(mirrorDirectory(source, dest).copied).toBe(0);

    write(source, 'a.js', 'one changed');

    const stats = mirrorDirectory(source, dest);
    expect(stats.copied).toBe(1);
    expect(read(dest, 'a.js')).toBe('one changed');
    expect(read(dest, 'b.js')).toBe('two');
  });

  it('replaces a destination file that became a directory in the source', () => {
    write(source, 'thing/child.js', 'child');
    write(dest, 'thing', 'used to be a file');

    mirrorDirectory(source, dest);

    expect(read(dest, 'thing/child.js')).toBe('child');
  });

  it('replaces a destination directory that became a file in the source', () => {
    write(source, 'thing', 'now a file');
    write(dest, 'thing/child.js', 'child');

    mirrorDirectory(source, dest);

    expect(read(dest, 'thing')).toBe('now a file');
  });
});

describe('marketplace sync excludes', () => {
  let root: string;
  let source: string;
  let dest: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'claude-mem-mirror-excludes-'));
    source = join(root, 'source');
    dest = join(root, 'dest');
    mkdirSync(source, { recursive: true });
    mkdirSync(dest, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('keeps the marketplace checkout and its installed deps while dropping stale build output', () => {
    writeFileSync(join(source, '.gitignore'), 'node_modules/\ndist/\n*.log\nplugin/data/\nbun.lock\n');
    mkdirSync(join(source, 'plugin'), { recursive: true });
    writeFileSync(join(source, 'plugin', 'index.cjs'), 'built');
    mkdirSync(join(source, 'workers'), { recursive: true });
    writeFileSync(join(source, 'workers', 'hub.ts'), 'hub');

    mkdirSync(join(dest, '.git'), { recursive: true });
    writeFileSync(join(dest, '.git', 'HEAD'), 'ref: refs/heads/main');
    mkdirSync(join(dest, 'node_modules', 'dep'), { recursive: true });
    writeFileSync(join(dest, 'node_modules', 'dep', 'index.js'), 'dep');
    mkdirSync(join(dest, 'plugin'), { recursive: true });
    writeFileSync(join(dest, 'plugin', 'removed-in-this-build.cjs'), 'stale');

    mirrorDirectory(source, dest, { exclude: getMarketplaceExcludes(source) });

    expect(existsSync(join(dest, '.git', 'HEAD'))).toBe(true);
    expect(existsSync(join(dest, 'node_modules', 'dep', 'index.js'))).toBe(true);
    expect(existsSync(join(dest, 'plugin', 'index.cjs'))).toBe(true);
    expect(existsSync(join(dest, 'plugin', 'removed-in-this-build.cjs'))).toBe(false);
    expect(existsSync(join(dest, 'workers'))).toBe(false);
  });
});
