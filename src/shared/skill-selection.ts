/** Reversible, install-local skill selection. Never edits the published package. */
import { type Stats, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, writeFileSync } from 'fs';
import { randomUUID } from 'crypto';
import { dirname, join, relative, resolve, sep } from 'path';
import { parseJsonWithBom } from './atomic-json.js';
import { settingsTarget } from './settings-document-shape.js';
import { resolveDataDir } from './data-dir.js';
import { marketplaceDirectory, pluginsDirectory } from './claude-code-plugin-paths.js';

export const DISABLED_SKILLS_DIRECTORY = '.claude-mem-disabled-skills';
const SETTING = 'CLAUDE_MEM_SKILLS_DISABLED';
const OWNER_FILE = '.owner';
const OWNER = 'claude-mem disabled skills v1\n';
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface SkillSelectionResult {
  disabled: string[];
  enabled: string[];
  warnings: string[];
}

/** A comma-separated string, or an array in a hand-edited settings.json. */
export function parseDisabledSkills(value: unknown): Set<string> {
  if (value === undefined) return new Set();
  const entries = typeof value === 'string' ? value.split(',') : value;
  if (!Array.isArray(entries) || entries.some(entry => typeof entry !== 'string')) {
    throw new Error(`${SETTING} must be a comma-separated string or an array of skill names`);
  }
  const names = entries.map(entry => entry.trim()).filter(Boolean);
  // Validate the entire list before touching any file. No globs, namespaces,
  // paths, Windows devices, dot segments or separators are accepted.
  if (names.some(name => !NAME.test(name) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(name))) {
    throw new Error(`${SETTING} contains an invalid skill name; use names such as make-plan`);
  }
  return new Set(names);
}

export function readDisabledSkills(): Set<string> {
  // An explicitly empty environment variable re-enables every skill.
  if (process.env[SETTING] !== undefined) return parseDisabledSkills(process.env[SETTING]);
  const settingsPath = join(resolveDataDir(), 'settings.json');
  const stat = statOrNull(settingsPath);
  if (stat === null) return new Set();
  const raw = parseJsonWithBom<unknown>(readFileSync(settingsPath, 'utf-8'));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Cannot apply skill selection: settings.json must be an object');
  }
  return parseDisabledSkills(settingsTarget(raw as Record<string, unknown>)[SETTING]);
}

