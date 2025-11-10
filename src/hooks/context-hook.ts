/**
 * Context Hook - SessionStart
 * Consolidated entry point + logic
 */

import path from 'path';
import { stdin } from 'process';
import { SessionStore } from '../services/sqlite/SessionStore.js';
import { getContextDepth } from '../shared/settings.js';

// Configuration: Read from settings.json or environment
const DISPLAY_OBSERVATION_COUNT = getContextDepth();
const DISPLAY_SESSION_COUNT = 10; // Recent sessions for timeline context
const CHARS_PER_TOKEN_ESTIMATE = 4; // Rough estimate for token counting
const SUMMARY_LOOKAHEAD = 1; // Fetch one extra summary for offset calculation

export interface SessionStartInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  source?: "startup" | "resume" | "clear" | "compact";
  [key: string]: any;
}

// ANSI color codes for terminal output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  gray: '\x1b[90m',
  red: '\x1b[31m',
};

interface Observation {
  id: number;
  sdk_session_id: string;
  type: string;
  title: string | null;
  subtitle: string | null;
  narrative: string | null;
  facts: string | null;
  concepts: string | null;
  files_read: string | null;
  files_modified: string | null;
  created_at: string;
  created_at_epoch: number;
}

interface SessionSummary {
  id: number;
  sdk_session_id: string;
  request: string | null;
  investigated: string | null;
  learned: string | null;
  completed: string | null;
  next_steps: string | null;
  created_at: string;
  created_at_epoch: number;
}

// Helper: Parse JSON array safely
function parseJsonArray(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    return [];
  }
}

// Helper: Format date with time
function formatDateTime(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });
}

// Helper: Format just time (no date)
function formatTime(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });
}

// Helper: Format just date
function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  });
}

// Helper: Estimate token count for text
function estimateTokens(text: string | null): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
}

// Helper: Convert absolute paths to relative paths
function toRelativePath(filePath: string, cwd: string): string {
  if (path.isAbsolute(filePath)) {
    return path.relative(cwd, filePath);
  }
  return filePath;
}

// Helper: Render a summary field (investigated, learned, etc.)
function renderSummaryField(label: string, value: string | null, color: string, useColors: boolean): string[] {
  if (!value) return [];

  if (useColors) {
    return [`${color}${label}:${colors.reset} ${value}`, ''];
  }
  return [`**${label}**: ${value}`, ''];
}

// Helper: Get all observations for given sessions
function getObservations(db: SessionStore, sessionIds: string[]): Observation[] {
  if (sessionIds.length === 0) return [];

  const placeholders = sessionIds.map(() => '?').join(',');
  const observations = db.db.prepare(`
    SELECT
      id, sdk_session_id, type, title, subtitle, narrative,
      facts, concepts, files_read, files_modified,
      created_at, created_at_epoch
    FROM observations
    WHERE sdk_session_id IN (${placeholders})
    ORDER BY created_at_epoch DESC
  `).all(...sessionIds) as Observation[];

  return observations;
}

/**
 * Context Hook Main Logic
 */
