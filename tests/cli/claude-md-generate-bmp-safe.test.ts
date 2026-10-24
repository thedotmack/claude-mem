import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';

const repoRoot = join(import.meta.dir, '..', '..');
const source = (file: string) => pathToFileURL(join(repoRoot, 'src', file)).href;
const sandboxes: string[] = [];
afterEach(() => { for (const root of sandboxes.splice(0)) rmSync(root, { recursive: true, force: true }); });

// #2787: the managed block is auto-loaded context, and a Claude Code truncation
// can cut it inside a surrogate pair. `claude-mem generate` wrote observation
// titles as they were, so an emoji in a title put a pair into the CLAUDE.md.
describe('claude-mem generate writes a BMP-only CLAUDE.md block', () => {
  it('replaces an astral character in an observation title', () => {
    const root = mkdtempSync(join(tmpdir(), 'claude-md-bmp-')); sandboxes.push(root);
    const project = join(root, 'project'); const data = join(root, 'data');
    mkdirSync(join(project, 'src'), { recursive: true }); mkdirSync(data);
    writeFileSync(join(project, 'src', 'direct.ts'), 'export {};');
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
      const id = store.createSDKSession('content-bmp', project, 'prompt');
      store.ensureMemorySessionIdRegistered(id, 'memory-bmp');
      store.storeObservation('memory-bmp', project, {
        type: 'feature', title: 'Ship the \u{1F680} release', subtitle: null, narrative: 'native fixture',
        facts: [], concepts: [], files_read: ['src/direct.ts'], files_modified: []
      }, 1, 0, 100);
      store.close();
      process.exitCode = await generateClaudeMd(false);
    `], { cwd: project, env: { ...process.env, CLAUDE_MEM_DATA_DIR: data, CLAUDE_CONFIG_DIR: data, CLAUDE_MEM_TELEMETRY: '0' } });
    expect(child.exitCode).toBe(0);
    const claudeMd = readFileSync(join(project, 'src', 'CLAUDE.md'), 'utf8');
    expect(claudeMd).toContain('Ship the • release');
    expect([...claudeMd].filter(ch => ch.codePointAt(0)! > 0xffff)).toEqual([]);
    // Spawns Bun and runs every migration on a fresh database: well past the
    // 5s default on a slow runner.
  }, 30_000);

  it('also holds for `npm run claude-md:regenerate`, whose type markers are emoji', () => {
    const root = mkdtempSync(join(tmpdir(), 'claude-md-bmp-')); sandboxes.push(root);
    const project = join(root, 'project'); const data = join(root, '.claude-mem');
    mkdirSync(join(project, 'src'), { recursive: true }); mkdirSync(data);
    writeFileSync(join(project, 'src', 'direct.ts'), 'export {};');
    for (const args of [['init', '-q'], ['add', 'src/direct.ts']]) {
      const git = Bun.spawnSync(['git', ...args], { cwd: project }); expect(git.exitCode).toBe(0);
    }
    // The script reads ~/.claude-mem/claude-mem.db, so HOME points at the sandbox.
    const env = { ...process.env, HOME: root, CLAUDE_MEM_DATA_DIR: data, CLAUDE_CONFIG_DIR: data, CLAUDE_MEM_TELEMETRY: '0' };
    const seed = Bun.spawnSync([process.execPath, '-e', `
      const { SessionStore } = await import(${JSON.stringify(source('services/sqlite/SessionStore.ts'))});
      const { paths } = await import(${JSON.stringify(source('shared/paths.ts'))});
      const { getProjectContext } = await import(${JSON.stringify(source('utils/project-name.ts'))});
      const store = new SessionStore(paths.database());
      const project = getProjectContext(process.cwd()).primary;
      const id = store.createSDKSession('content-bmp', project, 'prompt');
      store.ensureMemorySessionIdRegistered(id, 'memory-bmp');
      store.storeObservation('memory-bmp', project, {
        type: 'feature', title: 'Ship the \u{1F680} release', subtitle: null, narrative: 'native fixture',
        facts: [], concepts: [], files_read: ['src/direct.ts'], files_modified: []
      }, 1, 0, 100);
      store.close();
    `], { cwd: project, env });
    expect(seed.exitCode).toBe(0);
    const run = Bun.spawnSync([process.execPath, join(repoRoot, 'scripts', 'regenerate-claude-md.ts')], { cwd: project, env });
    expect(run.exitCode).toBe(0);
    const claudeMd = readFileSync(join(project, 'src', 'CLAUDE.md'), 'utf8');
    expect(claudeMd).toContain('Ship the • release');
    expect([...claudeMd].filter(ch => ch.codePointAt(0)! > 0xffff)).toEqual([]);
  }, 30_000);
});
