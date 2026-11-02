
import { Database } from 'bun:sqlite';
import path from 'path';
import {
  existsSync,
  writeFileSync,
  readFileSync,
  renameSync,
  unlinkSync,
  readdirSync,
  realpathSync
} from 'fs';
import { execSync } from 'child_process';
import { SettingsDefaultsManager } from '../shared/SettingsDefaultsManager.js';
import { formatTime, groupByDate } from '../shared/timeline-formatting.js';
import { isDirectChild, normalizePath } from '../shared/path-utils.js';
import { logger } from '../utils/logger.js';
import { getProjectContext } from '../utils/project-name.js';
import { replaceTaggedContent } from '../utils/claude-md-utils.js';
import { toBmpSafe } from '../utils/bmp-safe.js';
import { ensureDirectoryExists, resolveSymlinkWriteTarget } from '../shared/atomic-json.js';
import { paths } from '../shared/paths.js';
import { pageMatchingRows } from '../services/sqlite/stream-rows.js';

const DB_PATH = paths.database();
const SETTINGS_PATH = paths.settings();

interface ObservationRow {
  id: number;
  title: string | null;
  subtitle: string | null;
  narrative: string | null;
  facts: string | null;
  type: string;
  created_at: string;
  created_at_epoch: number;
  files_modified: string | null;
  files_read: string | null;
  project: string;
  discovery_tokens: number | null;
}

// BMP-only markers (issue #2787): astral emoji can be split into a lone
// surrogate by a Claude Code context truncation and brick the session.
const TYPE_ICONS: Record<string, string> = {
  'bugfix': '●',
  'feature': '◆',
  'refactor': '↻',
  'change': '✓',
  'discovery': '○',
  'decision': '⚖',
  'session': '◎',
  'prompt': '”'
};

function getTypeIcon(type: string): string {
  return TYPE_ICONS[type] || '•';
}

function estimateTokens(obs: ObservationRow): number {
  const size = (obs.title?.length || 0) +
    (obs.subtitle?.length || 0) +
    (obs.narrative?.length || 0) +
    (obs.facts?.length || 0);
  return Math.ceil(size / 4);
}

function getTrackedFolders(workingDir: string): Set<string> {
  const folders = new Set<string>();

  let output: string;
  try {
    output = execSync('git ls-files -z', {
      cwd: workingDir,
      encoding: 'utf-8',
      maxBuffer: 50 * 1024 * 1024
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.warn('CLAUDE_MD', 'git ls-files failed, falling back to directory walk', { error: errorMessage });
    walkDirectoriesWithIgnore(workingDir, folders);
    return folders;
  }

  const files = output.split('\0').filter(f => f);

  for (const file of files) {
    const absPath = path.join(workingDir, file);
    let dir = path.dirname(absPath);

    while (dir.length > workingDir.length && dir.startsWith(workingDir)) {
      folders.add(dir);
      dir = path.dirname(dir);
    }
  }

  return folders;
}

function walkDirectoriesWithIgnore(dir: string, folders: Set<string>, depth: number = 0): void {
  if (depth > 10) return;

  const ignorePatterns = [
    'node_modules', '.git', '.next', 'dist', 'build', '.cache',
    '__pycache__', '.venv', 'venv', '.idea', '.vscode', 'coverage',
    '.claude-mem', '.open-next', '.turbo'
  ];

  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (ignorePatterns.includes(entry.name)) continue;
      if (entry.name.startsWith('.') && entry.name !== '.claude') continue;

      const fullPath = path.join(dir, entry.name);
      folders.add(fullPath);
      walkDirectoriesWithIgnore(fullPath, folders, depth + 1);
    }
  } catch {
    // Ignore permission errors
  }
}

const ABSOLUTE_PATH = /^([A-Za-z]:)?[\\/]/;

function comparablePath(p: string): string {
  const normalized = normalizePath(p);
  // Windows drive letters and paths are case-insensitive.
  return /^[A-Za-z]:/.test(normalized) ? normalized.toLowerCase() : normalized;
}

