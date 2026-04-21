/**
 * Context File Writer — unified utilities for writing claude-mem context
 * into CLAUDE.md, CLAUDE.local.md, AGENTS.md, and other markdown files.
 *
 * Consolidates what used to be three separate modules:
 *   - claude-md-utils.ts         (folder CLAUDE.md orchestration)
 *   - agents-md-utils.ts         (AGENTS.md writer)
 *   - context-injection.ts       (injectContextIntoMarkdownFile)
 *   - cli/claude-md-commands.ts  (duplicate writeClaudeMdToFolder)
 *
 * Public API:
 *   - Tag constants: CONTEXT_TAG_OPEN, CONTEXT_TAG_CLOSE
 *   - replaceTaggedContent(existing, newContent) → string primitive
 *   - writeClaudeMdToFolder(folderPath, newContent, targetFilename?) — atomic, never creates dirs
 *   - writeAgentsMd(agentsPath, context) — atomic, prepends "# Memory Context" header
 *   - injectContextIntoMarkdownFile(filePath, contextContent, headerLine?) — creates parent dirs
 *   - formatTimelineForClaudeMd(timelineText) — API response → markdown
 *   - updateFolderClaudeMdFiles(filePaths, project, _port, projectRoot?) — orchestration
 *   - getTargetFilename(settings?) — selects CLAUDE.md vs CLAUDE.local.md
 */

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs';
import path, { dirname, resolve } from 'path';
import os from 'os';
import { logger } from './logger.js';
import { formatTime, groupByDate } from '../shared/timeline-formatting.js';
import { SettingsDefaultsManager } from '../shared/SettingsDefaultsManager.js';
import { workerHttpRequest } from '../shared/worker-utils.js';
import type { ObservationSearchResult, SessionSummarySearchResult } from '../services/sqlite/types.js';

// ============================================================================
// Tag Constants
// ============================================================================

export const CONTEXT_TAG_OPEN = '<claude-mem-context>';
export const CONTEXT_TAG_CLOSE = '</claude-mem-context>';

// ============================================================================
// Filename Selection
// ============================================================================

const SETTINGS_PATH = path.join(os.homedir(), '.claude-mem', 'settings.json');
const CLAUDE_MD_FILENAME = 'CLAUDE.md';
const CLAUDE_LOCAL_MD_FILENAME = 'CLAUDE.local.md';

/**
 * Get the target filename based on settings.
 * Returns 'CLAUDE.local.md' when CLAUDE_MEM_FOLDER_USE_LOCAL_MD is 'true',
 * otherwise returns 'CLAUDE.md'.
 */
export function getTargetFilename(settings?: ReturnType<typeof SettingsDefaultsManager.loadFromFile>): string {
  const s = settings ?? SettingsDefaultsManager.loadFromFile(SETTINGS_PATH);
  return s.CLAUDE_MEM_FOLDER_USE_LOCAL_MD === 'true' ? CLAUDE_LOCAL_MD_FILENAME : CLAUDE_MD_FILENAME;
}

// ============================================================================
// Core Tag-Replacement Primitive
// ============================================================================

/**
 * Replace tagged content in existing file, preserving content outside tags.
 *
 * Handles three cases:
 * 1. No existing content → wraps new content in tags
 * 2. Has existing tags → replaces only tagged section
 * 3. No tags in existing content → appends tagged content at end
 */
export function replaceTaggedContent(existingContent: string, newContent: string): string {
  if (!existingContent) {
    return `${CONTEXT_TAG_OPEN}\n${newContent}\n${CONTEXT_TAG_CLOSE}`;
  }

  const startIdx = existingContent.indexOf(CONTEXT_TAG_OPEN);
  const endIdx = existingContent.indexOf(CONTEXT_TAG_CLOSE);

  if (startIdx !== -1 && endIdx !== -1) {
    return existingContent.substring(0, startIdx) +
      `${CONTEXT_TAG_OPEN}\n${newContent}\n${CONTEXT_TAG_CLOSE}` +
      existingContent.substring(endIdx + CONTEXT_TAG_CLOSE.length);
  }

  return existingContent + `\n\n${CONTEXT_TAG_OPEN}\n${newContent}\n${CONTEXT_TAG_CLOSE}`;
}

