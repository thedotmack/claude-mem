import { describe, it, expect } from 'bun:test';
import { execFileSync, spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');

// Plugin installs run the files committed under plugin/, not a fresh build.
// CI runs this before `npm run build`, which would overwrite a broken bundle (#4728).
const committedPluginScripts = execFileSync(
  'git',
  ['ls-files', '--', 'plugin/scripts', 'plugin/sqlite', 'plugin/ui'],
  { cwd: projectRoot, encoding: 'utf-8' },
)
  .split('\n')
  .filter((trackedPath) => /\.c?js$/.test(trackedPath));

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
        cwd: projectRoot,
        encoding: 'utf-8',
      });
      expect(syntaxCheck.stderr).toBe('');
      expect(syntaxCheck.status).toBe(0);
    });
  }
});
