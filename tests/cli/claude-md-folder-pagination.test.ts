import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';

const repoRoot = join(import.meta.dir, '..', '..');
const source = (file: string) => pathToFileURL(join(repoRoot, 'src', file)).href;
const sandboxes: string[] = [];
afterEach(() => { for (const root of sandboxes.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('CLAUDE.md direct-child pagination', () => {
  it('includes an older direct child after the configured page is full of nested candidates', () => {
    const root = mkdtempSync(join(tmpdir(), 'claude-md-page-')); sandboxes.push(root);
    const project = join(root, 'project'); const data = join(root, 'data');
    mkdirSync(join(project, 'src'), { recursive: true }); mkdirSync(data);
    writeFileSync(join(project, 'src', 'direct.ts'), 'export {};');
    writeFileSync(join(data, 'settings.json'), JSON.stringify({ CLAUDE_MEM_CONTEXT_OBSERVATIONS: '1' }));
    for (const args of [['init', '-q'], ['add', 'src/direct.ts']]) {
      const git = Bun.spawnSync(['git', ...args], { cwd: project }); expect(git.exitCode).toBe(0);
    }
    const child = Bun.spawnSync([process.execPath, '-e', `
      const { SessionStore } = await import(${JSON.stringify(source('services/sqlite/SessionStore.ts'))});
      const { paths } = await import(${JSON.stringify(source('shared/paths.ts'))});
      const { getProjectContext } = await import(${JSON.stringify(source('utils/project-name.ts'))});
      const { generateClaudeMd } = await import(${JSON.stringify(source('cli/claude-md-commands.ts'))});
      const store = new SessionStore(paths.database());
      const project = getProjectContext(process.cwd()).primary;
      for (let i = 0; i < 6; i++) {
        const memory = 'memory-' + i;
        const id = store.createSDKSession('content-' + i, project, 'prompt');
        store.ensureMemorySessionIdRegistered(id, memory);
        store.storeObservation(memory, project, {
          type: 'discovery', title: i === 0 ? 'Wanted direct child' : 'Nested candidate ' + i,
          subtitle: null, narrative: 'native fixture', facts: [], concepts: [],
          files_read: [i === 0 ? 'src/direct.ts' : 'src/nested/n' + i + '.ts'], files_modified: []
        }, 1, 0, 100 + i);
      }
      store.close(); process.exitCode = await generateClaudeMd(false);
    `], { cwd: project, env: { ...process.env, CLAUDE_MEM_DATA_DIR: data, CLAUDE_CONFIG_DIR: data, CLAUDE_MEM_TELEMETRY: '0' } });
    expect(child.exitCode).toBe(0);
    const context = readFileSync(join(project, 'src', 'CLAUDE.md'), 'utf8');
    expect(context).toContain('Wanted direct child');
    expect(context).not.toContain('Nested candidate');
    // Spawns Bun and runs every migration on a fresh database: well past the
    // 5s default on a slow runner.
  }, 30_000);
});