function realComparablePath(p: string): string | null {
  try {
    return comparablePath(realpathSync(p));
  } catch {
    return null;
  }
}

/** realpath of the deepest existing ancestor, with the missing tail re-appended. */
function realComparablePathOfAncestor(p: string): string | null {
  const normalized = normalizePath(p);
  const missing: string[] = [];
  let current = normalized;
  while (current && current !== path.posix.dirname(current)) {
    const real = realComparablePath(current);
    if (real !== null) return [real, ...missing.reverse()].join('/');
    missing.push(path.posix.basename(current));
    current = path.posix.dirname(current);
  }
  return null;
}

/**
 * Tool evidence is usually absolute (Read/Edit/Write inputs). An absolute file
 * is a child of the folder when it sits in `<root>/<relativeFolder>` for some
 * checkout root: this one, or another checkout that shares the project key
 * (a moved clone, a git-remote project name). It is not a child when that
 * root lies inside this checkout: /repo/packages/widget/src/x.ts belongs to
 * packages/widget/src, not to /repo/src. Relative evidence keeps the
 * project-relative check.
 */
export function makeFolderChildMatcher(relativeFolder: string, workingDir: string): (file: string) => boolean {
  const relativeForm = comparablePath(relativeFolder);
  const rootForms = new Set([comparablePath(workingDir)]);
  const realRoot = realComparablePath(workingDir);
  if (realRoot) rootForms.add(realRoot);
  const insideThisCheckout = (dir: string) => [...rootForms].some(root => dir.startsWith(root + '/'));
  return (file: string) => {
    if (!ABSOLUTE_PATH.test(file)) return isDirectChild(file, relativeFolder);
    const fileDir = comparablePath(path.posix.dirname(normalizePath(file)));
    // comparablePath lowercases drive-qualified (Windows) paths; fold the folder the same way.
    const folderForm = /^[a-z]:/.test(fileDir) ? relativeForm.toLowerCase() : relativeForm;
    if (!fileDir.endsWith('/' + folderForm)) return false;
    const root = fileDir.slice(0, -(folderForm.length + 1));
    if (rootForms.has(root)) return true;
    const realFileRoot = realComparablePathOfAncestor(root);
    if (realFileRoot !== null && rootForms.has(realFileRoot)) return true;
    return !insideThisCheckout(root) && !(realFileRoot !== null && insideThisCheckout(realFileRoot));
  };
}

function hasDirectChildFile(obs: ObservationRow, isFolderChild: (file: string) => boolean): boolean {
  const checkFiles = (filesJson: string | null): boolean => {
    if (!filesJson) return false;
    try {
      const files = JSON.parse(filesJson);
      if (Array.isArray(files)) {
        return files.some(f => typeof f === 'string' && isFolderChild(f));
      }
    } catch (error) {
      logger.warn('CLAUDE_MD', 'Failed to parse files JSON in hasDirectChildFile', { error: error instanceof Error ? error.message : String(error) });
    }
    return false;
  };

  return checkFiles(obs.files_modified) || checkFiles(obs.files_read);
}

function findObservationsByFolder(
  db: Database,
  relativeFolderPath: string,
  workingDir: string,
  project: string,
  limit: number,
): ObservationRow[] {
  const sql = `
    SELECT o.*, o.discovery_tokens
    FROM observations o
    WHERE o.project COLLATE NOCASE = ?
      AND (o.files_modified LIKE ? OR o.files_read LIKE ? OR o.files_modified LIKE ? OR o.files_read LIKE ?)
    ORDER BY o.created_at_epoch DESC
  `;

  // Unanchored prefilters: tool evidence stores absolute paths
  // (".../repo/src/auth/x.ts", or "C:\\repo\\src\\auth\\x.ts" on Windows), so
  // the folder need not follow the JSON quote. The matcher does the exact check.
  const segments = relativeFolderPath.split(/[\\/]+/).filter(Boolean);
  const likeFor = (separator: string) => `%${JSON.stringify(segments.join(separator) + separator).slice(1, -1)}%`;
  const slashPattern = likeFor('/');
  const backslashPattern = likeFor('\\');
  const isFolderChild = makeFolderChildMatcher(relativeFolderPath, workingDir);
  // Page the folder's direct children themselves, not a guessed window of the
  // broader candidates that nested files can fill.
  return pageMatchingRows<ObservationRow>(
    db.prepare(sql),
    [project, slashPattern, slashPattern, backslashPattern, backslashPattern],
    obs => hasDirectChildFile(obs, isFolderChild),
    { limit },
  );
}

