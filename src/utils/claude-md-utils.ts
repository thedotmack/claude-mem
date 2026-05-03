
import { existsSync, readFileSync, writeFileSync, renameSync } from 'fs';
import path from 'path';
import { logger } from './logger.js';
import { formatDate, groupByDate } from '../shared/timeline-formatting.js';
import { SettingsDefaultsManager } from '../shared/SettingsDefaultsManager.js';
import { workerHttpRequest } from '../shared/worker-utils.js';
import { paths } from '../shared/paths.js';

const SETTINGS_PATH = paths.settings();

const CLAUDE_MD_FILENAME = 'CLAUDE.md';

const CLAUDE_LOCAL_MD_FILENAME = 'CLAUDE.local.md';

export function getTargetFilename(settings?: ReturnType<typeof SettingsDefaultsManager.loadFromFile>): string {
  const s = settings ?? SettingsDefaultsManager.loadFromFile(SETTINGS_PATH);
  return s.CLAUDE_MEM_FOLDER_USE_LOCAL_MD === 'true' ? CLAUDE_LOCAL_MD_FILENAME : CLAUDE_MD_FILENAME;
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

    if (hasConsecutiveDuplicateSegments(resolved)) {
      return false;
    }
  }

  return true;
}

export function replaceTaggedContent(existingContent: string, newContent: string): string {
  const startTag = '<claude-mem-context>';
  const endTag = '</claude-mem-context>';

  if (!existingContent) {
    return `${startTag}\n${newContent}\n${endTag}`;
  }

  const startIdx = existingContent.indexOf(startTag);
  const endIdx = existingContent.indexOf(endTag);

  if (startIdx !== -1 && endIdx !== -1) {
    return existingContent.substring(0, startIdx) +
      `${startTag}\n${newContent}\n${endTag}` +
      existingContent.substring(endIdx + endTag.length);
  }

  return existingContent + `\n\n${startTag}\n${newContent}\n${endTag}`;
}

export function writeClaudeMdToFolder(folderPath: string, newContent: string, targetFilename?: string): void {
  const resolvedPath = path.resolve(folderPath);

  if (resolvedPath.includes('/.git/') || resolvedPath.includes('\\.git\\') || resolvedPath.endsWith('/.git') || resolvedPath.endsWith('\\.git')) return;

  const filename = targetFilename ?? getTargetFilename();
  const claudeMdPath = path.join(folderPath, filename);
  const tempFile = `${claudeMdPath}.tmp`;

  if (!existsSync(folderPath)) {
    logger.debug('FOLDER_INDEX', 'Skipping non-existent folder', { folderPath });
    return;
  }

  let existingContent = '';
  if (existsSync(claudeMdPath)) {
    existingContent = readFileSync(claudeMdPath, 'utf-8');
  }

  const finalContent = replaceTaggedContent(existingContent, newContent);

  writeFileSync(tempFile, finalContent);
  renameSync(tempFile, claudeMdPath);
}

interface ParsedObservation {
  id: string;
  time: string;
  typeEmoji: string;
  title: string;
  tokens: string;
  epoch: number; 
}

export function formatTimelineForClaudeMd(timelineText: string): string {
  const lines: string[] = [];
  lines.push('# Recent Activity');
  lines.push('');

  const apiLines = timelineText.split('\n');

  const observations: ParsedObservation[] = [];
  let lastTimeStr = '';
  let currentDate: Date | null = null;

  for (const line of apiLines) {
    const dateMatch = line.match(/^###\s+(.+)$/);
    if (dateMatch) {
      const dateStr = dateMatch[1].trim();
      const parsedDate = new Date(dateStr);
      if (!isNaN(parsedDate.getTime())) {
        currentDate = parsedDate;
      }
      continue;
    }

    const match = line.match(/^\|\s*(#[S]?\d+)\s*\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|/);
    if (match) {
      const [, id, timeStr, typeEmoji, title, tokens] = match;

      let time: string;
      if (timeStr.trim() === '″' || timeStr.trim() === '"') {
        time = lastTimeStr;
      } else {
        time = timeStr.trim();
        lastTimeStr = time;
      }

      const baseDate = currentDate ? new Date(currentDate) : new Date();
      const timeParts = time.match(/(\d+):(\d+)\s*(AM|PM)/i);
      let epoch = baseDate.getTime();
      if (timeParts) {
        let hours = parseInt(timeParts[1], 10);
        const minutes = parseInt(timeParts[2], 10);
        const isPM = timeParts[3].toUpperCase() === 'PM';
        if (isPM && hours !== 12) hours += 12;
        if (!isPM && hours === 12) hours = 0;
        baseDate.setHours(hours, minutes, 0, 0);
        epoch = baseDate.getTime();
      }

      observations.push({
        id: id.trim(),
        time,
        typeEmoji: typeEmoji.trim(),
        title: title.trim(),
        tokens: tokens.trim(),
        epoch
      });
    }
  }

  if (observations.length === 0) {
    return '';
  }

  const byDate = groupByDate(observations, obs => new Date(obs.epoch).toISOString());

  for (const [day, dayObs] of byDate) {
    lines.push(`### ${day}`);
    lines.push('');
    lines.push('| ID | Time | T | Title | Read |');
    lines.push('|----|------|---|-------|------|');

    let lastTime = '';
    for (const obs of dayObs) {
      const timeDisplay = obs.time === lastTime ? '"' : obs.time;
      lastTime = obs.time;
      lines.push(`| ${obs.id} | ${timeDisplay} | ${obs.typeEmoji} | ${obs.title} | ${obs.tokens} |`);
    }

    lines.push('');
  }

  return lines.join('\n').trim();
}

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
        `/api/search/by-file?filePath=${encodeURIComponent(folderPath)}&limit=${limit}&project=${encodeURIComponent(project)}&isFolder=true`
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

    const result = await response.json() as { content?: Array<{ text?: string }> };
    if (!result.content?.[0]?.text) {
      logger.debug('FOLDER_INDEX', 'No content for folder', { folderPath });
      continue;
    }

    const formatted = formatTimelineForClaudeMd(result.content[0].text);

    const claudeMdPath = path.join(folderPath, targetFilename);
    const hasNoActivity = formatted.includes('*No recent activity*');
    const fileExists = existsSync(claudeMdPath);

    if (hasNoActivity && !fileExists) {
      logger.debug('FOLDER_INDEX', 'Skipping empty context file creation', { folderPath, targetFilename });
      continue;
    }

    writeClaudeMdToFolder(folderPath, formatted, targetFilename);

    logger.debug('FOLDER_INDEX', 'Updated context file', { folderPath, targetFilename });
  }
}
