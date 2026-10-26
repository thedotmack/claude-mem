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
  it('includes direct children recorded as absolute tool paths', () => {
    // Read/Edit/Write tool inputs store absolute file paths, while generate
    // looks folders up by their project-relative path.
    const root = mkdtempSync(join(tmpdir(), 'claude-md-abs-')); sandboxes.push(root);
    const project = join(root, 'project'); const data = join(root, 'data');
    mkdirSync(join(project, 'src', 'auth'), { recursive: true }); mkdirSync(data);
    writeFileSync(join(project, 'src', 'auth', 'login.ts'), 'export {};');
    for (const args of [['init', '-q'], ['add', 'src/auth/login.ts']]) {
      const git = Bun.spawnSync(['git', ...args], { cwd: project }); expect(git.exitCode).toBe(0);
    }
    const child = Bun.spawnSync([process.execPath, '-e', `
      const { SessionStore } = await import(${JSON.stringify(source('services/sqlite/SessionStore.ts'))});
      const { paths } = await import(${JSON.stringify(source('shared/paths.ts'))});
      const { getProjectContext } = await import(${JSON.stringify(source('utils/project-name.ts'))});
      const { generateClaudeMd } = await import(${JSON.stringify(source('cli/claude-md-commands.ts'))});
      const store = new SessionStore(paths.database());
      const project = getProjectContext(process.cwd()).primary;
      const files = [
        ['Absolute-path edit', ${JSON.stringify(join(project, 'src', 'auth', 'login.ts'))}],
        ['Relative-path edit', 'src/auth/login.ts'],
        ['Backslash-path edit', 'src\\\\auth\\\\login.ts'],
        ['Other package with the same folder name', ${JSON.stringify(join(project, 'packages', 'widget', 'src', 'auth', 'button.ts'))}],
        ['Edit from another checkout of the project', ${JSON.stringify(join(root, 'old-clone', 'src', 'auth', 'login.ts'))}],
      ];
      files.forEach(([title, file], i) => {
        const memory = 'memory-' + i;
        const id = store.createSDKSession('content-' + i, project, 'prompt');
        store.ensureMemorySessionIdRegistered(id, memory);
        store.storeObservation(memory, project, {
          type: 'discovery', title,
          subtitle: null, narrative: 'native fixture', facts: [], concepts: [],
          files_read: [], files_modified: [file]
        }, 1, 0, 100 + i);
      });
      store.close(); process.exitCode = await generateClaudeMd(false);
    `], { cwd: project, env: { ...process.env, CLAUDE_MEM_DATA_DIR: data, CLAUDE_CONFIG_DIR: data, CLAUDE_MEM_TELEMETRY: '0' } });
    expect(child.exitCode).toBe(0);
    const context = readFileSync(join(project, 'src', 'auth', 'CLAUDE.md'), 'utf8');
    expect(context).toContain('Absolute-path edit');
    expect(context).toContain('Relative-path edit');
    expect(context).toContain('Backslash-path edit');
    // An absolute path elsewhere in the checkout that merely ends in src/auth is not a child.
    expect(context).not.toContain('Other package with the same folder name');
    // A checkout elsewhere that shares the project key keeps its history.
    expect(context).toContain('Edit from another checkout of the project');
  }, 30_000);
  it('lists days newest-first, matching the newest-first rows', () => {
    const root = mkdtempSync(join(tmpdir(), 'claude-md-days-')); sandboxes.push(root);
    const project = join(root, 'project'); const data = join(root, 'data');
    mkdirSync(join(project, 'src'), { recursive: true }); mkdirSync(data);
    writeFileSync(join(project, 'src', 'day.ts'), 'export {};');
    for (const args of [['init', '-q'], ['add', 'src/day.ts']]) {
      const git = Bun.spawnSync(['git', ...args], { cwd: project }); expect(git.exitCode).toBe(0);
    }
    // Noon UTC, one day apart: two distinct local days in any time zone.
    const olderEpoch = Date.UTC(2026, 9, 16, 12); const newerEpoch = Date.UTC(2026, 9, 17, 12);
    const child = Bun.spawnSync([process.execPath, '-e', `
      const { SessionStore } = await import(${JSON.stringify(source('services/sqlite/SessionStore.ts'))});
      const { paths } = await import(${JSON.stringify(source('shared/paths.ts'))});
      const { getProjectContext } = await import(${JSON.stringify(source('utils/project-name.ts'))});
      const { generateClaudeMd } = await import(${JSON.stringify(source('cli/claude-md-commands.ts'))});
      const store = new SessionStore(paths.database());
      const project = getProjectContext(process.cwd()).primary;
      [['Older day edit', ${olderEpoch}], ['Newer day edit', ${newerEpoch}]].forEach(([title, epoch], i) => {
        const memory = 'memory-' + i;
        const id = store.createSDKSession('content-' + i, project, 'prompt');
        store.ensureMemorySessionIdRegistered(id, memory);
        store.storeObservation(memory, project, {
          type: 'discovery', title,
          subtitle: null, narrative: 'native fixture', facts: [], concepts: [],
          files_read: [], files_modified: ['src/day.ts']
        }, 1, 0, epoch);
      });
      store.close(); process.exitCode = await generateClaudeMd(false);
    `], { cwd: project, env: { ...process.env, CLAUDE_MEM_DATA_DIR: data, CLAUDE_CONFIG_DIR: data, CLAUDE_MEM_TELEMETRY: '0' } });
    expect(child.exitCode).toBe(0);
    const context = readFileSync(join(project, 'src', 'CLAUDE.md'), 'utf8');
    const dayHeaders = [...context.matchAll(/^### (.+)$/gm)].map(match => match[1]);
    expect(dayHeaders).toHaveLength(2);
    expect(context.indexOf('Newer day edit')).toBeLessThan(context.indexOf('Older day edit'));
    expect(context.indexOf(`### ${dayHeaders[0]}`)).toBeLessThan(context.indexOf('Newer day edit'));
    expect(context.indexOf('Older day edit')).toBeGreaterThan(context.indexOf(`### ${dayHeaders[1]}`));
  }, 30_000);
});
