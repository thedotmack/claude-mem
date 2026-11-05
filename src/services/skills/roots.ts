import { Database } from 'bun:sqlite';
import { execFile } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { isProjectExcluded } from '../../utils/project-filter.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { CLAUDE_CONFIG_DIR, USER_SETTINGS_PATH } from '../../shared/paths.js';
import { isAgentScratchFolder, repoRootOf } from '../work-view/session-project.mjs';
import { sha256 } from './files.js';

import type { SkillAgent, SkillScope, ScanIssue } from '../../shared/skill-document.js';
export type { SkillAgent, SkillScope, ScanIssue } from '../../shared/skill-document.js';
export interface SkillRoot {
  path: string;
  agent: SkillAgent;
  scope: SkillScope;
  label: string;
  /** Portable identifier; unpaired custom roots and repositories without remotes need an explicit binding. */
  portableRoot: string | null;
}
export interface SkillCatalogOptions {
  home?: string;
  claudeConfigDir?: string;
  extraFolders?: string[];
  projectDirectories?: () => string[];
  databasePath?: string;
  excludedProjects?: string;
}

const runGit = promisify(execFile);
const AGENTS = [['claude', '.claude'], ['codex', '.agents']] as const;

export function excludedPath(file: string): boolean {
  const pieces = file.toLowerCase().split(path.sep);
  return pieces.some((part, i) => ['.git', '.trash', 'node_modules', '.system', 'builtins', 'managed-settings', 'remote-skills', 'managed-skills'].includes(part)
    || part === 'synced' && pieces[i - 1] === 'skills'
    || part === 'plugins' && ['cache', 'marketplaces'].includes(pieces[i + 1]));
}

/** sdk_sessions.cwd is written from real local sessions; downloaded sync stubs have no cwd. */
function recentDirectories(databasePath?: string): string[] {
  if (!databasePath) return [];
  const db = new Database(databasePath, { readonly: true, create: false });
  try {
    const rows = db.query<{ cwd: string }, []>(
      "SELECT cwd FROM sdk_sessions WHERE cwd IS NOT NULL AND cwd <> '' GROUP BY cwd ORDER BY MAX(id) DESC LIMIT 129"
    ).all();
    return rows.map(row => row.cwd);
  } finally { db.close(); }
}

async function portableRepository(checkout: string): Promise<string | null> {
  try {
    const { stdout } = await runGit('git', ['config', '--local', '--get', 'remote.origin.url'], { cwd: checkout, timeout: 1200, maxBuffer: 4096 });
    // Strip embedded credentials. A file remote cannot identify a repo across devices.
    const remote = stdout.trim();
    if (path.isAbsolute(remote) || remote.startsWith('file:') || /^[A-Za-z]:[\\/]/.test(remote)) return null;
    const scp = !remote.includes('://') && /^(?:[^@/\s]+@)?([^/:\s]+):(.+)$/.exec(remote);
    const url = new URL(scp ? 'ssh://' + scp[1] + '/' + scp[2] : remote);
    if (!['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol)) return null;
    return sha256(url.host.toLowerCase() + url.pathname.replace(/\/+$/, '').replace(/\.git$/i, ''));
  } catch { return null; }
}

export async function skillRoots(options: SkillCatalogOptions, issues: ScanIssue[]): Promise<SkillRoot[]> {
  const homePath = options.home ?? homedir();
  const home = await realpath(homePath).catch(() => path.resolve(homePath));
  const claudeDir = options.claudeConfigDir ?? (process.env.CLAUDE_CONFIG_DIR && !options.home ? CLAUDE_CONFIG_DIR : path.join(home, '.claude'));
  const roots: SkillRoot[] = [
    { path: path.resolve(claudeDir, 'skills'), agent: 'claude', scope: 'personal', label: 'Claude Code · Personal', portableRoot: 'personal:claude' },
    { path: path.resolve(home, '.agents', 'skills'), agent: 'codex', scope: 'personal', label: 'Codex · Personal', portableRoot: 'personal:codex' },
  ];
  const known = new Set(roots.map(root => root.path));
  let directories: string[] = [];
  try { directories = options.projectDirectories?.() ?? recentDirectories(options.databasePath); }
  catch { issues.push({ source: 'Projects', message: 'Could not read known local projects.' }); }
  if (directories.length > 128) issues.push({ source: 'Projects', message: 'Showing the 128 most recently used project folders.' });
  const exclusions = options.excludedProjects ?? SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH, true, { readOnly: true }).CLAUDE_MEM_EXCLUDED_PROJECTS;
  const repos = new Map<string, string | null>();
  for (const hint of new Set(directories.slice(0, 128))) {
    if (!path.isAbsolute(hint) || isAgentScratchFolder(hint) || excludedPath(hint)) continue;
    let directory: string;
    try { directory = await realpath(hint); if (!(await stat(directory)).isDirectory()) continue; }
    catch { continue; }
    if (isAgentScratchFolder(directory) || excludedPath(directory)) continue;
    const checkout = repoRootOf(directory);
    if (!checkout || isProjectExcluded(directory, exclusions) || isProjectExcluded(checkout, exclusions)) continue;
    for (let depth = 0; depth < 64; depth++) {
      for (const [agent, config] of AGENTS) {
        const root = path.join(directory, config, 'skills');
        if (known.has(root)) continue;
        known.add(root);
        try { if (!(await stat(root)).isDirectory()) continue; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') issues.push({ source: root, message: 'Cannot inspect project skill folder.' });
          continue;
        }
        if (!repos.has(checkout)) repos.set(checkout, await portableRepository(checkout));
        const repo = repos.get(checkout);
        const subdirectory = path.relative(checkout, directory).split(path.sep).join('/');
        roots.push({ path: root, scope: 'project', agent, label: path.basename(checkout) + (subdirectory ? '/' + subdirectory : ''),
          portableRoot: repo ? 'project:' + repo + ':' + agent + ':' + subdirectory : null });
      }
      if (directory === checkout || directory === path.dirname(directory)) break;
      directory = path.dirname(directory);
    }
  }
  const extraFolders = options.extraFolders ?? (process.env.EXTRA_SKILL_FOLDERS ?? '').split(path.delimiter);
  for (const folder of extraFolders.filter(folder => folder.trim()).slice(0, 128)) {
    const root = path.resolve(folder.trim());
    if (known.has(root) || excludedPath(root)) continue;
    known.add(root);
    roots.push({ path: root, agent: 'custom', scope: 'configured', label: path.basename(root), portableRoot: null });
  }
  return roots;
}
