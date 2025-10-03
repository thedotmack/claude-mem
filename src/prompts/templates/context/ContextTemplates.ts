/**
 * Context Templates for Human-Readable Formatting
 *
 * Essential templates for user-facing messages in the memory system.
 * Focused on session start messages, error handling, and operation feedback.
 * Previously included Handlebars templates for session start formatting; current
 * version renders directly via console for clarity and performance.
 */
 
import { formatRelativeTime, parseTimestamp } from '../../../lib/time-utils.js';

// =============================================================================
// TERMINAL WIDTH & WORD WRAPPING
// =============================================================================

/**
 * Determines target wrap width based on:
 * 1) CLAUDE_MEM_WRAP_WIDTH env override
 * 2) TTY columns (capped at 120)
 * 3) Fallback default of 80
 */
function getWrapWidth(): number {
  const env = process.env.CLAUDE_MEM_WRAP_WIDTH;
  if (env) {
    const n = parseInt(env, 10);
    if (!Number.isNaN(n) && n > 40 && n <= 200) return n;
  }
  // Default to classic 80 columns unless overridden
  return 80;
}

/**
 * Wrap a single logical line to the given width, preserving leading indentation.
 * Also avoids wrapping pure separator lines (====, ----, etc.).
 */
function wrapSingleLine(line: string, width: number): string {
  if (!line) return '';
  // Don't wrap long separator lines
  if (/^[\-=\u2014_\u2500\u2550]{5,}$/.test(line.trim())) return line;

  // If already short enough, return as-is
  if (line.length <= width) return line;

  const indentMatch = line.match(/^\s*/);
  const indent = indentMatch ? indentMatch[0] : '';
  const content = line.slice(indent.length);
  const avail = Math.max(10, width - indent.length); // keep some minimum

  const words = content.split(/(\s+)/); // keep whitespace tokens
  const out: string[] = [];
  let current = '';

  const pushLine = () => {
    out.push(indent + current.trimEnd());
    current = '';
  };

  for (const token of words) {
    if (token === '') continue;
    // If token itself is longer than available width, hard-break it
    if (!/\s/.test(token) && token.length > avail) {
      if (current.trim().length > 0) pushLine();
      let start = 0;
      while (start < token.length) {
        const chunk = token.slice(start, start + avail);
        out.push(indent + chunk);
        start += avail;
      }
      current = '';
      continue;
    }

    if (indent.length + current.length + token.length > width) {
      pushLine();
    }
    current += token;
  }

  if (current.trim().length > 0 || out.length === 0) pushLine();
  return out.join('\n');
}

/**
 * Wrap a block of text (possibly multi-line) to the given width.
 * Preserves blank lines and wraps each line independently.
 */
function wrapText(text: string, width: number): string {
  if (!text) return '';
  return text
    .split('\n')
    .map((line) => wrapSingleLine(line, width))
    .join('\n');
}

/** Create a full-width horizontal line with the given character */
function makeLine(char: string = '─', width: number = getWrapWidth()): string {
  if (!char || char.length === 0) char = '-';
  // Repeat and slice to exact width to avoid multi-column surprises
  return char.repeat(width).slice(0, width);
}

// =============================================================================
// SESSION START MESSAGES
// =============================================================================

/**
 * Creates a completion message after context operations
 */
export function createCompletionMessage(
  operation: string,
  count?: number,
  details?: string
): string {
  const countInfo = count !== undefined ? ` (${count} items)` : '';
  const detailInfo = details ? `\n${details}` : '';
  const width = getWrapWidth();
  return wrapText(
    `✅ ${operation} completed successfully${countInfo}${detailInfo}`,
    width
  );
}

// =============================================================================
// ERROR MESSAGES (USER-FRIENDLY)
// =============================================================================

/**
 * Creates user-friendly error messages with helpful suggestions
 */
export function createUserFriendlyError(
  operation: string,
  error: string,
  suggestion?: string
): string {
  const suggestionText = suggestion ? `\n\n💡 ${suggestion}` : '';
  const width = getWrapWidth();
  return wrapText(
    `❌ ${operation} encountered an issue: ${error}${suggestionText}`,
    width
  );
}

/**
 * Common error scenarios with built-in suggestions
 */
export const ERROR_SCENARIOS = {
  NO_MEMORIES: (projectName: string) => ({
    message: `No previous memories found for ${projectName}`,
    suggestion:
      'This appears to be your first session. Memories will be created as you work.',
  }),

  CONNECTION_FAILED: () => ({
    message: 'Could not connect to memory system',
    suggestion:
      'Try restarting Claude Code or check if the MCP server is properly configured.',
  }),

  SEARCH_FAILED: (query: string) => ({
    message: `Search for "${query}" didn't return any results`,
    suggestion:
      'Try using different keywords or check if memories exist for this project.',
  }),

  LOAD_TIMEOUT: () => ({
    message: 'Memory loading timed out',
    suggestion:
      'The operation is taking longer than expected. You can continue without loaded context.',
  }),
};

