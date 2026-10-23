// The real project of a session, read without rewriting stored rows. Some
// sessions carry a project taken from an agent scratch folder (Codex desktop's
// ~/Documents/Codex/<date>/<slug>, the system temp folder) or from a folder
// outside any git repo. Those sessions take the git repo their tool calls
// touched most; a session that touched no repo joins the "no project" pool.
import { existsSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { getProjectContext, useGitRemoteProjectNames } from '../../utils/project-name.js';

/** The "no project" pool: a session whose tool calls touched no git repo. */
export const NO_PROJECT = '';

/** Worktrees of one repo share a root: the project key before its first `/`. With git-remote naming
 * (CLAUDE_MEM_PROJECT_NAME_SOURCE) every checkout already shares one `org/repo` key, and its slash
 * separates the owner from the repository, so the whole key is the root. */
export function projectRoot(project, gitRemoteNames = useGitRemoteProjectNames()) {
  if (typeof project !== 'string') return null;
  return gitRemoteNames ? project : project.split('/')[0];
}

/** A root saved before git-remote keys were kept whole ("acme" for acme/frontend) means the full key its
 * current members show: the anchor's, else the one `<saved>/…` key its members have. Other roots are kept. */
export function upgradedGroupRoot(savedRoot, anchorRoot, memberRoots = []) {
  if (typeof savedRoot !== 'string' || !savedRoot || savedRoot.includes('/')) return savedRoot;
  const widened = (root) => typeof root === 'string' && root.startsWith(`${savedRoot}/`);
  if (widened(anchorRoot)) return anchorRoot;
  const candidates = new Set(memberRoots.filter(widened));
  return candidates.size === 1 ? [...candidates][0] : savedRoot;
}

const realpathOrSelf = (path) => { try { return realpathSync(path); } catch { return path; } };
const TEMP_FOLDERS = [...new Set([resolve(tmpdir()), realpathOrSelf(resolve(tmpdir())), '/tmp', '/private/tmp'])];
const HOME = homedir();
/** Projects named after the temp folder ("T" on macOS) came from the temp folder itself. */
const TEMP_PROJECT_NAMES = new Set(TEMP_FOLDERS.map((folder) => basename(folder)).filter((name) => name && name !== 'tmp'));
const CODEX_SCRATCH = /[/\\]Documents[/\\]Codex[/\\]\d{4}-\d{2}-\d{2}(?:[/\\]|$)/;

export function isAgentScratchFolder(folder) {
  if (typeof folder !== 'string' || !folder) return false;
  if (CODEX_SCRATCH.test(folder)) return true;
  const absolute = resolve(folder);
  return TEMP_FOLDERS.some((temp) => absolute === temp || absolute.startsWith(`${temp}/`));
}

const repoRootCache = new Map();
/** The git checkout holding `path` (a `.git` folder or worktree file), or null. */
export function repoRootOf(path) {
  const visited = [];
  let current = resolve(path), found = null;
  for (;;) {
    if (repoRootCache.has(current)) { found = repoRootCache.get(current); break; }
    visited.push(current);
    if (existsSync(join(current, '.git'))) { found = current; break; }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const dir of visited) repoRootCache.set(dir, found);
  return found;
}

// A path starts with `/`, `~/` or, on Windows, a drive (`C:\`, `C:/`, `~\`).
const PATH_START = /(?:^|[\s"'`=:(])((?:~[/\\]|\/|[A-Za-z]:[/\\])[^\n\r"'`;|&<>()]*)/g;
// Agent tool and config folders (plugin marketplace clones, skills) are not the work's project.
const AGENT_HOMES = ['.claude', '.codex', '.gemini', '.claude-mem', '.cursor'].map((name) => join(HOME, name));
const isAgentHome = (path) => AGENT_HOMES.some((home) => path === home || path.startsWith(`${home}/`) || path.startsWith(`${home}\\`));
/** Absolute on this platform: `/…` everywhere, and a drive path (`C:\…`) on Windows. */
const isAbsoluteOn = (path, platform) => (path.startsWith('/') && !path.startsWith('//')) || (platform === 'win32' && /^[A-Za-z]:[/\\]/.test(path));
/** Absolute paths named in a tool call's input (file paths, commands, cwd). */
export function pathsIn(toolInput, platform = process.platform) {
  let parsed = toolInput;
  if (typeof toolInput === 'string') { try { parsed = JSON.parse(toolInput); } catch { parsed = toolInput; } }
  const strings = [];
  const walk = (value) => {
    if (typeof value === 'string') strings.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  walk(parsed);
  const paths = [];
  for (const text of strings) for (const match of text.matchAll(PATH_START)) {
    const raw = match[1].trim();
    const path = raw.startsWith('~/') || (platform === 'win32' && raw.startsWith('~\\')) ? join(HOME, raw.slice(2)) : raw;
    // Only absolute paths: a relative one would resolve against this process's folder.
    if (path.length > 1 && isAbsoluteOn(path, platform) && !isAgentHome(path)) paths.push(path);
  }
  return paths;
}

const checkoutForPath = (path) => {
  // A path with trailing arguments ("/repo/file.ts -la") resolves through its nearest real folder.
  let current = path;
  while (current !== dirname(current) && !existsSync(current)) current = dirname(current);
  return repoRootOf(current);
};

/** A session's folder is judged when it is outside any git repo, or when it
 * is a scratch folder that is gone. Any other folder that no longer exists
 * keeps its stored name (a deleted checkout is still that project). */
export function folderNeedsProject(folder, storedProject) {
  if (!folder) return TEMP_PROJECT_NAMES.has(storedProject);
  if (existsSync(folder)) return !repoRootOf(folder);
  return isAgentScratchFolder(folder);
}

/** The project the repo touched most names; NO_PROJECT when no call touched one.
 * Worktrees of one repo count together, and the most-touched checkout names it,
 * by the same rules (path, git-remote or environment) that name a session started there. */
export function projectFromToolPaths(toolInputs) {
  const byRoot = new Map(), nameOf = new Map();
  for (const input of toolInputs) for (const path of pathsIn(input)) {
    const checkout = checkoutForPath(path);
    if (!checkout) continue;
    if (!nameOf.has(checkout)) nameOf.set(checkout, getProjectContext(checkout).primary);
    const project = nameOf.get(checkout);
    const root = projectRoot(project);
    if (!byRoot.has(root)) byRoot.set(root, { count: 0, projects: new Map() });
    const entry = byRoot.get(root);
    entry.count++;
    entry.projects.set(project, (entry.projects.get(project) ?? 0) + 1);
  }
  let best = null;
  for (const entry of byRoot.values()) if (!best || entry.count > best.count) best = entry;
  if (!best) return NO_PROJECT;
  return [...best.projects].sort((a, b) => b[1] - a[1])[0][0];
}

function safeAll(database, sql, params) {
  try { return database.prepare(sql).all(...params); }
  catch (error) { if (/no such (table|column)/i.test(String(error.message))) return null; throw error; }
}

// Derived projects stay until the session records another tool call.
const derivedCache = new Map();
const TOOL_SAMPLE = 400;

/** sessionId → derived project, for the given sessions that need one. Stored rows are not changed. */
export function deriveSessionProjects(database, sessions) {
  const result = new Map();
  const ids = [...new Set(sessions.map((session) => session.id).filter((id) => id != null))];
  if (!ids.length) return result;
  const folders = new Map();
  for (let index = 0; index < ids.length; index += 500) {
    const chunk = ids.slice(index, index + 500);
    const rows = safeAll(database, `SELECT id, cwd FROM sdk_sessions WHERE id IN (${chunk.map(() => '?').join(',')})`, chunk);
    if (rows === null) return result;
    for (const row of rows) folders.set(row.id, row.cwd || null);
  }
  // A session without a recorded folder is judged by the folders other sessions of its project recorded.
  const unknownFolderProjects = [...new Set(sessions.filter((session) => folders.has(session.id) && !folders.get(session.id) && typeof session.project === 'string').map((session) => session.project))];
  const scratchProjects = new Set();
  for (let index = 0; index < unknownFolderProjects.length; index += 500) {
    const chunk = unknownFolderProjects.slice(index, index + 500);
    for (const row of safeAll(database, `SELECT DISTINCT project, cwd FROM sdk_sessions WHERE project IN (${chunk.map(() => '?').join(',')}) AND cwd IS NOT NULL AND cwd <> ''`, chunk) ?? []) {
      if (isAgentScratchFolder(row.cwd)) scratchProjects.add(row.project);
    }
  }
  const needing = sessions.filter((session) => folders.has(session.id) && (folders.get(session.id) ? folderNeedsProject(folders.get(session.id), session.project) : folderNeedsProject(null, session.project) || scratchProjects.has(session.project)));
  if (!needing.length) return result;
  const needIds = [...new Set(needing.map((session) => session.id))];
  const heads = new Map();
  for (let index = 0; index < needIds.length; index += 500) {
    const chunk = needIds.slice(index, index + 500);
    for (const row of safeAll(database, `SELECT session_db_id, MAX(id) AS head FROM tool_uses WHERE session_db_id IN (${chunk.map(() => '?').join(',')}) GROUP BY session_db_id`, chunk) ?? []) heads.set(row.session_db_id, row.head);
  }
  for (const id of needIds) {
    const head = heads.get(id) ?? 0;
    const cached = derivedCache.get(id);
    if (cached && cached.head === head) { result.set(id, cached.project); continue; }
    const calls = head ? safeAll(database, `SELECT substr(tool_input, 1, 4000) AS tool_input, cwd FROM tool_uses WHERE session_db_id = ? ORDER BY id DESC LIMIT ${TOOL_SAMPLE}`, [id]) ?? [] : [];
    const project = projectFromToolPaths(calls.flatMap((call) => [call.tool_input, ...(call.cwd ? [JSON.stringify({ cwd: call.cwd })] : [])]));
    derivedCache.set(id, { head, project });
    result.set(id, project);
  }
  return result;
}

/** Copies of `sessions` whose project is the derived one, with the stored one kept beside it. */
export function withDerivedProjects(database, sessions) {
  const derived = deriveSessionProjects(database, sessions);
  if (!derived.size) return sessions;
  return sessions.map((session) => derived.has(session.id) ? { ...session, project: derived.get(session.id), storedProject: session.project } : session);
}
