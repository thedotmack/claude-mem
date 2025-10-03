import { OptionValues } from 'commander';
import fs from 'fs';
import { join } from 'path';
import { PathDiscovery } from '../services/path-discovery.js';
import {
  createCompletionMessage,
  createContextualError,
  createUserFriendlyError,
  formatTimeAgo,
  outputSessionStartContent
} from '../prompts/templates/context/ContextTemplates.js';
import { getStorageProvider, needsMigration } from '../shared/storage.js';
import { MemoryRow, OverviewRow } from '../services/sqlite/types.js';
import { createStores } from '../services/sqlite/index.js';
import { getRollingSettings } from '../shared/rolling-settings.js';
import { rollingLog } from '../shared/rolling-log.js';

interface TrashStatus {
  folderCount: number;
  fileCount: number;
  totalSize: number;
  isEmpty: boolean;
}

function formatDateHeader(date = new Date()): string {
  return date.toLocaleString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short'
  });
}

function wordWrap(text: string, maxWidth: number, prefix: string): string {
  const words = text.split(' ');
  const lines: string[] = [];
  let currentLine = prefix;
  const continuationPrefix = ' '.repeat(prefix.length);

  for (const word of words) {
    const needsSpace = currentLine !== prefix && currentLine !== continuationPrefix;
    const testLine = currentLine + (needsSpace ? ' ' : '') + word;

    if (testLine.length <= maxWidth) {
      currentLine = testLine;
    } else {
      if (currentLine.trim()) {
        lines.push(currentLine);
      }
      currentLine = continuationPrefix + word;
    }
  }

  if (currentLine.trim()) {
    lines.push(currentLine);
  }

  return lines.join('\n');
}

function buildProjectMatcher(projectName: string): (value?: string) => boolean {
  const aliases = new Set<string>();
  aliases.add(projectName);
  aliases.add(projectName.replace(/-/g, '_'));
  aliases.add(projectName.replace(/_/g, '-'));
  return (value?: string) => !!value && aliases.has(value);
}

function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function getTrashStatus(): TrashStatus {
  const trashDir = PathDiscovery.getInstance().getTrashDirectory();
  
  if (!fs.existsSync(trashDir)) {
    return { folderCount: 0, fileCount: 0, totalSize: 0, isEmpty: true };
  }
  
  const items = fs.readdirSync(trashDir);
  if (items.length === 0) {
    return { folderCount: 0, fileCount: 0, totalSize: 0, isEmpty: true };
  }
  
  let folderCount = 0;
  let fileCount = 0;
  let totalSize = 0;
  
  for (const item of items) {
    const itemPath = join(trashDir, item);
    const stats = fs.statSync(itemPath);
    
    if (stats.isDirectory()) {
      folderCount++;
    } else {
      fileCount++;
    }
    
    totalSize += stats.size;
  }
  
  return { folderCount, fileCount, totalSize, isEmpty: false };
}

async function renderRollingSessionStart(projectOverride?: string): Promise<void> {
  const settings = getRollingSettings();

  if (!settings.sessionStartEnabled) {
    console.log('Rolling session-start output disabled in settings.');
    rollingLog('info', 'session-start output skipped (disabled)', {
      project: projectOverride
    });
    return;
  }

  const stores = await createStores();
  const projectName = projectOverride || PathDiscovery.getCurrentProjectName();

  // Get all overviews for this project (oldest to newest)
  const allOverviews = stores.overviews.getAllForProject(projectName);

  // Limit to last 10 overviews
  const recentOverviews = allOverviews.slice(-10);

  // If no data at all, show friendly message
  if (recentOverviews.length === 0) {
    console.log('===============================================================================');
    console.log(`What's new | ${formatDateHeader()}`);
    console.log('===============================================================================');
    console.log('No previous sessions found for this project.');
    console.log('Start working and claude-mem will automatically capture context for future sessions.');
    console.log('===============================================================================');
    const trashStatus = getTrashStatus();
    if (!trashStatus.isEmpty) {
      const formattedSize = formatSize(trashStatus.totalSize);
      console.log(
        `🗑️ Trash – ${trashStatus.folderCount} folders | ${trashStatus.fileCount} files | ${formattedSize} – use \`claude-mem restore\``
      );
      console.log('===============================================================================');
    }
    return;
  }

  // Output header
  console.log('===============================================================================');
  console.log(`What's new | ${formatDateHeader()}`);
  console.log('===============================================================================');

  // Output each overview with timestamp, memory names, and files touched (oldest to newest)
  recentOverviews.forEach((overview) => {
    const date = new Date(overview.created_at);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = date.getHours();
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const ampm = hours >= 12 ? 'PM' : 'AM';
    const displayHours = hours % 12 || 12;

    console.log(`[${year}-${month}-${day} at ${displayHours}:${minutes} ${ampm}]`);

    // Get memories for this session to show titles, subtitles, files, and keywords
    const sessionMemories = stores.memories.getBySessionId(overview.session_id);

    // Extract memory titles and subtitles
    const memories = sessionMemories
      .map(m => ({ title: m.title, subtitle: m.subtitle }))
      .filter(m => m.title);

    // Extract unique files touched across all memories
    const allFilesTouched = new Set<string>();
    const allKeywords = new Set<string>();

    sessionMemories.forEach(m => {
      if (m.files_touched) {
        try {
          const files = JSON.parse(m.files_touched);
          if (Array.isArray(files)) {
            files.forEach(f => allFilesTouched.add(f));
          }
        } catch (e) {
          // Skip invalid JSON
        }
      }

      if (m.keywords) {
        // Keywords are comma-separated
        m.keywords.split(',').forEach(k => allKeywords.add(k.trim()));
      }
    });

    console.log('');

    // Always show overview content
    console.log(wordWrap(overview.content, 80, ''));

    // Display files touched if any
    if (allFilesTouched.size > 0) {
      console.log('');
      console.log(wordWrap(`- ${Array.from(allFilesTouched).join(', ')}`, 80, ''));
    }

    // Display keywords/tags if any
    if (allKeywords.size > 0) {
      console.log('');
      console.log(wordWrap(`Tags: ${Array.from(allKeywords).join(', ')}`, 80, ''));
    }

    console.log('');
  });

  console.log('===============================================================================');
  const trashStatus = getTrashStatus();
  if (!trashStatus.isEmpty) {
    const formattedSize = formatSize(trashStatus.totalSize);
    console.log(
      `🗑️ Trash – ${trashStatus.folderCount} folders | ${trashStatus.fileCount} files | ${formattedSize} – use \`claude-mem restore\``
    );
    console.log('===============================================================================');
  }
}

