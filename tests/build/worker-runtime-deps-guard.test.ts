import { describe, it, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, copyFileSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const REPO_ROOT = join(import.meta.dir, '..', '..');
const GUARD = join(REPO_ROOT, 'scripts', 'check-worker-runtime-deps.cjs');

describe('check-worker-runtime-deps — build gate for the worker zod closure', () => {
  it('is wired into the build script so a broken closure can never ship silently', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8'));
    expect(pkg.scripts.build).toContain('check-worker-runtime-deps');
  });

  it('passes on the real shipped plugin closure (zod/v3 resolves from a clean frozen install)', () => {
    const r = spawnSync('node', [GUARD], { cwd: REPO_ROOT, encoding: 'utf-8' });
    expect(r.status).toBe(0);
    expect(`${r.stdout}${r.stderr}`).toContain('resolve from a clean frozen install');
  });

  it('FAILS the build when plugin/bun.lock drifts from plugin/package.json (the 13.11.0 breakage)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'cmem-guard-drift-'));
    try {
      // Real lockfile paired with a package.json that has zod removed → a clean
      // `bun install --frozen-lockfile` must refuse (lockfile drift), which is
      // exactly what shipped a resolvable-zod-less worker in 13.11.0.
      copyFileSync(join(REPO_ROOT, 'plugin', 'bun.lock'), join(tmp, 'bun.lock'));
      const manifest = readFileSync(join(REPO_ROOT, 'plugin', 'package.json'), 'utf-8');
      const stripped = manifest.split('\n').filter((l) => !l.includes('"zod"')).join('\n');
      writeFileSync(join(tmp, 'package.json'), stripped);
      mkdirSync(join(tmp, 'scripts'), { recursive: true });
      writeFileSync(join(tmp, 'scripts', 'worker-service.cjs'), '');

      const r = spawnSync('node', [GUARD, '--plugin-dir', tmp], { cwd: REPO_ROOT, encoding: 'utf-8' });
      expect(r.status).not.toBe(0);
      expect(`${r.stdout}${r.stderr}`).toMatch(/drift|13\.11\.0|frozen/i);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