function extractRelevantFile(obs: ObservationRow, relativeFolder: string): string {
  if (obs.files_modified) {
    try {
      const modified = JSON.parse(obs.files_modified);
      if (Array.isArray(modified)) {
        for (const file of modified) {
          if (isDirectChild(file, relativeFolder)) {
            return path.basename(file);
          }
        }
      }
    } catch (error) {
      logger.warn('CLAUDE_MD', 'Failed to parse files_modified JSON', { error: error instanceof Error ? error.message : String(error) });
    }
  }

  if (obs.files_read) {
    try {
      const read = JSON.parse(obs.files_read);
      if (Array.isArray(read)) {
        for (const file of read) {
          if (isDirectChild(file, relativeFolder)) {
            return path.basename(file);
          }
        }
      }
    } catch (error) {
      logger.warn('CLAUDE_MD', 'Failed to parse files_read JSON', { error: error instanceof Error ? error.message : String(error) });
    }
  }

  return 'General';
}

function formatObservationsForClaudeMd(observations: ObservationRow[], folderPath: string): string {
  const lines: string[] = [];
  lines.push('# Recent Activity');
  lines.push('');
  lines.push('<!-- This section is auto-generated by claude-mem. Edit content outside the tags. -->');
  lines.push('');

  if (observations.length === 0) {
    lines.push('*No recent activity*');
    return lines.join('\n');
  }

  // Rows arrive newest-first (ORDER BY created_at_epoch DESC); keep days in the same order.
  const byDate = groupByDate(observations, obs => obs.created_at, { order: 'desc' });

  for (const [day, dayObs] of byDate) {
    lines.push(`### ${day}`);
    lines.push('');

    const byFile = new Map<string, ObservationRow[]>();
    for (const obs of dayObs) {
      const file = extractRelevantFile(obs, folderPath);
      if (!byFile.has(file)) byFile.set(file, []);
      byFile.get(file)!.push(obs);
    }

    for (const [file, fileObs] of byFile) {
      lines.push(`**${file}**`);
      lines.push('| ID | Time | T | Title | Read |');
      lines.push('|----|------|---|-------|------|');

      let lastTime = '';
      for (const obs of fileObs) {
        const time = formatTime(obs.created_at_epoch);
        const timeDisplay = time === lastTime ? '"' : time;
        lastTime = time;

        const icon = getTypeIcon(obs.type);
        const title = obs.title || 'Untitled';
        const tokens = estimateTokens(obs);

        lines.push(`| #${obs.id} | ${timeDisplay} | ${icon} | ${title} | ~${tokens} |`);
      }

      lines.push('');
    }
  }

  return lines.join('\n').trim();
}