async function contextHook(input?: SessionStartInput, useColors: boolean = false): Promise<string> {
  const cwd = input?.cwd ?? process.cwd();
  const project = cwd ? path.basename(cwd) : 'unknown-project';

  const db = new SessionStore();

  // Get ALL recent observations for this project (not filtered by summaries)
  // This ensures we show observations even when summaries haven't been generated
  // Configurable via CLAUDE_MEM_CONTEXT_OBSERVATIONS env var (default: 50)
  const allObservations = db.db.prepare(`
    SELECT
      id, sdk_session_id, type, title, subtitle, narrative,
      facts, concepts, files_read, files_modified,
      created_at, created_at_epoch
    FROM observations
    WHERE project = ?
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `).all(project, DISPLAY_OBSERVATION_COUNT) as Observation[];

  // Get recent summaries (optional - may not exist for recent sessions)
  // Fetch one extra for offset calculation
  const recentSummaries = db.db.prepare(`
    SELECT id, sdk_session_id, request, investigated, learned, completed, next_steps, created_at, created_at_epoch
    FROM session_summaries
    WHERE project = ?
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `).all(project, DISPLAY_SESSION_COUNT + SUMMARY_LOOKAHEAD) as SessionSummary[];

  // If we have neither observations nor summaries, show empty state
  if (allObservations.length === 0 && recentSummaries.length === 0) {
    db.close();
    if (useColors) {
      return `\n${colors.bright}${colors.cyan}📝 [${project}] recent context${colors.reset}\n${colors.gray}${'─'.repeat(60)}${colors.reset}\n\n${colors.dim}No previous sessions found for this project yet.${colors.reset}\n`;
    }
    return `# [${project}] recent context\n\nNo previous sessions found for this project yet.`;
  }

  // Use observations for display (summaries are supplementary)
  const observations = allObservations;
  const displaySummaries = recentSummaries.slice(0, DISPLAY_SESSION_COUNT);

  // All observations are shown in timeline (filtered by type, not concepts)
  const timelineObs = observations;

  // Build output
  const output: string[] = [];

  // Header
  if (useColors) {
    output.push('');
    output.push(`${colors.bright}${colors.cyan}📝 [${project}] recent context${colors.reset}`);
    output.push(`${colors.gray}${'─'.repeat(60)}${colors.reset}`);
    output.push('');
  } else {
    output.push(`# [${project}] recent context`);
    output.push('');
  }

  // Chronological Timeline
  if (timelineObs.length > 0) {
    // Legend/Key
    if (useColors) {
      output.push(`${colors.dim}Legend: 🎯 session-request | 🔴 bugfix | 🟣 feature | 🔄 refactor | ✅ change | 🔵 discovery | 🧠 decision${colors.reset}`);
      output.push('');
    } else {
      output.push(`**Legend:** 🎯 session-request | 🔴 bugfix | 🟣 feature | 🔄 refactor | ✅ change | 🔵 discovery | 🧠 decision`);
      output.push('');
    }

    // Progressive Disclosure Usage Instructions
    if (useColors) {
      output.push(`${colors.dim}💡 Progressive Disclosure: This index shows WHAT exists (titles) and retrieval COST (token counts).${colors.reset}`);
      output.push(`${colors.dim}   → Use MCP search tools to fetch full observation details on-demand (Layer 2)${colors.reset}`);
      output.push(`${colors.dim}   → Prefer searching observations over re-reading code for past decisions and learnings${colors.reset}`);
      output.push(`${colors.dim}   → Critical types (🔴 bugfix, 🧠 decision) often worth fetching immediately${colors.reset}`);
      output.push('');
    } else {
      output.push(`💡 **Progressive Disclosure:** This index shows WHAT exists (titles) and retrieval COST (token counts).`);
      output.push(`- Use MCP search tools to fetch full observation details on-demand (Layer 2)`);
      output.push(`- Prefer searching observations over re-reading code for past decisions and learnings`);
      output.push(`- Critical types (🔴 bugfix, 🧠 decision) often worth fetching immediately`);
      output.push('');
    }

    // Prepare summaries for timeline display
    // The most recent summary shows full details (investigated, learned, etc.)
    // Older summaries only show as timeline markers (no link needed)
    const mostRecentSummaryId = recentSummaries[0]?.id;

    interface SummaryTimelineItem extends SessionSummary {
      displayEpoch: number;
      displayTime: string;
      shouldShowLink: boolean;
    }

    const summariesForTimeline: SummaryTimelineItem[] = displaySummaries.map((summary, i) => {
      // For visual grouping, display each summary at the time range it covers
      // Most recent: shows at its own time (current session)
      // Older: shows at the previous (older) summary's time to mark the session range
      const olderSummary = i === 0 ? null : recentSummaries[i + 1];
      return {
        ...summary,
        displayEpoch: olderSummary ? olderSummary.created_at_epoch : summary.created_at_epoch,
        displayTime: olderSummary ? olderSummary.created_at : summary.created_at,
        shouldShowLink: summary.id !== mostRecentSummaryId
      };
    });

    type TimelineItem =
      | { type: 'observation'; data: Observation }
      | { type: 'summary'; data: SummaryTimelineItem };

    const timeline: TimelineItem[] = [
      ...timelineObs.map(obs => ({ type: 'observation' as const, data: obs })),
      ...summariesForTimeline.map(summary => ({ type: 'summary' as const, data: summary }))
    ];

    // Sort chronologically
    timeline.sort((a, b) => {
      const aEpoch = a.type === 'observation' ? a.data.created_at_epoch : a.data.displayEpoch;
      const bEpoch = b.type === 'observation' ? b.data.created_at_epoch : b.data.displayEpoch;
      return aEpoch - bEpoch;
    });

    // Group by day for rendering
    const itemsByDay = new Map<string, TimelineItem[]>();
    for (const item of timeline) {
      const itemDate = item.type === 'observation' ? item.data.created_at : item.data.displayTime;
      const day = formatDate(itemDate);
      if (!itemsByDay.has(day)) {
        itemsByDay.set(day, []);
      }
      itemsByDay.get(day)!.push(item);
    }

    // Sort days chronologically
    const sortedDays = Array.from(itemsByDay.entries()).sort((a, b) => {
      const aDate = new Date(a[0]).getTime();
      const bDate = new Date(b[0]).getTime();
      return aDate - bDate;
    });

    // Render each day's timeline
    for (const [day, dayItems] of sortedDays) {
      // Day header
      if (useColors) {
        output.push(`${colors.bright}${colors.cyan}${day}${colors.reset}`);
        output.push('');
      } else {
        output.push(`### ${day}`);
        output.push('');
      }

      // Render items chronologically with visual file grouping
      let currentFile: string | null = null;
      let lastTime = '';
      let tableOpen = false;

      for (const item of dayItems) {
        if (item.type === 'summary') {
          // Close any open table
          if (tableOpen) {
            output.push('');
            tableOpen = false;
            currentFile = null;
            lastTime = '';
          }

          // Render summary
          const summary = item.data;
          const summaryTitle = `${summary.request || 'Session started'} (${formatDateTime(summary.displayTime)})`;
          const link = summary.shouldShowLink ? `claude-mem://session-summary/${summary.id}` : '';

          if (useColors) {
            const linkPart = link ? `${colors.dim}[${link}]${colors.reset}` : '';
            output.push(`🎯 ${colors.yellow}#S${summary.id}${colors.reset} ${summaryTitle} ${linkPart}`);
          } else {
            const linkPart = link ? ` [→](${link})` : '';
            output.push(`**🎯 #S${summary.id}** ${summaryTitle}${linkPart}`);
          }
          output.push('');
        } else {
          // Render observation
          const obs = item.data;
          const files = parseJsonArray(obs.files_modified);
          const file = files.length > 0 ? toRelativePath(files[0], cwd) : 'General';

          // Check if we need a new file section
          if (file !== currentFile) {
            // Close previous table
            if (tableOpen) {
              output.push('');
            }

            // File header
            if (useColors) {
              output.push(`${colors.dim}${file}${colors.reset}`);
            } else {
              output.push(`**${file}**`);
            }

            // Table header (markdown only)
            if (!useColors) {
              output.push(`| ID | Time | T | Title | Tokens |`);
              output.push(`|----|------|---|-------|--------|`);
            }

            currentFile = file;
            tableOpen = true;
            lastTime = '';
          }

          // Render observation row
          let icon = '•';

          // Map observation type to emoji
          switch (obs.type) {
            case 'bugfix':
              icon = '🔴';
              break;
            case 'feature':
              icon = '🟣';
              break;
            case 'refactor':
              icon = '🔄';
              break;
            case 'change':
              icon = '✅';
              break;
            case 'discovery':
              icon = '🔵';
              break;
            case 'decision':
              icon = '🧠';
              break;
            default:
              icon = '•';
          }

          const time = formatTime(obs.created_at);
          const title = obs.title || 'Untitled';
          const tokens = estimateTokens(obs.narrative);

          const showTime = time !== lastTime;
          const timeDisplay = showTime ? time : '';
          lastTime = time;

          if (useColors) {
            const timePart = showTime ? `${colors.dim}${time}${colors.reset}` : ' '.repeat(time.length);
            const tokensPart = tokens > 0 ? `${colors.dim}(~${tokens}t)${colors.reset}` : '';
            output.push(`  ${colors.dim}#${obs.id}${colors.reset}  ${timePart}  ${icon}  ${title} ${tokensPart}`);
          } else {
            output.push(`| #${obs.id} | ${timeDisplay || '″'} | ${icon} | ${title} | ~${tokens} |`);
          }
        }
      }

      // Close final table if open
      if (tableOpen) {
        output.push('');
      }
    }

    // Add full summary details for most recent session
    // Only show if summary was generated AFTER the last observation
    const mostRecentSummary = recentSummaries[0];
    const mostRecentObservation = observations[0]; // observations are DESC by created_at_epoch

    const shouldShowSummary = mostRecentSummary &&
      (mostRecentSummary.investigated || mostRecentSummary.learned || mostRecentSummary.completed || mostRecentSummary.next_steps) &&
      (!mostRecentObservation || mostRecentSummary.created_at_epoch > mostRecentObservation.created_at_epoch);

    if (shouldShowSummary) {
      output.push(...renderSummaryField('Investigated', mostRecentSummary.investigated, colors.blue, useColors));
      output.push(...renderSummaryField('Learned', mostRecentSummary.learned, colors.yellow, useColors));
      output.push(...renderSummaryField('Completed', mostRecentSummary.completed, colors.green, useColors));
      output.push(...renderSummaryField('Next Steps', mostRecentSummary.next_steps, colors.magenta, useColors));
    }

    // Footer with MCP search instructions
    if (useColors) {
      output.push(`${colors.dim}Use claude-mem MCP search to access records with the given ID${colors.reset}`);
    } else {
      output.push(`*Use claude-mem MCP search to access records with the given ID*`);
    }
  }

  db.close();
  return output.join('\n').trimEnd();
}

// Entry Point - handle stdin/stdout
const forceColors = process.argv.includes('--colors');

if (stdin.isTTY || forceColors) {
  // Running manually from terminal - print formatted output with colors
  contextHook(undefined, true).then(contextOutput => {
    console.log(contextOutput);
    process.exit(0);
  });
} else {
  // Running from hook - wrap in hookSpecificOutput JSON format
  let input = '';
  stdin.on('data', (chunk) => input += chunk);
  stdin.on('end', async () => {
    const parsed = input.trim() ? JSON.parse(input) : undefined;
    const contextOutput = await contextHook(parsed, false);
    const result = {
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: contextOutput
      }
    };
    console.log(JSON.stringify(result));
    process.exit(0);
  });
}