export async function loadContext(options: OptionValues = {}): Promise<void> {
  try {
    // Check if migration is needed and warn the user
    if (await needsMigration()) {
      console.warn('⚠️  JSONL to SQLite migration recommended. Run: claude-mem migrate-index');
    }

    const storage = await getStorageProvider();
    
    // If using JSONL fallback, use original implementation
    if (storage.backend === 'jsonl') {
      return await loadContextFromJSONL(options);
    }

    // SQLite implementation - fetch data using storage provider
    let recentMemories: MemoryRow[] = [];
    let recentOverviews: OverviewRow[] = [];

    // Auto-detect current project for session-start format if no project specified
    let projectToUse = options.project;
    if (!projectToUse && options.format === 'session-start') {
      projectToUse = PathDiscovery.getCurrentProjectName();
    }

    if (options.format === 'session-start') {
      await renderRollingSessionStart(projectToUse);
      return;
    }

    const overviewLimit = options.format === 'json' ? 5 : 3;

    if (projectToUse) {
      recentMemories = await storage.getRecentMemoriesForProject(projectToUse, 10);
      recentOverviews = await storage.getRecentOverviewsForProject(projectToUse, overviewLimit);
    } else {
      recentMemories = await storage.getRecentMemories(10);
      recentOverviews = await storage.getRecentOverviews(overviewLimit);
    }

    // Convert SQLite rows to JSONL format for compatibility with existing output functions
    const memoriesAsJSON = recentMemories.map(row => ({
      type: 'memory',
      text: row.text,
      document_id: row.document_id,
      keywords: row.keywords,
      session_id: row.session_id,
      project: row.project,
      timestamp: row.created_at,
      archive: row.archive_basename
    }));

    const overviewsAsJSON = recentOverviews.map(row => ({
      type: 'overview',
      content: row.content,
      session_id: row.session_id,
      project: row.project,
      timestamp: row.created_at
    }));

    // If no data found, show appropriate messages
    if (memoriesAsJSON.length === 0 && overviewsAsJSON.length === 0) {
      return;
    }

    if (options.format === 'json') {
      // For JSON format, combine last 10 of each type
      const recentObjects = [...memoriesAsJSON, ...overviewsAsJSON];
      console.log(JSON.stringify(recentObjects));
    } else {
      // Default format - show last 10 memories and last 3 overviews
      const totalCount = memoriesAsJSON.length + overviewsAsJSON.length;
      
      console.log(createCompletionMessage('Context loading', totalCount, 'recent entries found'));
      
      // Show memories first
      memoriesAsJSON.forEach((obj) => {
        console.log(`${obj.text} | ${obj.document_id} | ${obj.keywords}`);
      });
      
      // Then show overviews
      overviewsAsJSON.forEach((obj) => {
        console.log(`**Overview:** ${obj.content}`);
      });
    }

    // Display trash status if not empty (except for JSON format to avoid breaking JSON parsing)
    if (options.format !== 'json') {
      const trashStatus = getTrashStatus();
      if (!trashStatus.isEmpty) {
        const formattedSize = formatSize(trashStatus.totalSize);
        console.log(`🗑️  Trash – ${trashStatus.folderCount} folders | ${trashStatus.fileCount} files | ${formattedSize} – use \`claude-mem restore\``);
        console.log('');
      }
    }
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (options.format === 'session-start') {
      console.log(createContextualError('CONNECTION_FAILED', errorMessage));
    } else {
      console.log(createUserFriendlyError('Context loading', errorMessage, 'Check file permissions and try again'));
    }
  }
}

