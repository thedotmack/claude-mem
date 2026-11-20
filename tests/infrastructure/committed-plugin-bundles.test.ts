import { describe, it, expect, afterAll } from 'bun:test';
import { execFileSync, spawnSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');

// Plugin installs run the files committed under plugin/, not a fresh build.
// A build overwrites the working tree (#4728) and renames hashed My Work assets,
// so the syntax check runs on the committed blobs, extracted from HEAD.
const committedPluginRoot = mkdtempSync(path.join(tmpdir(), 'committed-plugin-'));
afterAll(() => rmSync(committedPluginRoot, { recursive: true, force: true }));

const committedPluginScripts = execFileSync(
  'git',
  ['ls-files', '--', 'plugin/scripts', 'plugin/sqlite', 'plugin/ui'],
  { cwd: projectRoot, encoding: 'utf-8' },
)
  .split('\n')
  .filter((trackedPath) => /\.c?js$/.test(trackedPath));

const archivePath = path.join(committedPluginRoot, 'scripts.tar');
execFileSync('git', ['archive', `--output=${archivePath}`, 'HEAD', ...committedPluginScripts], { cwd: projectRoot });
execFileSync('tar', ['-xf', archivePath, '-C', committedPluginRoot]);

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

  it('parses every committed runtime script', async () => {
    const results = await Promise.all(committedPluginScripts.map(async scriptPath => {
      const child = Bun.spawn(['node', '--check', scriptPath], {
        cwd: committedPluginRoot,
        stdout: 'ignore',
        stderr: 'pipe',
      });
      const [stderr, status] = await Promise.all([
        new Response(child.stderr).text(), child.exited,
      ]);
      return { scriptPath, stderr, status };
    }));
    for (const result of results) {
      expect(result).toEqual({ scriptPath: result.scriptPath, stderr: '', status: 0 });
    }
  });
});
