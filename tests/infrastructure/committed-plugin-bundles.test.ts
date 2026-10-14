import { describe, it, expect } from 'bun:test';
import { execFileSync, spawnSync } from 'child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
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
  it('runs a Codex hook from a plugin cache without node_modules', () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), 'cm-codex-bundle-'));
    try {
      // An ancestor node_modules disables Bun's implicit package auto-install.
      mkdirSync(path.join(sandbox, 'node_modules'));
      const pluginRoot = path.join(sandbox, 'cache', 'claude-mem');
      const scripts = path.join(pluginRoot, 'scripts');
      mkdirSync(scripts, { recursive: true });
      for (const script of ['bun-runner.js', 'worker-service.cjs']) {
        cpSync(path.join(projectRoot, 'plugin', 'scripts', script), path.join(scripts, script));
      }
      cpSync(path.join(projectRoot, 'plugin', 'package.json'), path.join(pluginRoot, 'package.json'));
      const dataDir = path.join(sandbox, 'data');
      mkdirSync(dataDir);
      writeFileSync(path.join(dataDir, 'settings.json'), '{}');

      const hook = spawnSync('node', [
        path.join(scripts, 'bun-runner.js'),
        path.join(scripts, 'worker-service.cjs'),
        'hook', 'codex', 'file-context',
      ], {
        cwd: sandbox,
        env: {
          ...process.env,
          CLAUDE_PLUGIN_ROOT: pluginRoot,
          CLAUDE_CONFIG_DIR: path.join(sandbox, 'config'),
          CLAUDE_MEM_DATA_DIR: dataDir,
          CLAUDE_MEM_CODEX_HOOK: '1',
        },
        input: JSON.stringify({
          cwd: sandbox,
          hook_event_name: 'PreToolUse',
          tool_name: 'Read',
          tool_input: { file_path: path.join(sandbox, 'example.md') },
        }),
        encoding: 'utf-8',
        timeout: 15_000,
      });
      expect(hook.stderr).toBe('');
      expect(hook.status).toBe(0);
      expect(JSON.parse(hook.stdout)).toEqual({ continue: true });
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

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
