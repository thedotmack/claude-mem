import { describe, it, expect, afterAll } from 'bun:test';
import { execFileSync, spawnSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');

// Plugin installs run the files committed under plugin/, not a fresh build.
// A build overwrites the working tree (#4728) and renames hashed My Work assets,
// so the syntax check runs on the committed blobs, extracted from HEAD.
// Each file is read with `git show`, so this needs only git (no sh or tar, which Windows may lack).
const committedPluginRoot = mkdtempSync(path.join(tmpdir(), 'committed-plugin-'));
afterAll(() => rmSync(committedPluginRoot, { recursive: true, force: true }));

const committedPluginScripts = execFileSync(
  'git',
  ['ls-files', '--', 'plugin/scripts', 'plugin/sqlite', 'plugin/ui'],
  { cwd: projectRoot, encoding: 'utf-8' },
)
  .split('\n')
  .filter((trackedPath) => /\.c?js$/.test(trackedPath));

for (const scriptPath of committedPluginScripts) {
  const committed = execFileSync('git', ['show', `HEAD:${scriptPath}`], { cwd: projectRoot, maxBuffer: 256 * 1024 * 1024 });
  const target = path.join(committedPluginRoot, scriptPath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, committed);
}

describe('Committed plugin bundles', () => {
  it('contain no merge-conflict markers', () => {
    const conflictMarkerSearch = spawnSync(
      'git',
      ['grep', '-n', '-I', '-E', '^(<<<<<<<|>>>>>>>) ', '--', 'plugin/'],
      { cwd: projectRoot, encoding: 'utf-8' },
    );
    expect(conflictMarkerSearch.stdout).toBe('');
    // git grep exits 1 when nothing matches; anything else means the search failed.
    expect(conflictMarkerSearch.status).toBe(1);
  });

  it('include the worker bundle in the syntax check', () => {
    expect(committedPluginScripts).toContain('plugin/scripts/worker-service.cjs');
  });

  for (const scriptPath of committedPluginScripts) {
    it(`parses ${scriptPath}`, () => {
      const syntaxCheck = spawnSync('node', ['--check', scriptPath], {
        cwd: committedPluginRoot,
        encoding: 'utf-8',
      });
      expect(syntaxCheck.stderr).toBe('');
      expect(syntaxCheck.status).toBe(0);
    });
  }
});