// ============================================================================
// Path-Safety Helpers
// ============================================================================

function isInsideGitDirectory(resolvedPath: string): boolean {
  return resolvedPath.includes('/.git/') ||
    resolvedPath.includes('\\.git\\') ||
    resolvedPath.endsWith('/.git') ||
    resolvedPath.endsWith('\\.git');
}

function hasConsecutiveDuplicateSegments(resolvedPath: string): boolean {
  const segments = resolvedPath.split(path.sep).filter(s => s && s !== '.' && s !== '..');
  for (let i = 1; i < segments.length; i++) {
    if (segments[i] === segments[i - 1]) return true;
  }
  return false;
}

function isValidPathForClaudeMd(filePath: string, projectRoot?: string): boolean {
  if (!filePath || !filePath.trim()) return false;
  if (filePath.startsWith('~')) return false;
  if (filePath.startsWith('http://') || filePath.startsWith('https://')) return false;
  if (filePath.includes(' ')) return false;
  if (filePath.includes('#')) return false;

  if (projectRoot) {
    const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(projectRoot, filePath);
    const normalizedRoot = path.resolve(projectRoot);
    if (!resolved.startsWith(normalizedRoot + path.sep) && resolved !== normalizedRoot) {
      return false;
    }
    if (hasConsecutiveDuplicateSegments(resolved)) return false;
  }

  return true;
}

// ============================================================================
// File Writers
// ============================================================================

/**
 * Write CLAUDE.md file to folder with atomic writes.
 * Only writes to existing folders; skips non-existent paths to prevent
 * creating spurious directory structures from malformed paths.
 *
 * @param folderPath - Absolute path to the folder (must already exist)
 * @param newContent - Content to write inside tags
 * @param targetFilename - Target filename (default: determined by settings)
 */
export function writeClaudeMdToFolder(folderPath: string, newContent: string, targetFilename?: string): void {
  const resolvedPath = path.resolve(folderPath);

  // Never write inside .git directories — corrupts refs (#1165)
  if (isInsideGitDirectory(resolvedPath)) return;

  const filename = targetFilename ?? getTargetFilename();
  const claudeMdPath = path.join(folderPath, filename);
  const tempFile = `${claudeMdPath}.tmp`;

  // Only write to folders that already exist - never create new directories
  if (!existsSync(folderPath)) {
    logger.debug('FOLDER_INDEX', 'Skipping non-existent folder', { folderPath });
    return;
  }

  let existingContent = '';
  if (existsSync(claudeMdPath)) {
    existingContent = readFileSync(claudeMdPath, 'utf-8');
  }

  const finalContent = replaceTaggedContent(existingContent, newContent);

  // Atomic write: temp file + rename
  writeFileSync(tempFile, finalContent);
  renameSync(tempFile, claudeMdPath);
}

/**
 * Write AGENTS.md with claude-mem context, preserving user content outside tags.
 * Uses atomic write to prevent partial writes. Prepends "# Memory Context" header.
 */
