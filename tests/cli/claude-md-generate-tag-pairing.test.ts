import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';

const repoRoot = join(import.meta.dir, '..', '..');
const source = (file: string) => pathToFileURL(join(repoRoot, 'src', file)).href;
const sandboxes: string[] = [];
afterEach(() => { for (const root of sandboxes.splice(0)) rmSync(root, { recursive: true, force: true }); });

// `claude-mem generate` rewrites the managed block of each folder's CLAUDE.md.
// A closing tag in the user's own text before the block was taken for the end
// of the block, so every run copied the text between them again and kept the
// old block.
describe('claude-mem generate pairs the context tags of an existing CLAUDE.md', () => {
  it('replaces only the block when a closing tag comes before it, and stays the same across runs', () => {
    const root = mkdtempSync(join(tmpdir(), 'claude-md-tags-')); sandboxes.push(root);
    const project = join(root, 'project'); const data = join(root, 'data');
    mkdirSync(join(project, 'src'), { recursive: true }); mkdirSync(data);
    writeFileSync(join(project, 'src', 'direct.ts'), 'export {};');
    const userText = '# Notes\n\nThe </claude-mem-context> tag closes the memory block.\n\n';
    writeFileSync(join(project, 'src', 'CLAUDE.md'), `${userText}<claude-mem-context>\nstale memory\n</claude-mem-context>\n`);
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
      const id = store.createSDKSession('content-tags', project, 'prompt');
      store.ensureMemorySessionIdRegistered(id, 'memory-tags');
      store.storeObservation('memory-tags', project, {
        type: 'discovery', title: 'Fresh direct child', subtitle: null, narrative: 'native fixture',
        facts: [], concepts: [], files_read: ['src/direct.ts'], files_modified: []
      }, 1, 0, 100);
      store.close();
      for (let run = 0; run < 2; run++) {
        const code = await generateClaudeMd(false);
        if (code !== 0) { process.exitCode = code; break; }
      }
    `], { cwd: project, env: { ...process.env, CLAUDE_MEM_DATA_DIR: data, CLAUDE_CONFIG_DIR: data, CLAUDE_MEM_TELEMETRY: '0' } });
    expect(child.exitCode).toBe(0);
    const claudeMd = readFileSync(join(project, 'src', 'CLAUDE.md'), 'utf8');
    expect(claudeMd.startsWith(`${userText}<claude-mem-context>\n`)).toBe(true);
    expect(claudeMd.split('tag closes the memory block').length).toBe(2);
    expect(claudeMd).toContain('Fresh direct child');
    expect(claudeMd).not.toContain('stale memory');
    // Spawns Bun and runs every migration on a fresh database: well past the
    // 5s default on a slow runner.
  }, 30_000);
});