function statOrNull(path: string): Stats | null {
  try { return lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function directory(path: string): boolean {
  const stat = statOrNull(path);
  if (stat === null) return false;
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Refusing non-directory or symbolic link: ${path}`);
  return true;
}

function regularFile(path: string): boolean {
  const stat = statOrNull(path);
  if (stat === null) return false;
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Refusing non-file or symbolic link: ${path}`);
  return true;
}

/** Only our installed cache versions and marketplace plugin are writable. */
function checkInstalledRoot(pluginRoot: string): void {
  const root = resolve(pluginRoot);
  const cache = join(pluginsDirectory(), 'cache', 'thedotmack', 'claude-mem');
  const marketplace = join(marketplaceDirectory(), 'plugin');
  const cacheVersion = relative(resolve(cache), root);
  const inCache = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(cacheVersion);
  const inMarketplace = relative(resolve(marketplace), root) === '';
  if (!inCache && !inMarketplace) {
    throw new Error('Skill selection only modifies an installed claude-mem cache or marketplace plugin');
  }
  if (!directory(root)) throw new Error('Installed plugin directory is missing');
  // Check every component below the config directory, not just the leaf. A
  // redirected cache/skills directory must never move another tree's files.
  const config = resolve(dirname(pluginsDirectory()));
  const inside = relative(config, root);
  let path = config;
  // Walk a bounded relative path. Comparing ancestor strings in a while loop
  // can never reach config when Windows spells the same path with other casing.
  for (const component of inside.split(sep)) {
    path = join(path, component);
    directory(path);
  }
  if (realpathSync(root) !== realpathSync(join(realpathSync(config), inside))) {
    throw new Error('Installed plugin directory resolves outside its configured location');
  }
  directory(join(root, '.claude-plugin'));
  const manifestPath = join(root, '.claude-plugin', 'plugin.json');
  if (!regularFile(manifestPath) || parseJsonWithBom<{ name?: unknown }>(readFileSync(manifestPath, 'utf-8')).name !== 'claude-mem') {
    throw new Error('Skill selection requires the claude-mem plugin manifest');
  }
}

function skillExists(parent: string, name: string): boolean {
  const skill = join(parent, name);
  return directory(skill) && regularFile(join(skill, 'SKILL.md'));
}

/**
 * Move whole skill directories out of discovery, preserving scripts/assets.
 * Restoring is a rename too. An update that supplies both a new active skill
 * and an older parked copy keeps the older copy in .history, never overwrites
 * it or restores it over the new version. No skill content is ever deleted.
 */
export function applyDisabledSkills(pluginRoot: string, disabled: ReadonlySet<string>): SkillSelectionResult {
  // Do not accept unchecked names even from another programmatic caller.
  disabled = parseDisabledSkills([...disabled]);
  pluginRoot = resolve(pluginRoot);
  const result: SkillSelectionResult = { disabled: [], enabled: [], warnings: [] };
  const parked = join(pluginRoot, DISABLED_SKILLS_DIRECTORY);
  if (disabled.size === 0 && statOrNull(parked) === null) return result;
  checkInstalledRoot(pluginRoot);
  const skills = join(pluginRoot, 'skills');
  if (!directory(skills)) throw new Error('Installed plugin skills directory is missing');

  // Serialize concurrent SessionStart hooks. Do not break another process's
  // lock on a timeout; if a process was killed, report the lock for inspection.
  const lock = join(pluginRoot, '.claude-mem-skill-selection.lock');
  try { mkdirSync(lock); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`Skill selection is locked at ${lock}; retry after other sessions finish. If an interrupted run left it behind, remove the empty lock directory and retry`);
    }
    throw error;
  }
  try {
    if (!directory(parked)) {
      mkdirSync(parked);
      writeFileSync(join(parked, OWNER_FILE), OWNER, { flag: 'wx' });
    }
    if (!regularFile(join(parked, OWNER_FILE)) || readFileSync(join(parked, OWNER_FILE), 'utf-8') !== OWNER) {
      throw new Error('Disabled-skills directory is not owned by claude-mem; leaving it unchanged');
    }
    const parkedNames = readdirSync(parked).filter(name => NAME.test(name));
    const names = new Set([...disabled, ...parkedNames]);
    // Preflight every affected path before the first move. In particular,
    // dangling links are not mistaken for missing files by existsSync.
    const entries = [...names].map(name => {
      const active = skillExists(skills, name);
      const saved = skillExists(parked, name);
      if ((!active && statOrNull(join(skills, name)) !== null)
        || (!saved && statOrNull(join(parked, name)) !== null)) {
        throw new Error(`Skill directory has no regular SKILL.md: ${name}; leaving it unchanged`);
      }
      return { name, active, saved };
    });
    const history = join(parked, '.history');
    if (statOrNull(history) !== null) directory(history);
    for (const { name, active, saved } of entries) {
      const activePath = join(skills, name);
      const savedPath = join(parked, name);
      if (active && saved) {
        if (!directory(history)) mkdirSync(history);
        renameSync(savedPath, join(history, `${name}-${randomUUID()}`));
      }
      if (disabled.has(name)) {
        if (active) {
          renameSync(activePath, savedPath);
          result.disabled.push(name);
        } else if (!saved) {
          result.warnings.push(`Unknown bundled skill: ${name}`);
        }
      } else if (!active && saved) {
        // A directory without SKILL.md is still somebody's data: never replace it.
        if (statOrNull(activePath) !== null) throw new Error(`Cannot restore skill over existing path: ${activePath}`);
        renameSync(savedPath, activePath);
        result.enabled.push(name);
      }
    }
  } finally {
    rmdirSync(lock);
  }
  return result;
}

export function applyConfiguredSkillSelection(pluginRoot: string): SkillSelectionResult {
  return applyDisabledSkills(pluginRoot, readDisabledSkills());
}
