/**
 * Context Hook - SessionStart
 * Consolidated entry point + logic
 */

import path from 'path';
import { stdin } from 'process';
import { SessionStore } from '../services/sqlite/SessionStore.js';
import { ensureWorkerRunning } from '../shared/worker-utils.js';

// Configuration: Read from environment or use defaults
const DISPLAY_OBSERVATION_COUNT = parseInt(process.env.CLAUDE_MEM_CONTEXT_OBSERVATIONS || '50', 10);
// Summaries are supplementary - show last 10 for context but not configurable
const DISPLAY_SESSION_COUNT = 10;

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

// Helper: Parse JSON array safely
function parseJsonArray(json: string | null): string[] {
  if (!json) return [];
  const parsed = JSON.parse(json);
  return Array.isArray(parsed) ? parsed : [];
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
  // Rough estimate: ~4 characters per token
  return Math.ceil(text.length / 4);
}

// Helper: Convert absolute paths to relative paths
function toRelativePath(filePath: string, cwd: string): string {
  if (path.isAbsolute(filePath)) {
    return path.relative(cwd, filePath);
  }
  return filePath;
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
async function contextHook(input?: SessionStartInput, useColors: boolean = false, useIndexView: boolean = false): Promise<string> {
  // Ensure worker is running
  await ensureWorkerRunning();

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
  const recentSummaries = db.db.prepare(`
    SELECT id, sdk_session_id, request, completed, next_steps, created_at, created_at_epoch
    FROM session_summaries
    WHERE project = ?
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `).all(project, DISPLAY_SESSION_COUNT + 1) as Array<{ id: number; sdk_session_id: string; request: string | null; completed: string | null; next_steps: string | null; created_at: string; created_at_epoch: number }>;

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

    // Create unified timeline with both observations and summaries
    const mostRecentSummaryId = recentSummaries[0]?.id;

    // Create offset summaries
    const summariesWithOffset = displaySummaries.map((summary, i) => {
      // Most recent keeps its own time, others offset to next summary's time
      const nextSummary = i === 0 ? null : recentSummaries[i + 1];
      return {
        ...summary,
        displayEpoch: nextSummary ? nextSummary.created_at_epoch : summary.created_at_epoch,
        displayTime: nextSummary ? nextSummary.created_at : summary.created_at,
        isMostRecent: summary.id === mostRecentSummaryId
      };
    });

    type TimelineItem =
      | { type: 'observation'; data: Observation }
      | { type: 'summary'; data: typeof summariesWithOffset[0] };

    const timeline: TimelineItem[] = [
      ...timelineObs.map(obs => ({ type: 'observation' as const, data: obs })),
      ...summariesWithOffset.map(summary => ({ type: 'summary' as const, data: summary }))
    ];

    // Sort chronologically
    timeline.sort((a, b) => {
      const aEpoch = a.type === 'observation' ? a.data.created_at_epoch : a.data.displayEpoch;
      const bEpoch = b.type === 'observation' ? b.data.created_at_epoch : b.data.displayEpoch;
      return aEpoch - bEpoch;
    });

    // Group by day for rendering
    const dayTimelines = new Map<string, typeof timeline>();
    for (const item of timeline) {
      const itemDate = item.type === 'observation' ? item.data.created_at : item.data.displayTime;
      const day = formatDate(itemDate);
      if (!dayTimelines.has(day)) {
        dayTimelines.set(day, []);
      }
      dayTimelines.get(day)!.push(item);
    }

    // Sort days chronologically
    const sortedDays = Array.from(dayTimelines.entries()).sort((a, b) => {
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
          const link = summary.isMostRecent ? '' : `claude-mem://session-summary/${summary.id}`;

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
    const mostRecentSummary = recentSummaries[0];
    if (mostRecentSummary && (mostRecentSummary.completed || mostRecentSummary.next_steps)) {
      if (mostRecentSummary.completed) {
        if (useColors) {
          output.push(`${colors.green}Completed:${colors.reset} ${mostRecentSummary.completed}`);
        } else {
          output.push(`**Completed**: ${mostRecentSummary.completed}`);
        }
        output.push('');
      }

      if (mostRecentSummary.next_steps) {
        if (useColors) {
          output.push(`${colors.magenta}Next Steps:${colors.reset} ${mostRecentSummary.next_steps}`);
        } else {
          output.push(`**Next Steps**: ${mostRecentSummary.next_steps}`);
        }
        output.push('');
      }
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
const useIndexView = process.argv.includes('--index');
const forceColors = process.argv.includes('--colors');  // Add this line

if (stdin.isTTY || forceColors) {  // Modify this line to include forceColors
  // Running manually from terminal - print formatted output with colors
  contextHook(undefined, true, useIndexView)
    .then(contextOutput => {
      console.log(contextOutput);
      process.exit(0);
    })
    .catch(error => {
      console.error('Error:', error.message);
      process.exit(1);
    });
} else {
  // Running from hook - wrap in hookSpecificOutput JSON format
  let input = '';
  stdin.on('data', (chunk) => input += chunk);
  stdin.on('end', async () => {
    try {
      const parsed = input.trim() ? JSON.parse(input) : undefined;
      const contextOutput = await contextHook(parsed, false, useIndexView);
      const result = {
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: contextOutput
        }
      };
      console.log(JSON.stringify(result));
      process.exit(0);
    } catch (error: any) {
      console.error('Error:', error.message);
      process.exit(1);
    }
  });
}