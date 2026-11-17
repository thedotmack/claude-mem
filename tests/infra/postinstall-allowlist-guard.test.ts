// The guard's own promise is that a direct plugin dependency carrying an
// install script cannot land unreviewed. It used to skip any dependency it
// could not find in the ROOT node_modules tree - logging `(info) ... skipped`
// and exiting 0 - so a plugin-only (non-hoisted) dependency was never
// inspected. These drive the real script against fixture trees through its
// CLAUDE_MEM_GUARD_ROOT seam.
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { allowScriptsMap } from '../../scripts/postinstall-allowlist.js';

const scriptPath = path.resolve(import.meta.dir, '../../scripts/check-postinstall-allowlist.js');
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Placement = 'root' | 'plugin' | 'nowhere';

/** A fixture tree with the directories the guard reads. */
function makeFixture(depName: string, placement: Placement, depScripts: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'postinstall-guard-'));
  tempDirs.push(root);
  const allowScripts = allowScriptsMap();
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture-root', allowScripts }));
  mkdirSync(path.join(root, 'plugin'), { recursive: true });
  writeFileSync(
    path.join(root, 'plugin', 'package.json'),
    JSON.stringify({ name: 'fixture-plugin', dependencies: { [depName]: '1.0.0' }, allowScripts }),
  );
  if (placement !== 'nowhere') {
    const modules = placement === 'root'
      ? path.join(root, 'node_modules')
      : path.join(root, 'plugin', 'node_modules');
    mkdirSync(path.join(modules, depName), { recursive: true });
    writeFileSync(path.join(modules, depName, 'package.json'), JSON.stringify({ name: depName, scripts: depScripts }));
  }
  return root;
}

function runGuard(root: string): { status: number; stdout: string; stderr: string } {
  const result = spawnSync('node', [scriptPath], {
    env: { ...process.env, CLAUDE_MEM_GUARD_ROOT: root },
    encoding: 'utf8',
  });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

describe('postinstall allowlist guard coverage', () => {
  it('fails a postinstall-bearing dep in the plugin tree, which it used to skip', () => {
    const root = makeFixture('not-hoisted-dep', 'plugin', { postinstall: 'node build.js' });
    const { status, stderr } = runGuard(root);
    expect(status).toBe(1);
    expect(stderr).toContain('NOT allowlisted');
    expect(stderr).toContain('not-hoisted-dep');
  });

  it('still fails a postinstall-bearing dep in the root tree', () => {
    const root = makeFixture('hoisted-dep', 'root', { install: 'node build.js' });
    const { status, stderr } = runGuard(root);
    expect(status).toBe(1);
    expect(stderr).toContain('hoisted-dep');
  });

  it('fails a direct dep it cannot inspect at all, instead of logging and passing', () => {
    const root = makeFixture('absent-dep', 'nowhere', {});
    const { status, stderr } = runGuard(root);
    expect(status).toBe(1);
    expect(stderr).toContain('found in neither node_modules tree');
    expect(stderr).toContain('absent-dep');
  });

  it('passes a dep with no install scripts', () => {
    const root = makeFixture('plain-dep', 'plugin', { build: 'tsc' });
    const { status, stdout } = runGuard(root);
    expect(status, stdout).toBe(0);
    expect(stdout).toContain('Postinstall allowlist guard passed');
  });
});
