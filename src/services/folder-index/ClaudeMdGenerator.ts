/**
 * ClaudeMdGenerator - Generate CLAUDE.md files with tag-based content replacement
 *
 * Wraps auto-generated timeline content with <claude-mem-context> tags.
 * Preserves all manual content outside the tags.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { FolderTimelineContent } from './types.js';
import { logger } from '../../utils/logger.js';
import { isAbsolute } from 'path';

const CLAUDE_MD_FILENAME = 'CLAUDE.md';
const OPENING_TAG = '<claude-mem-context>';
const CLOSING_TAG = '</claude-mem-context>';

/**
 * Write CLAUDE.md file with timeline content
 * Preserves existing manual content outside <claude-mem-context> tags
 *
 * @param folderPath - Absolute path to the folder (MUST be absolute)
 * @param timeline - Compiled timeline content to write
 */
export async function writeClaudeMd(
  folderPath: string,
  timeline: FolderTimelineContent
): Promise<void> {
  // Validate that folderPath is absolute (fail-fast)
  if (!isAbsolute(folderPath)) {
    throw new Error(
      `folderPath must be absolute, got relative path: "${folderPath}". ` +
      `This would write to the worker's current directory instead of the intended project location.`
    );
  }

  const claudeMdPath = path.join(folderPath, CLAUDE_MD_FILENAME);
  const folderName = path.basename(folderPath);

  try {
    // Read existing file if present
    let existingContent = '';
    if (fs.existsSync(claudeMdPath)) {
      existingContent = fs.readFileSync(claudeMdPath, 'utf-8');
    }

    // Format timeline to markdown
    const timelineMarkdown = formatTimelineToMarkdown(timeline);

    // Replace or append tagged content
    const updatedContent = replaceTaggedContent(
      existingContent,
      timelineMarkdown,
      folderName
    );

    // Write updated file
    fs.writeFileSync(claudeMdPath, updatedContent, 'utf-8');

    logger.info('FOLDER_INDEX', `Generated ${claudeMdPath}`, undefined, {
      observationCount: timeline.observationCount,
      timelineDays: timeline.timeline.length,
    });
  } catch (error) {
    logger.error(
      'FOLDER_INDEX',
      `Failed to write ${claudeMdPath}`,
      error as Error,
      { folderPath }
    );
    throw error;
  }
}

/**
 * Format timeline content to markdown
 */
function formatTimelineToMarkdown(timeline: FolderTimelineContent): string {
  const lines: string[] = [];

  lines.push('## Recent Activity Timeline');
  lines.push('');
  lines.push(`Last updated: ${timeline.lastUpdated}`);
  lines.push('');

  if (timeline.timeline.length === 0) {
    lines.push('No recent activity.');
    return lines.join('\n');
  }

  for (const day of timeline.timeline) {
    lines.push(`### ${day.date}`);
    lines.push('');

    for (const obs of day.observations) {
      lines.push(`- **${obs.type}**: ${obs.title}`);

      if (obs.files.length > 0) {
        const fileList = obs.files.map((f) => `\`${f}\``).join(', ');
        lines.push(`  - Files: ${fileList}`);
      }

      if (obs.summary) {
        lines.push(`  - ${obs.summary}`);
      }

      lines.push('');
    }
  }

  return lines.join('\n').trim();
}

/**
 * Replace content between <claude-mem-context> tags
 * If tags don't exist, create new file with header and tagged content
 * All content outside tags is preserved
 */
function replaceTaggedContent(
  existingContent: string,
  newContent: string,
  folderName: string
): string {
  const taggedContent = `${OPENING_TAG}\n${newContent}\n${CLOSING_TAG}`;

  // Check if tags exist
  const tagPattern = new RegExp(
    `${escapeRegex(OPENING_TAG)}[\\s\\S]*?${escapeRegex(CLOSING_TAG)}`,
    'g'
  );

  if (tagPattern.test(existingContent)) {
    // Replace existing tagged content
    return existingContent.replace(tagPattern, taggedContent);
  }

  // No tags found - create new file or append tags
  if (existingContent.trim() === '') {
    // Empty or new file - create with header and tagged content
    return `# ${folderName}\n\n${taggedContent}\n`;
  }

  // Existing manual content - append tagged section
  return `${existingContent.trimEnd()}\n\n${taggedContent}\n`;
}

/**
 * Escape special regex characters for safe pattern matching
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
