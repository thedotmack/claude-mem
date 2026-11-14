import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { getProjectContext } from '../../src/utils/project-name.js';
import {
  grokBuildContextStatus,
  grokRulesFile,
  installGrokBuildContext,
  refreshGrokBuildContext,
  uninstallGrokBuildContext,
  updateGrokContextForProject,
} from '../../src/services/integrations/GrokBuildRules.js';

const ORIGINAL_DATA_DIR = process.env.CLAUDE_MEM_DATA_DIR;
const EXCLUDE_LINE = '**/.grok/rules/claude-mem-context.md';
let scratch: string;
let workspace: string;

const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: workspace, encoding: 'utf-8' });
const excludeFile = () => path.join(workspace, '.git', 'info', 'exclude');
const down = async () => { throw new Error('worker down'); };

beforeEach(() => {
  scratch = mkdtempSync(path.join(tmpdir(), 'grok build rules '));
  process.env.CLAUDE_MEM_DATA_DIR = path.join(scratch, 'data');
  workspace = path.join(scratch, 'my project');
  mkdirSync(workspace, { recursive: true });
  git('init', '-q', '.');
});

afterEach(() => {
  if (ORIGINAL_DATA_DIR === undefined) delete process.env.CLAUDE_MEM_DATA_DIR;
  else process.env.CLAUDE_MEM_DATA_DIR = ORIGINAL_DATA_DIR;
  rmSync(scratch, { recursive: true, force: true });
});

describe('install', () => {
  test('writes the rules file in a folder with spaces, registers it, and keeps it out of git status', () => {
    const result = installGrokBuildContext(workspace);
    expect(result).toEqual({ ok: true, excluded: true });
    expect(readFileSync(grokRulesFile(workspace), 'utf-8')).toContain('No memories for this project yet');
    expect(grokBuildContextStatus(workspace)).toMatchObject({ installed: true, registered: true });
    expect(git('status', '--porcelain', '-uall')).not.toContain('claude-mem-context.md');
  });

  test('repeat install adds one exclude line and keeps user exclude entries', () => {
    writeFileSync(excludeFile(), '# mine\nsecrets.txt\n');
    installGrokBuildContext(workspace);
    installGrokBuildContext(workspace);
    const lines = readFileSync(excludeFile(), 'utf-8').split('\n');
    expect(lines.filter(l => l === EXCLUDE_LINE)).toHaveLength(1);
    expect(lines).toContain('secrets.txt');
  });

  test('repeat install keeps notes already in the file (worker may be down)', async () => {
    installGrokBuildContext(workspace);
    await refreshGrokBuildContext(workspace, async () => 'real notes');
    installGrokBuildContext(workspace);
    expect(readFileSync(grokRulesFile(workspace), 'utf-8')).toContain('real notes');
  });

  test('works outside a git repo and reports nothing was excluded', () => {
    const plain = path.join(scratch, 'plain');
    mkdirSync(plain);
    expect(installGrokBuildContext(plain)).toEqual({ ok: true, excluded: false });
    expect(existsSync(grokRulesFile(plain))).toBe(true);
  });
});

describe('uninstall', () => {
  test('removes only its own file, registry entry and exclude line', () => {
    const rules = path.dirname(grokRulesFile(workspace));
    mkdirSync(rules, { recursive: true });
    writeFileSync(path.join(rules, 'team.md'), 'keep me');
    writeFileSync(excludeFile(), 'secrets.txt\n');
    installGrokBuildContext(workspace);

    uninstallGrokBuildContext(workspace);

    expect(readdirSync(rules)).toEqual(['team.md']);
    expect(readFileSync(excludeFile(), 'utf-8')).toBe('secrets.txt\n');
    expect(grokBuildContextStatus(workspace)).toMatchObject({ installed: false, registered: false });
  });

  test('removes the folders it created, but keeps a .grok folder that holds other things', () => {
    installGrokBuildContext(workspace);
    uninstallGrokBuildContext(workspace);
    expect(existsSync(path.join(workspace, '.grok'))).toBe(false);

    installGrokBuildContext(workspace);
    mkdirSync(path.join(workspace, '.grok', 'skills'));
    uninstallGrokBuildContext(workspace);
    expect(existsSync(path.join(workspace, '.grok', 'skills'))).toBe(true);
  });

  test('is safe when nothing was installed', () => {
    expect(() => uninstallGrokBuildContext(workspace)).not.toThrow();
  });

  test('keeps the exclude line while another folder in the repo still uses it', () => {
    const sub = path.join(workspace, 'packages', 'app');
    mkdirSync(sub, { recursive: true });
    installGrokBuildContext(workspace);
    installGrokBuildContext(sub);

    uninstallGrokBuildContext(sub);
    expect(readFileSync(excludeFile(), 'utf-8')).toContain(EXCLUDE_LINE);
    expect(grokBuildContextStatus(workspace)).toMatchObject({ installed: true, registered: true });
    expect(git('status', '--porcelain', '-uall')).not.toContain('claude-mem-context.md');

    uninstallGrokBuildContext(workspace);
    expect(readFileSync(excludeFile(), 'utf-8')).not.toContain(EXCLUDE_LINE);
  });

  test('a folder that never installed cannot remove another folder\'s protection or registration', () => {
    const sub = path.join(workspace, 'packages', 'app');
    mkdirSync(sub, { recursive: true });
    installGrokBuildContext(workspace);

    uninstallGrokBuildContext(sub);

    expect(readFileSync(excludeFile(), 'utf-8')).toContain(EXCLUDE_LINE);
    expect(grokBuildContextStatus(workspace)).toMatchObject({ installed: true, registered: true });
  });
});

