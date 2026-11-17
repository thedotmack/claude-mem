import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repo = join(import.meta.dir, '..', '..');
const originalConfig = '# Keep this profile\nmemory:\n  provider: honcho\nmodel:\n  default: account-model\n';
let root: string;
let home: string;
let project: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hermes-command-'));
  home = join(root, 'profile');
  project = join(root, 'project with spaces');
  mkdirSync(home);
  mkdirSync(project);
  writeFileSync(join(home, 'config.yaml'), originalConfig);
  writeFileSync(join(home, 'MEMORY.md'), 'Keep native memories.');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function run(args: string[]) {
  return spawnSync(process.execPath, [join(repo, 'src/npx-cli/index.ts'), 'hermes', ...args], {
    cwd: repo,
    env: {
      ...process.env,
      HERMES_HOME: home,
      CLAUDE_CONFIG_DIR: join(root, 'claude'),
      CLAUDE_PLUGIN_ROOT: repo,
      CLAUDE_MEM_DATA_DIR: join(root, 'worker'),
    },
    encoding: 'utf8',
    timeout: 30_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

describe('Hermes dedicated command', () => {
  it.each([
    ['install'],
    ['install', '--mcp-only'],
    ['install', '--project-cwd', 'relative'],
    ['install', '--mcp-only', '--project-cwd', 'relative'],
    ['install', '--mcp-only', '--project-cwd'],
    ['install', '--mcp-only', '--unknown'],
    ['uninstall', '--mcp-only'],
    ['install', 'unexpected'],
    ['unsupported'],
  ])('rejects invalid arguments before touching the selected profile: %j', (...args) => {
    const result = run(args);
    expect(result.status).toBe(1);
    expect(readFileSync(join(home, 'config.yaml'), 'utf8')).toBe(originalConfig);
    expect(readdirSync(home).sort()).toEqual(['MEMORY.md', 'config.yaml']);
  });

  it('rejects missing directories and files as the project cwd without editing config', () => {
    for (const cwd of [join(root, 'missing'), join(home, 'config.yaml')]) {
      expect(run(['install', '--mcp-only', '--project-cwd', cwd]).status).toBe(1);
      expect(readFileSync(join(home, 'config.yaml'), 'utf8')).toBe(originalConfig);
      expect(existsSync(join(home, 'plugins'))).toBe(false);
    }
  });

  it('routes MCP-only setup and disconnect through the shared installer', () => {
    const args = ['install', '--mcp-only', '--project-cwd', project];
    const installed = run(args);
    expect(installed.status).toBe(0);
    const first = readFileSync(join(home, 'config.yaml'), 'utf8');
    const config = Bun.YAML.parse(first) as any;
    expect(config.memory.provider).toBe('honcho');
    expect(config.mcp_servers['claude-mem'].cwd).toBe(project);
    expect(existsSync(join(home, 'plugins/claude-mem/__init__.py'))).toBe(false);
    expect(run(args).status).toBe(0);
    expect(readFileSync(join(home, 'config.yaml'), 'utf8')).toBe(first);
    expect(run(['uninstall']).status).toBe(0);
    expect(readFileSync(join(home, 'config.yaml'), 'utf8')).toBe(originalConfig);
    expect(readFileSync(join(home, 'MEMORY.md'), 'utf8')).toBe('Keep native memories.');
  });
});
