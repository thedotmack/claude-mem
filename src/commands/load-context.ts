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

interface IndexEntry {
  summary: string;
  entity: string;
  keywords: string[];
}

interface TrashStatus {
  folderCount: number;
  fileCount: number;
  totalSize: number;
  isEmpty: boolean;
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

export async function loadContext(options: OptionValues = {}): Promise<void> {
  const pathDiscovery = PathDiscovery.getInstance();
  const indexPath = pathDiscovery.getIndexPath();
  
  try {
    // Check if index file exists
    if (!fs.existsSync(indexPath)) {
      if (options.format === 'session-start') {
        console.log(createContextualError('NO_MEMORIES', options.project || 'this project'));
      }
      return;
    }

    const content = fs.readFileSync(indexPath, 'utf-8');
    const lines = content.trim().split('\n').filter(line => line.trim());
    
    if (lines.length === 0) {
      if (options.format === 'session-start') {
        console.log(createContextualError('NO_MEMORIES', options.project || 'this project'));
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
        console.log(createContextualError('NO_MEMORIES', options.project || 'this project'));
      }
      return;
    }
    
    // Separate memories, overviews, and other types
    const memories = jsonObjects.filter(obj => obj.type === 'memory');
    const overviews = jsonObjects.filter(obj => obj.type === 'overview');
    const sessions = jsonObjects.filter(obj => obj.type === 'session');
    
    // Filter each type by project if specified
    let filteredMemories = memories;
    let filteredOverviews = overviews;
    if (options.project) {
      filteredMemories = memories.filter(obj => obj.project === options.project);
      filteredOverviews = overviews.filter(obj => obj.project === options.project);
    }

    if (options.format === 'session-start') {
      // Get last 10 memories and last 5 overviews for session-start
      const recentMemories = filteredMemories.slice(-10);
      const recentOverviews = filteredOverviews.slice(-5);
      
      // Combine them for the display
      const recentObjects = [...recentMemories, ...recentOverviews];
      
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
        projectName: options.project || 'your project',
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

    // Display trash status if not empty (except for JSON format to avoid breaking JSON parsing)
    if (options.format !== 'json') {
      const trashStatus = getTrashStatus();
      if (!trashStatus.isEmpty) {
        const formattedSize = formatSize(trashStatus.totalSize);
        console.log(`🗑️  Trash – ${trashStatus.folderCount} folders | ${trashStatus.fileCount} files | ${formattedSize} – use \`$ claude-mem restore\``);
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