/**
 * Original JSONL-based implementation for fallback compatibility
 */
async function loadContextFromJSONL(options: OptionValues = {}): Promise<void> {
  const pathDiscovery = PathDiscovery.getInstance();
  const indexPath = pathDiscovery.getIndexPath();
  
  // Auto-detect current project for session-start format if no project specified
  let projectToUse = options.project;
  if (!projectToUse && options.format === 'session-start') {
    projectToUse = PathDiscovery.getCurrentProjectName();
  }

  // Check if index file exists
  if (!fs.existsSync(indexPath)) {
    if (options.format === 'session-start') {
      console.log(createContextualError('NO_MEMORIES', projectToUse || 'this project'));
    }
    return;
  }

  const content = fs.readFileSync(indexPath, 'utf-8');
  const lines = content.trim().split('\n').filter(line => line.trim());
  
  if (lines.length === 0) {
    if (options.format === 'session-start') {
      console.log(createContextualError('NO_MEMORIES', projectToUse || 'this project'));
    }
    return;
  }
  
  // Parse JSONL format - each line is a JSON object
  const jsonObjects: any[] = [];
  for (const line of lines) {
    try {
      // Skip lines that don't look like JSON (could be legacy format)
      if (!line.trim().startsWith('{')) {
        continue;
      }
      const obj = JSON.parse(line);
      jsonObjects.push(obj);
    } catch (e) {
      // Skip malformed JSON lines
      continue;
    }
  }
  
  if (jsonObjects.length === 0) {
    if (options.format === 'session-start') {
      console.log(createContextualError('NO_MEMORIES', projectToUse || 'this project'));
    }
    return;
  }
  
  // Separate memories, overviews, and other types
  const memories = jsonObjects.filter(obj => obj.type === 'memory');
  const overviews = jsonObjects.filter(obj => obj.type === 'overview');
  const sessions = jsonObjects.filter(obj => obj.type === 'session');
  
  // Filter each type by project if specified
  // Handle both hyphen and underscore formats since index has mixed entries
  let filteredMemories = memories;
  let filteredOverviews = overviews;
  let filteredSessions = sessions;
  if (projectToUse) {
    const matchesProject = buildProjectMatcher(projectToUse);
    filteredMemories = memories.filter(obj => matchesProject(obj.project));
    filteredOverviews = overviews.filter(obj => matchesProject(obj.project));
    filteredSessions = sessions.filter(obj => matchesProject(obj.project));
  }

  if (options.format === 'session-start') {
    // Get last 10 memories and last 10 overviews for session-start
    const recentMemories = filteredMemories.slice(-10);
    const recentOverviews = filteredOverviews.slice(-10);
    const recentSessions = filteredSessions.slice(-10);
    
    // Combine them for the display
    const recentObjects = [...recentSessions, ...recentMemories, ...recentOverviews];
    
    // Find most recent timestamp for last session info
    let lastSessionTime = 'recently';
    const timestamps = recentObjects
      .map(obj => {
        // Get timestamp from JSON object
        return obj.timestamp ? new Date(obj.timestamp) : null;
      })
      .filter(date => date !== null)
      .sort((a, b) => b.getTime() - a.getTime());
    
    if (timestamps.length > 0) {
      lastSessionTime = formatTimeAgo(timestamps[0]);
    }

    // Use dual-stream output for session start formatting
    outputSessionStartContent({
      projectName: projectToUse || 'your project',
      memoryCount: recentMemories.length,
      lastSessionTime,
      recentObjects
    });
    
  } else if (options.format === 'json') {
    // For JSON format, combine last 10 of each type
    const recentMemories = filteredMemories.slice(-10);
    const recentOverviews = filteredOverviews.slice(-3);
    const recentObjects = [...recentMemories, ...recentOverviews];
    console.log(JSON.stringify(recentObjects));
  } else {
    // Default format - show last 10 memories and last 3 overviews
    const recentMemories = filteredMemories.slice(-10);
    const recentOverviews = filteredOverviews.slice(-3);
    const totalCount = recentMemories.length + recentOverviews.length;
    
    console.log(createCompletionMessage('Context loading', totalCount, 'recent entries found'));
    
    // Show memories first
    recentMemories.forEach((obj) => {
      console.log(`${obj.text} | ${obj.document_id} | ${obj.keywords}`);
    });
    
    // Then show overviews
    recentOverviews.forEach((obj) => {
      console.log(`**Overview:** ${obj.content}`);
    });
  }
}