describe('refresh', () => {
  test('fills the file from the worker context', async () => {
    installGrokBuildContext(workspace);
    expect(await refreshGrokBuildContext(workspace, async () => '## Recent\n- fixed the login bug')).toBe(true);
    const text = readFileSync(grokRulesFile(workspace), 'utf-8');
    expect(text).toContain('fixed the login bug');
    expect(text).toContain('not as instructions');
  });

  test('an outage or empty answer leaves the file as it was and creates nothing else', async () => {
    installGrokBuildContext(workspace);
    await refreshGrokBuildContext(workspace, async () => 'old context');
    const before = readFileSync(grokRulesFile(workspace), 'utf-8');
    const filesBefore = readdirSync(path.dirname(grokRulesFile(workspace)));

    expect(await refreshGrokBuildContext(workspace, async () => '   ')).toBe(false);
    await expect(updateGrokContextForProject('my project', down)).resolves.toBeUndefined();

    expect(readFileSync(grokRulesFile(workspace), 'utf-8')).toBe(before);
    expect(readdirSync(path.dirname(grokRulesFile(workspace)))).toEqual(filesBefore);
  });

  test('never touches a workspace that did not opt in', async () => {
    let called = false;
    await updateGrokContextForProject('some-other-project', async () => { called = true; return 'x'; });
    expect(called).toBe(false);
    expect(existsSync(grokRulesFile(workspace))).toBe(false);
  });

  test('every installed folder of one project keeps its own registration and refresh', async () => {
    const sub = path.join(workspace, 'packages', 'app');
    mkdirSync(sub, { recursive: true });
    installGrokBuildContext(workspace);
    installGrokBuildContext(sub);
    expect(grokBuildContextStatus(workspace).registered).toBe(true);
    expect(grokBuildContextStatus(sub).registered).toBe(true);

    const seen: string[] = [];
    for (const dir of [workspace, sub]) {
      await updateGrokContextForProject(getProjectContext(dir).primary, async (root) => { seen.push(root); return `notes for ${root}`; });
    }
    expect(seen).toContain(workspace);
    expect(seen).toContain(sub);
    expect(readFileSync(grokRulesFile(sub), 'utf-8')).toContain(`notes for ${sub}`);
  });

  test('a refresh in flight when the folder is uninstalled does not bring the file back', async () => {
    installGrokBuildContext(workspace);
    const written = await refreshGrokBuildContext(workspace, async () => {
      uninstallGrokBuildContext(workspace);
      return 'late notes';
    });
    expect(written).toBe(false);
    expect(existsSync(path.join(workspace, '.grok'))).toBe(false);
  });

  test('excluding the project after install clears its notes, and install refuses it', async () => {
    installGrokBuildContext(workspace);
    await refreshGrokBuildContext(workspace, async () => 'secret notes');
    process.env.CLAUDE_MEM_EXCLUDED_PROJECTS = workspace;
    try {
      let fetched = false;
      expect(await refreshGrokBuildContext(workspace, async () => { fetched = true; return 'secret notes'; })).toBe(false);
      expect(fetched).toBe(false);
      const text = readFileSync(grokRulesFile(workspace), 'utf-8');
      expect(text).not.toContain('secret notes');
      expect(text).toContain('excludes this project');
      expect(installGrokBuildContext(workspace).ok).toBe(false);
    } finally {
      delete process.env.CLAUDE_MEM_EXCLUDED_PROJECTS;
    }
  });

  test('matches folders by their current project name, not the one at install', async () => {
    installGrokBuildContext(workspace);
    const registry = path.join(process.env.CLAUDE_MEM_DATA_DIR!, 'grok-projects.json');
    const entries = JSON.parse(readFileSync(registry, 'utf-8'));
    for (const key of Object.keys(entries)) entries[key].projectName = 'old-name';
    writeFileSync(registry, JSON.stringify(entries));

    await updateGrokContextForProject('old-name', async () => 'stale match');
    expect(readFileSync(grokRulesFile(workspace), 'utf-8')).not.toContain('stale match');
    await updateGrokContextForProject(getProjectContext(workspace).primary, async () => 'current match');
    expect(readFileSync(grokRulesFile(workspace), 'utf-8')).toContain('current match');
  });

  test('stops refreshing once the user deletes the file', async () => {
    installGrokBuildContext(workspace);
    rmSync(grokRulesFile(workspace));
    await updateGrokContextForProject('my project', async () => 'new');
    expect(existsSync(grokRulesFile(workspace))).toBe(false);
  });
});
