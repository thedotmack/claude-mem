import { expect } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { pathToFileURL } from 'url';

const repoRoot = join(import.meta.dir, '..', '..');
const source = (file: string) => pathToFileURL(join(repoRoot, 'src', file)).href;
const sandboxes: string[] = [];
export function cleanupGeneratedProjects(): void {
  for (const root of sandboxes.splice(0)) rmSync(root, { recursive: true, force: true });
}

export function generateIn({ files, settings = {}, seed, writer = 'generate', runs = 1 }: {
  files: string[];
  settings?: Record<string, string>;
  seed: string | ((paths: { root: string; project: string }) => string);
  writer?: 'generate' | 'regenerate';
  runs?: number;
}): string {
  const root = mkdtempSync(join(tmpdir(), 'claude-md-generate-')); sandboxes.push(root);
  const project = join(root, 'project'); const data = join(root, 'data');
  mkdirSync(data);
  for (const file of files) {
    mkdirSync(dirname(join(project, file)), { recursive: true });
    writeFileSync(join(project, file), 'export {};');
  }
  writeFileSync(join(data, 'settings.json'), JSON.stringify(settings));
  for (const args of [['init', '-q'], ['add', ...files]]) {
    expect(Bun.spawnSync(['git', ...args], { cwd: project }).exitCode).toBe(0);
  }
  const env: Record<string, string | undefined> = { ...process.env, CLAUDE_MEM_DATA_DIR: data, CLAUDE_CONFIG_DIR: data, CLAUDE_MEM_TELEMETRY: '0' };
  for (const key of Object.keys(settings)) delete env[key];
  if (writer === 'regenerate') { env.HOME = root; env.USERPROFILE = root; }
  const child = Bun.spawnSync([process.execPath, '-e', `
    const { SessionStore } = await import(${JSON.stringify(source('services/sqlite/SessionStore.ts'))});
    const { paths } = await import(${JSON.stringify(source('shared/paths.ts'))});
    const { getProjectContext } = await import(${JSON.stringify(source('utils/project-name.ts'))});
    const { generateClaudeMd } = await import(${JSON.stringify(source('cli/claude-md-commands.ts'))});
    const store = new SessionStore(paths.database());
    const project = getProjectContext(process.cwd()).primary;
    ${typeof seed === 'function' ? seed({ root, project }) : seed}
    store.close();
    ${writer === 'generate' ? `for (let run = 0; run < ${runs}; run++) {
      const code = await generateClaudeMd(false);
      if (code !== 0) { process.exitCode = code; break; }
    }` : ''}
  `], { cwd: project, env });
  expect(child.exitCode).toBe(0);
  if (writer === 'regenerate') {
    expect(Bun.spawnSync([process.execPath, join(repoRoot, 'scripts', 'regenerate-claude-md.ts')], { cwd: project, env }).exitCode).toBe(0);
  }
  return project;
}