export function writeAgentsMd(agentsPath: string, context: string): void {
  if (!agentsPath) return;

  // Never write inside .git directories — corrupts refs (#1165)
  const resolvedPath = resolve(agentsPath);
  if (isInsideGitDirectory(resolvedPath)) return;

  const dir = dirname(agentsPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  let existingContent = '';
  if (existsSync(agentsPath)) {
    existingContent = readFileSync(agentsPath, 'utf-8');
  }

  const contentBlock = `# Memory Context\n\n${context}`;
  const finalContent = replaceTaggedContent(existingContent, contentBlock);
  const tempFile = `${agentsPath}.tmp`;

  try {
    writeFileSync(tempFile, finalContent);
    renameSync(tempFile, agentsPath);
  } catch (error: unknown) {
    logger.error('AGENTS_MD', 'Failed to write AGENTS.md', { agentsPath }, error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * Inject or update a <claude-mem-context> section in a markdown file.
 * Creates the file if it doesn't exist. Preserves content outside the tags.
 *
 * Differs from writeClaudeMdToFolder: creates parent dirs, uses non-atomic
 * write, trims trailing whitespace when appending, supports optional headerLine
 * for new-file creation. Used by MCP/OpenCode installers.
 *
 * @param filePath - Absolute path to the target markdown file.
 * @param contextContent - The content to place between the context tags.
 * @param headerLine - Optional first line written when creating a new file
 *                     (e.g. `"# Claude-Mem Memory Context"` for AGENTS.md).
 */
export function injectContextIntoMarkdownFile(
  filePath: string,
  contextContent: string,
  headerLine?: string,
): void {
  const parentDirectory = path.dirname(filePath);
  mkdirSync(parentDirectory, { recursive: true });

  const wrappedContent = `${CONTEXT_TAG_OPEN}\n${contextContent}\n${CONTEXT_TAG_CLOSE}`;

  if (existsSync(filePath)) {
    let existingContent = readFileSync(filePath, 'utf-8');

    const tagStartIndex = existingContent.indexOf(CONTEXT_TAG_OPEN);
    const tagEndIndex = existingContent.indexOf(CONTEXT_TAG_CLOSE);

    if (tagStartIndex !== -1 && tagEndIndex !== -1) {
      existingContent =
        existingContent.slice(0, tagStartIndex) +
        wrappedContent +
        existingContent.slice(tagEndIndex + CONTEXT_TAG_CLOSE.length);
    } else {
      existingContent = existingContent.trimEnd() + '\n\n' + wrappedContent + '\n';
    }

    writeFileSync(filePath, existingContent, 'utf-8');
  } else {
    if (headerLine) {
      writeFileSync(filePath, `${headerLine}\n\n${wrappedContent}\n`, 'utf-8');
    } else {
      writeFileSync(filePath, wrappedContent + '\n', 'utf-8');
    }
  }
}

// ============================================================================
// Timeline Formatting (used by updateFolderClaudeMdFiles)
// ============================================================================

/**
 * Shape returned by the worker API when queried with `format=json`.
 * Mirrors `SearchManager.findByFile` structured payload. The server
 * pre-renders `typeIcon` so hook processes don't need ModeManager.
 */
export type SearchByFileObservation = ObservationSearchResult & { typeIcon?: string };

export interface SearchByFileJsonResponse {
  filePath: string;
  totalResults: number;
  observations: SearchByFileObservation[];
  sessions: SessionSummarySearchResult[];
}

const CHARS_PER_TOKEN_ESTIMATE = 4;
const DEFAULT_TYPE_ICON = '\uD83D\uDCDD'; // 📝 fallback when server omits typeIcon

function estimateReadTokens(obs: ObservationSearchResult): number {
  const size =
    (obs.title?.length || 0) +
    (obs.subtitle?.length || 0) +
    (obs.narrative?.length || 0) +
    (obs.facts?.length || 0);
  return Math.ceil(size / CHARS_PER_TOKEN_ESTIMATE);
}

interface TimelineRow {
  id: string;
  epoch: number;
  typeEmoji: string;
  title: string;
  tokens: string;
}

function observationToRow(obs: SearchByFileObservation): TimelineRow {
  return {
    id: `#${obs.id}`,
    epoch: obs.created_at_epoch,
    typeEmoji: obs.typeIcon || DEFAULT_TYPE_ICON,
    title: obs.title || 'Untitled',
    tokens: `~${estimateReadTokens(obs)}`
  };
}

function sessionToRow(session: SessionSummarySearchResult): TimelineRow {
  return {
    id: `#S${session.id}`,
    epoch: session.created_at_epoch,
    typeEmoji: '\uD83C\uDFAF',
    title:
      session.request ||
      `Session ${session.memory_session_id?.substring(0, 8) || 'unknown'}`,
    tokens: '-'
  };
}

/**
 * Render a structured search-by-file response to the CLAUDE.md timeline format.
 *
 * Output:
 * - `# Recent Activity` header
 * - One section per day (`### Mon D, YYYY`) in chronological order
 * - Table with columns: ID, Time, T (type emoji), Title, Read (~tokens)
 * - Ditto marks (`"`) for repeated times within a day
 *
 * Returns `''` when there are no results so callers can skip empty writes.
 */
export function formatTimelineForClaudeMd(response: SearchByFileJsonResponse | null | undefined): string {
  if (!response) return '';

  const rows: TimelineRow[] = [
    ...response.observations.map(observationToRow),
    ...response.sessions.map(sessionToRow)
  ];

  if (rows.length === 0) return '';

  // Most-recent first (same ordering as previous markdown path).
  rows.sort((a, b) => b.epoch - a.epoch);

  const byDate = groupByDate(rows, row => new Date(row.epoch).toISOString());

  const lines: string[] = ['# Recent Activity', ''];

  for (const [day, dayRows] of byDate) {
    lines.push(`### ${day}`);
    lines.push('');
    lines.push('| ID | Time | T | Title | Read |');
    lines.push('|----|------|---|-------|------|');

    let lastTime = '';
    for (const row of dayRows) {
      const time = formatTime(row.epoch);
      const timeDisplay = time === lastTime ? '"' : time;
      lastTime = time;
      lines.push(`| ${row.id} | ${timeDisplay} | ${row.typeEmoji} | ${row.title} | ${row.tokens} |`);
    }

    lines.push('');
  }

  return lines.join('\n').trim();
}

// ============================================================================
// Folder Orchestration (updateFolderClaudeMdFiles)
// ============================================================================

/**
 * Built-in directory names where CLAUDE.md generation is unsafe or undesirable.
 */
const EXCLUDED_UNSAFE_DIRECTORIES = new Set([
  'res',
  '.git',
  'build',
  'node_modules',
  '__pycache__'
]);

function isExcludedUnsafeDirectory(folderPath: string): boolean {
  const normalized = path.normalize(folderPath);
  const segments = normalized.split(path.sep);
  return segments.some(segment => EXCLUDED_UNSAFE_DIRECTORIES.has(segment));
}

function isProjectRoot(folderPath: string): boolean {
  const gitPath = path.join(folderPath, '.git');
  return existsSync(gitPath);
}

function isExcludedFolder(folderPath: string, excludePaths: string[]): boolean {
  const normalizedFolder = path.resolve(folderPath);
  for (const excludePath of excludePaths) {
    const normalizedExclude = path.resolve(excludePath);
    if (normalizedFolder === normalizedExclude ||
        normalizedFolder.startsWith(normalizedExclude + path.sep)) {
      return true;
    }
  }
  return false;
}

/**
 * Update CLAUDE.md files for folders containing the given files.
 * Fetches timeline from worker API and writes formatted content.
 *
 * Project root folders (containing .git) are excluded to preserve
 * user-managed root CLAUDE.md files. Only subfolder CLAUDE.md files are auto-updated.
 *
 * @param filePaths - Array of absolute file paths (modified or read)
 * @param project - Project identifier for API query
 * @param _port - Worker API port (legacy, now resolved automatically via socket/TCP)
 */
export async function updateFolderClaudeMdFiles(
  filePaths: string[],
  project: string,
  _port: number,
  projectRoot?: string
): Promise<void> {
  const settings = SettingsDefaultsManager.loadFromFile(SETTINGS_PATH);
  const limit = parseInt(settings.CLAUDE_MEM_CONTEXT_OBSERVATIONS, 10) || 50;
  const targetFilename = getTargetFilename(settings);

  let folderMdExcludePaths: string[] = [];
  try {
    const parsed = JSON.parse(settings.CLAUDE_MEM_FOLDER_MD_EXCLUDE || '[]');
    if (Array.isArray(parsed)) {
      folderMdExcludePaths = parsed.filter((p): p is string => typeof p === 'string');
    }
  } catch {
    logger.warn('FOLDER_INDEX', 'Failed to parse CLAUDE_MEM_FOLDER_MD_EXCLUDE setting');
  }

  // Track folders containing CLAUDE.md files that were read/modified in this observation.
  // We must NOT update these - it would cause "file modified since read" errors in Claude Code.
  // See: https://github.com/thedotmack/claude-mem/issues/859
  const foldersWithActiveClaudeMd = new Set<string>();

  for (const filePath of filePaths) {
    if (!filePath) continue;
    const basename = path.basename(filePath);
    if (basename === CLAUDE_MD_FILENAME || basename === CLAUDE_LOCAL_MD_FILENAME) {
      let absoluteFilePath = filePath;
      if (projectRoot && !path.isAbsolute(filePath)) {
        absoluteFilePath = path.join(projectRoot, filePath);
      }
      const folderPath = path.dirname(absoluteFilePath);
      foldersWithActiveClaudeMd.add(folderPath);
      logger.debug('FOLDER_INDEX', 'Detected active context file, will skip folder', { folderPath, basename });
    }
  }

  const folderPaths = new Set<string>();
  for (const filePath of filePaths) {
    if (!filePath || filePath === '') continue;
    if (!isValidPathForClaudeMd(filePath, projectRoot)) {
      logger.debug('FOLDER_INDEX', 'Skipping invalid file path', {
        filePath,
        reason: 'Failed path validation'
      });
      continue;
    }
    let absoluteFilePath = filePath;
    if (projectRoot && !path.isAbsolute(filePath)) {
      absoluteFilePath = path.join(projectRoot, filePath);
    }
    const folderPath = path.dirname(absoluteFilePath);
    if (folderPath && folderPath !== '.' && folderPath !== '/') {
      if (isProjectRoot(folderPath)) {
        logger.debug('FOLDER_INDEX', 'Skipping project root CLAUDE.md', { folderPath });
        continue;
      }
      if (isExcludedUnsafeDirectory(folderPath)) {
        logger.debug('FOLDER_INDEX', 'Skipping unsafe directory for CLAUDE.md', { folderPath });
        continue;
      }
      if (foldersWithActiveClaudeMd.has(folderPath)) {
        logger.debug('FOLDER_INDEX', 'Skipping folder with active CLAUDE.md to avoid race condition', { folderPath });
        continue;
      }
      if (folderMdExcludePaths.length > 0 && isExcludedFolder(folderPath, folderMdExcludePaths)) {
        logger.debug('FOLDER_INDEX', 'Skipping excluded folder', { folderPath });
        continue;
      }
      folderPaths.add(folderPath);
    }
  }

  if (folderPaths.size === 0) return;

  logger.debug('FOLDER_INDEX', 'Updating CLAUDE.md files', {
    project,
    folderCount: folderPaths.size
  });

  for (const folderPath of folderPaths) {
    let response: Response;
    try {
      response = await workerHttpRequest(
        `/api/search/by-file?filePath=${encodeURIComponent(folderPath)}&limit=${limit}&project=${encodeURIComponent(project)}&isFolder=true&format=json`
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      logger.error('FOLDER_INDEX', `Failed to fetch timeline for ${targetFilename}`, {
        folderPath,
        errorMessage: message,
        errorStack: stack
      });
      continue;
    }

    if (!response.ok) {
      logger.error('FOLDER_INDEX', 'Failed to fetch timeline', { folderPath, status: response.status });
      continue;
    }

    const result = await response.json() as SearchByFileJsonResponse;
    const formatted = formatTimelineForClaudeMd(result);

    // Fix for #794: Don't create new context files if there's no activity.
    // The renderer returns '' when there are no rows; skip creating files for
    // folders that don't have any yet, but overwrite (clear) files that exist.
    const claudeMdPath = path.join(folderPath, targetFilename);
    const fileExists = existsSync(claudeMdPath);

    if (!formatted && !fileExists) {
      logger.debug('FOLDER_INDEX', 'Skipping empty context file creation', { folderPath, targetFilename });
      continue;
    }

    writeClaudeMdToFolder(folderPath, formatted, targetFilename);

    logger.debug('FOLDER_INDEX', 'Updated context file', { folderPath, targetFilename });
  }
}