function writeClaudeMdToFolder(folderPath: string, newContent: string): void {
  const resolvedPath = path.resolve(folderPath);

  if (resolvedPath.includes('/.git/') || resolvedPath.includes('\\.git\\') || resolvedPath.endsWith('/.git') || resolvedPath.endsWith('\\.git')) return;

  const claudeMdPath = path.join(folderPath, 'CLAUDE.md');

  if (!existsSync(folderPath)) {
    throw new Error(`Folder does not exist: ${folderPath}`);
  }

  let existingContent = '';
  if (existsSync(claudeMdPath)) {
    existingContent = readFileSync(claudeMdPath, 'utf-8');
  }

  // #2787: an observation title can carry an emoji, and the block must stay
  // BMP-only, as the worker's folder writer keeps it.
  const finalContent = replaceTaggedContent(existingContent, toBmpSafe(newContent));

  // A symlinked CLAUDE.md stays a symlink: write onto its final target.
  const writeTarget = resolveSymlinkWriteTarget(claudeMdPath);
  ensureDirectoryExists(path.dirname(writeTarget));
  const tempFile = `${writeTarget}.tmp`;
  writeFileSync(tempFile, finalContent);
  renameSync(tempFile, writeTarget);
}

function regenerateFolder(
  db: Database,
  absoluteFolder: string,
  relativeFolder: string,
  project: string,
  dryRun: boolean,
  workingDir: string,
  observationLimit: number
): { success: boolean; observationCount: number; error?: string } {
  if (!existsSync(absoluteFolder)) {
    return { success: false, observationCount: 0, error: 'Folder no longer exists' };
  }

  const resolvedFolder = path.resolve(absoluteFolder);
  const resolvedWorkingDir = path.resolve(workingDir);
  if (!resolvedFolder.startsWith(resolvedWorkingDir + path.sep)) {
    return { success: false, observationCount: 0, error: 'Path escapes project root' };
  }

  const observations = findObservationsByFolder(db, relativeFolder, resolvedWorkingDir, project, observationLimit);

  if (observations.length === 0) {
    return { success: false, observationCount: 0, error: 'No observations for folder' };
  }

  if (dryRun) {
    return { success: true, observationCount: observations.length };
  }

  try {
    const formatted = formatObservationsForClaudeMd(observations, relativeFolder);
    writeClaudeMdToFolder(absoluteFolder, formatted);
    return { success: true, observationCount: observations.length };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.warn('CLAUDE_MD', 'Failed to regenerate folder', { folder: relativeFolder, error: errorMessage });
    return { success: false, observationCount: 0, error: errorMessage };
  }
}

function processAllFoldersForGeneration(
  trackedFolders: Set<string>,
  workingDir: string,
  project: string,
  dryRun: boolean,
  observationLimit: number
): number {
  const db = new Database(DB_PATH, { readonly: true, create: false });

  let successCount = 0;
  let skipCount = 0;
  let errorCount = 0;

  const foldersArray = Array.from(trackedFolders).sort();

  for (const absoluteFolder of foldersArray) {
    const relativeFolder = path.relative(workingDir, absoluteFolder);

    const result = regenerateFolder(
      db,
      absoluteFolder,
      relativeFolder,
      project,
      dryRun,
      workingDir,
      observationLimit
    );

    if (result.success) {
      logger.debug('CLAUDE_MD', `Processed folder: ${relativeFolder}`, {
        observationCount: result.observationCount
      });
      successCount++;
    } else if (result.error?.includes('No observations')) {
      skipCount++;
    } else {
      logger.warn('CLAUDE_MD', `Error processing folder: ${relativeFolder}`, {
        error: result.error
      });
      errorCount++;
    }
  }

  db.close();

  logger.info('CLAUDE_MD', 'CLAUDE.md generation complete', {
    totalFolders: foldersArray.length,
    withObservations: successCount,
    noObservations: skipCount,
    errors: errorCount,
    dryRun
  });

  return 0;
}