/**
 * Creates contextual error messages based on common scenarios
 */
export function createContextualError(
  scenario: keyof typeof ERROR_SCENARIOS,
  ...args: string[]
): string {
  const errorInfo = (ERROR_SCENARIOS[scenario] as any)(...args);
  return createUserFriendlyError(
    'Memory system',
    errorInfo.message,
    errorInfo.suggestion
  );
}

// =============================================================================
// TIME AND DATE FORMATTING
// =============================================================================

/**
 * Formats timestamps into human-readable "time ago" format
 */
export function formatTimeAgo(timestamp: string | Date): string {
  const date = typeof timestamp === 'string' ? new Date(timestamp) : timestamp;
  const now = new Date();
  const diff = now.getTime() - date.getTime();

  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes > 1 ? 's' : ''} ago`;
  if (hours < 24) return `${hours} hour${hours > 1 ? 's' : ''} ago`;
  if (days < 7) return `${days} day${days > 1 ? 's' : ''} ago`;

  return date.toLocaleDateString();
}

// =============================================================================
// SESSION START TEMPLATE SYSTEM (data processing only)
// =============================================================================

/**
 * Interface for memory entry data structure
 */
interface MemoryEntry {
  summary: string;
  keywords?: string;
  location?: string;
  sessionId?: string;
  number?: number;
}

/**
 * Interface for grouped session memories
 */
interface SessionGroup {
  sessionId: string;
  memories: MemoryEntry[];
}

/**
 * Interface for overview with timestamp
 */
interface OverviewEntry {
  content: string;
  timestamp?: Date;
  timeAgo?: string;
  sessionId?: string;
}

/**
 * Interface for session-grouped overviews
 */
interface SessionOverviewGroup {
  sessionId: string;
  overviews: OverviewEntry[];
  earliestTimestamp?: Date;
  timeAgo?: string;
}

/**
 * Pure data processing function - converts JSON objects into structured memory entries
 * No formatting is done here, only data parsing and cleaning
 */
function processMemoryEntries(recentObjects: any[]): MemoryEntry[] {
  if (recentObjects.length === 0) {
    return [];
  }

  // Filter only memory type objects and convert to MemoryEntry format
  return recentObjects
    .filter((obj) => obj.type === 'memory')
    .map((obj) => {
      const entry: MemoryEntry = {
        summary: obj.text || '',
        sessionId: obj.session_id || '',
      };

      // Add optional fields if present
      if (obj.keywords) {
        entry.keywords = obj.keywords;
      }
      if (obj.document_id && !obj.document_id.includes('Session:')) {
        entry.location = obj.document_id;
      }

      return entry;
    })
    .filter((entry) => entry.summary.length > 0);
}

/**
 * Groups memories by session ID and adds numbering
 */
function groupMemoriesBySession(memories: MemoryEntry[]): SessionGroup[] {
  const sessionMap = new Map<string, MemoryEntry[]>();

  // Group memories by session ID
  memories.forEach((memory) => {
    const sessionId = memory.sessionId;
    if (sessionId) {
      if (!sessionMap.has(sessionId)) {
        sessionMap.set(sessionId, []);
      }
      sessionMap.get(sessionId)!.push(memory);
    }
  });

  // Convert to session groups with numbering
  return Array.from(sessionMap.entries()).map(
    ([sessionId, sessionMemories]) => {
      const numberedMemories = sessionMemories.map((memory, index) => ({
        ...memory,
        number: index + 1,
      }));

      return {
        sessionId,
        memories: numberedMemories,
      };
    }
  );
}

/**
 * Groups overviews by session ID and calculates session timestamps
 */
function groupOverviewsBySession(
  overviews: OverviewEntry[]
): SessionOverviewGroup[] {
  const sessionMap = new Map<string, OverviewEntry[]>();

  // Group overviews by session ID
  overviews.forEach((overview) => {
    const sessionId = overview.sessionId || 'unknown';
    if (!sessionMap.has(sessionId)) {
      sessionMap.set(sessionId, []);
    }
    sessionMap.get(sessionId)!.push(overview);
  });

  // Convert to session groups with timestamps
  return Array.from(sessionMap.entries()).map(
    ([sessionId, sessionOverviews]) => {
      // Find the earliest timestamp in this session's overviews
      const timestamps = sessionOverviews
        .map((o) => o.timestamp)
        .filter((t): t is Date => t !== undefined)
        .sort((a, b) => a.getTime() - b.getTime());

      const group: SessionOverviewGroup = {
        sessionId,
        overviews: sessionOverviews,
      };

      // Add session-level timestamp if available
      if (timestamps.length > 0) {
        group.earliestTimestamp = timestamps[0];
        group.timeAgo = formatRelativeTime(timestamps[0]);
      }

      return group;
    }
  );
}

/**
 * Renders the complete session start template with provided data using Handlebars
 * Data processing is separated from presentation - template controls the format
 */
// Intentionally removed Handlebars-based renderer; console output is handled by
// outputSessionStartContent() below.

/**
 * Outputs session start content using dual streams:
 * - stdout (console.log) -> Claude's context only (granular memories)
 * - stderr (console.error) -> User visible (clean overviews)
 */
export function outputSessionStartContent(params: {
  projectName: string;
  memoryCount: number;
  lastSessionTime?: string;
  recentObjects: any[];
}): void {
  const { projectName, memoryCount, lastSessionTime, recentObjects } = params;
  const width = getWrapWidth();

  // Start with current date and time at the top
  const now = new Date();
  const dateTimeFormatted = now.toLocaleString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });

  console.log('');
  console.log(wrapText(`📅 ${dateTimeFormatted}`, width));
  console.log(makeLine('─', width));

  // Extract overviews for user display - get more to show session grouping
  const overviews = extractOverviews(recentObjects, 10, projectName);

  // Debug: Log what we're getting
  console.error(`[DEBUG] recentObjects has ${recentObjects.length} items`);
  console.error(`[DEBUG] overviews extracted: ${overviews.length}`);

  // Process memory entries for Claude context
  const memories = processMemoryEntries(recentObjects);
  // Helper to split and normalize keywords into a map (lowercased -> original)
  const splitKeywordsInto = (kw: string, dest: Map<string, string>) => {
    const tokens =
      kw.includes(',') || kw.includes('\n') ? kw.split(/[\n,]+/) : [kw];
    for (const t of tokens) {
      const trimmed = t.trim();
      if (!trimmed) continue;
      const key = trimmed.toLowerCase();
      if (!dest.has(key)) dest.set(key, trimmed);
    }
  };

  // Output memories first, then overviews at bottom, all sorted oldest to newest
  if (memories.length > 0) {
    const sessionGroups = groupMemoriesBySession(memories);
    console.log('');
    console.log('');

    console.log(wrapText('📚 Memories', width));
    sessionGroups.forEach((group) => {
      console.log(makeLine('─', width));

      console.log('');

      console.log(wrapText(`🔍 ${group.sessionId}`, width));

      // Collect keywords for this session as we iterate its memories
      const groupKeywordMap = new Map<string, string>();

      group.memories.forEach((memory) => {
        console.log('');
        console.log(wrapText(`${memory.number}. ${memory.summary}`, width));
        if (memory.keywords)
          splitKeywordsInto(memory.keywords, groupKeywordMap);
      });

      // Print this session's aggregated keywords under the session block
      const groupKeywords = Array.from(groupKeywordMap.values());
      if (groupKeywords.length > 0) {
        console.log('');
        console.log(wrapText(`🏷️  ${groupKeywords.join(', ')}`, width));
      }
      console.log('');
    });
  }

  // Overview section at bottom with session grouping
  if (overviews.length > 0) {
    const sessionGroups = groupOverviewsBySession(overviews);

    // Sort groups by timestamp, oldest first for chronological reading order
    sessionGroups.sort((a, b) => {
      const timeA = a.earliestTimestamp?.getTime() || 0;
      const timeB = b.earliestTimestamp?.getTime() || 0;
      return timeA - timeB; // Ascending order (oldest first)
    });

    console.log('');

    console.log(wrapText('🧠 Overviews', width));
    console.log(makeLine('─', width));

    // Match the memories section layout: session header, numbered items, per-session separator
    sessionGroups.forEach((group) => {
      console.log('');
      console.log(wrapText(`🔍 ${group.sessionId}`, width));

      group.overviews.forEach((overview, index) => {
        console.log('');
        console.log(wrapText(`${index + 1}. ${overview.content}`, width));
        console.log('');

        if (overview.timeAgo) {
          console.log(wrapText(`📅 ${overview.timeAgo}`, width));
        }
      });

      console.log('');
      console.log(makeLine('─', width));
    });
  } else if (memories.length === 0) {
    console.log(
      wrapText(`🧠 No recent context found for ${projectName}`, width)
    );
  }
}