export async function generateClaudeMd(dryRun: boolean): Promise<number> {
  const workingDir = process.cwd();
  const settings = SettingsDefaultsManager.loadFromFile(SETTINGS_PATH);
  const observationLimit = parseInt(settings.CLAUDE_MEM_CONTEXT_OBSERVATIONS, 10) || 50;

  logger.info('CLAUDE_MD', 'Starting CLAUDE.md generation', {
    workingDir,
    dryRun,
    observationLimit
  });

  const project = getProjectContext(workingDir).primary;
  const trackedFolders = getTrackedFolders(workingDir);

  if (trackedFolders.size === 0) {
    logger.info('CLAUDE_MD', 'No folders found in project');
    return 0;
  }

  logger.info('CLAUDE_MD', `Found ${trackedFolders.size} folders in project`);

  if (!existsSync(DB_PATH)) {
    logger.info('CLAUDE_MD', 'Database not found, no observations to process');
    return 0;
  }

  try {
    return processAllFoldersForGeneration(trackedFolders, workingDir, project, dryRun, observationLimit);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('CLAUDE_MD', 'Fatal error during CLAUDE.md generation', {
      error: errorMessage
    });
    return 1;
  }
}

function processFilesForCleanup(
  filesToProcess: string[],
  workingDir: string,
  dryRun: boolean
): number {
  let deletedCount = 0;
  let cleanedCount = 0;
  let errorCount = 0;

  for (const file of filesToProcess) {
    const relativePath = path.relative(workingDir, file);

    try {
      const result = cleanSingleFile(file, relativePath, dryRun);
      if (result === 'deleted') deletedCount++;
      else cleanedCount++;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.warn('CLAUDE_MD', `Error processing ${relativePath}`, { error: errorMessage });
      errorCount++;
    }
  }

  logger.info('CLAUDE_MD', 'CLAUDE.md cleanup complete', {
    deleted: deletedCount,
    cleaned: cleanedCount,
    errors: errorCount,
    dryRun
  });

  return 0;
}

function cleanSingleFile(file: string, relativePath: string, dryRun: boolean): 'deleted' | 'cleaned' {
  const content = readFileSync(file, 'utf-8');
  const stripped = content.replace(/<claude-mem-context>[\s\S]*?<\/claude-mem-context>/g, '').trim();

  if (stripped === '') {
    if (!dryRun) {
      unlinkSync(file);
    }
    logger.debug('CLAUDE_MD', `${dryRun ? '[DRY-RUN] Would delete' : 'Deleted'} (empty): ${relativePath}`);
    return 'deleted';
  } else {
    if (!dryRun) {
      writeFileSync(file, stripped);
    }
    logger.debug('CLAUDE_MD', `${dryRun ? '[DRY-RUN] Would clean' : 'Cleaned'}: ${relativePath}`);
    return 'cleaned';
  }
}

export async function cleanClaudeMd(dryRun: boolean): Promise<number> {
  const workingDir = process.cwd();

  logger.info('CLAUDE_MD', 'Starting CLAUDE.md cleanup', {
    workingDir,
    dryRun
  });

  const filesToProcess: string[] = [];

  function walkForClaudeMd(dir: string): void {
    const ignorePatterns = [
      'node_modules', '.git', '.next', 'dist', 'build', '.cache',
      '__pycache__', '.venv', 'venv', '.idea', '.vscode', 'coverage',
      '.claude-mem', '.open-next', '.turbo'
    ];

    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          if (!ignorePatterns.includes(entry.name)) {
            walkForClaudeMd(fullPath);
          }
        } else if (entry.name === 'CLAUDE.md') {
          try {
            const content = readFileSync(fullPath, 'utf-8');
            if (content.includes('<claude-mem-context>')) {
              filesToProcess.push(fullPath);
            }
          } catch {
            // Skip files we can't read
          }
        }
      }
    } catch {
      // Ignore permission errors
    }
  }

  walkForClaudeMd(workingDir);

  if (filesToProcess.length === 0) {
    logger.info('CLAUDE_MD', 'No CLAUDE.md files with auto-generated content found');
    return 0;
  }

  logger.info('CLAUDE_MD', `Found ${filesToProcess.length} CLAUDE.md files with auto-generated content`);

  try {
    return processFilesForCleanup(filesToProcess, workingDir, dryRun);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('CLAUDE_MD', 'Fatal error during CLAUDE.md cleanup', {
      error: errorMessage
    });
    return 1;
  }
}
