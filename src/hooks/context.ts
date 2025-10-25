import path from 'path';
import { SessionStore } from '../services/sqlite/SessionStore.js';
import { ensureWorkerRunning } from '../shared/worker-utils.js';

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


/**
 * Helper: Parse JSON array safely
 */
function parseJsonArray(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Helper: Format date with time
 */
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

/**
 * Helper: Format just time (no date)
 */
function formatTime(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });
}

/**
 * Helper: Format just date
 */
function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  });
}

/**
 * Helper: Estimate token count for text
 */
function estimateTokens(text: string | null): number {
  if (!text) return 0;
  // Rough estimate: ~4 characters per token
  return Math.ceil(text.length / 4);
}

/**
 * Helper: Convert absolute paths to relative paths
 */
function toRelativePath(filePath: string, cwd: string): string {
  try {
    if (path.isAbsolute(filePath)) {
      return path.relative(cwd, filePath);
    }
    return filePath;
  } catch {
    return filePath;
  }
}

/**
 * Helper: Get recent session IDs for a project
 */
function getRecentSessionIds(db: SessionStore, project: string, limit: number = 3): string[] {
  const sessions = db.db.prepare(`
    SELECT sdk_session_id
    FROM sdk_sessions
    WHERE project = ? AND sdk_session_id IS NOT NULL
    ORDER BY started_at_epoch DESC
    LIMIT ?
  `).all(project, limit) as Array<{ sdk_session_id: string }>;

  return sessions.map(s => s.sdk_session_id);
}

/**
 * Helper: Get all observations for given sessions
 */
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
 * Context Hook - SessionStart
 * Shows user what happened in recent sessions
 */
export function contextHook(input?: SessionStartInput, useColors: boolean = false, useIndexView: boolean = false): string {
  ensureWorkerRunning();
  const cwd = input?.cwd ?? process.cwd();
  const project = cwd ? path.basename(cwd) : 'unknown-project';

  const db = new SessionStore();

  try {
    // Get recent session IDs
    const sessionIds = getRecentSessionIds(db, project, 3);

    if (sessionIds.length === 0) {
      if (useColors) {
        return `\n${colors.bright}${colors.cyan}📝 [${project}] recent context${colors.reset}\n${colors.gray}${'─'.repeat(60)}${colors.reset}\n\n${colors.dim}No previous sessions found for this project yet.${colors.reset}\n`;
      }
      return `# [${project}] recent context\n\nNo previous sessions found for this project yet.`;
    }

    // Get all observations from recent sessions
    const observations = getObservations(db, sessionIds);

    // Filter observations by key concepts for timeline
    const timelineObs = observations.filter(obs => {
      const concepts = parseJsonArray(obs.concepts);
      return concepts.includes('what-changed') ||
             concepts.includes('how-it-works') ||
             concepts.includes('problem-solution') ||
             concepts.includes('gotcha') ||
             concepts.includes('discovery') ||
             concepts.includes('why-it-exists') ||
             concepts.includes('decision') ||
             concepts.includes('trade-off');
    });

    // Get most recent summary
    const recentSummary = db.db.prepare(`
      SELECT request, completed, next_steps, created_at
      FROM session_summaries
      WHERE project = ?
      ORDER BY created_at_epoch DESC
      LIMIT 1
    `).get(project) as { request: string | null; completed: string | null; next_steps: string | null; created_at: string } | undefined;

    // Get last 3 summaries with IDs for timeline integration
    const recentSummaries = db.db.prepare(`
      SELECT id, request, created_at, created_at_epoch
      FROM session_summaries
      WHERE project = ?
      ORDER BY created_at_epoch DESC
      LIMIT 3
    `).all(project) as Array<{ id: number; request: string | null; created_at: string; created_at_epoch: number }>;

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

    // SECTION 1: Chronological Timeline (grouped by file)
    if (timelineObs.length > 0) {
      if (useColors) {
        output.push(`${colors.bright}${colors.blue}📋 RECENT ACTIVITY TIMELINE${colors.reset}`);
        output.push('');
      } else {
        output.push(`## Recent Activity Timeline`);
        output.push('');
      }

      // Legend/Key
      if (useColors) {
        output.push(`${colors.dim}Legend: 🎯 session-request | 🔴 gotcha | 🟡 problem-solution | 🔵 how-it-works | 🟢 what-changed | 🟣 discovery | 🟠 why-it-exists | 🟤 decision | ⚖️ trade-off${colors.reset}`);
        output.push('');
      } else {
        output.push(`**Legend:** 🎯 session-request | 🔴 gotcha | 🟡 problem-solution | 🔵 how-it-works | 🟢 what-changed | 🟣 discovery | 🟠 why-it-exists | 🟤 decision | ⚖️ trade-off`);
        output.push('');
      }

      // Group observations by day, then by file
      const dayGroups = new Map<string, Map<string, typeof timelineObs>>();
      for (const obs of timelineObs) {
        const day = formatDate(obs.created_at);
        const files = parseJsonArray(obs.files_modified);
        const file = files.length > 0 ? toRelativePath(files[0], cwd) : 'General';

        if (!dayGroups.has(day)) {
          dayGroups.set(day, new Map());
        }

        const fileGroups = dayGroups.get(day)!;
        if (!fileGroups.has(file)) {
          fileGroups.set(file, []);
        }
        fileGroups.get(file)!.push(obs);
      }

      // Sort days chronologically
      const sortedDays = Array.from(dayGroups.entries()).sort((a, b) => {
        const aDate = new Date(a[0]).getTime();
        const bDate = new Date(b[0]).getTime();
        return aDate - bDate;
      });

      // Display each day's timeline
      for (const [day, fileGroups] of sortedDays) {
        // Day header
        if (useColors) {
          output.push(`${colors.bright}${colors.cyan}${day}${colors.reset}`);
          output.push('');
        } else {
          output.push(`### ${day}`);
          output.push('');
        }

        // Check if any summaries belong to this day
        const daySummaries = recentSummaries.filter(s => formatDate(s.created_at) === day);
        if (daySummaries.length > 0) {
          // Show session requests for this day
          if (useColors) {
            output.push(`${colors.dim}Session Requests${colors.reset}`);
          } else {
            output.push(`**Session Requests**`);
          }

          if (!useColors) {
            output.push(`| ID | Time | Title | Link |`);
            output.push(`|----|------|-------|------|`);
          }

          // Reverse to show oldest first (chronological)
          const mostRecentId = recentSummaries[0]?.id;
          for (const summary of daySummaries.slice().reverse()) {
            const time = formatTime(summary.created_at);
            const title = summary.request || 'Session started';
            const isMostRecent = summary.id === mostRecentId;
            const link = isMostRecent ? '' : `claude-mem://session-summary/${summary.id}`;

            if (useColors) {
              const linkPart = link ? `${colors.dim}[${link}]${colors.reset}` : '';
              output.push(`  ${colors.dim}#S${summary.id}${colors.reset}  ${colors.dim}${time}${colors.reset}  🎯  ${title} ${linkPart}`);
            } else {
              const linkCol = link ? `[→](${link})` : '-';
              output.push(`| #S${summary.id} | ${time} | 🎯 ${title} | ${linkCol} |`);
            }
          }

          output.push('');
        }

        // Sort files within day
        const sortedFiles = Array.from(fileGroups.entries()).sort((a, b) => {
          const aOldest = Math.min(...a[1].map(obs => obs.created_at_epoch));
          const bOldest = Math.min(...b[1].map(obs => obs.created_at_epoch));
          return aOldest - bOldest;
        });

        // Display each file within this day
        let filesShown = 0;
        for (const [file, obsGroup] of sortedFiles) {
          if (filesShown >= 10) break;

          // File header
          if (useColors) {
            output.push(`${colors.dim}${file}${colors.reset}`);
          } else {
            output.push(`**${file}**`);
          }

          // Table header
          if (!useColors) {
            output.push(`| ID | Time | T | Title | Tokens |`);
            output.push(`|----|------|---|-------|--------|`);
          }

          // Table rows
          let lastTime = '';
          const sortedObs = obsGroup.slice(0, 5).reverse();
          for (const obs of sortedObs) {
            const concepts = parseJsonArray(obs.concepts);
            let icon = '•';

            // Priority order: gotcha > decision > trade-off > problem-solution > discovery > why-it-exists > how-it-works > what-changed
            if (concepts.includes('gotcha')) {
              icon = '🔴';
            } else if (concepts.includes('decision')) {
              icon = '🟤';
            } else if (concepts.includes('trade-off')) {
              icon = '⚖️';
            } else if (concepts.includes('problem-solution')) {
              icon = '🟡';
            } else if (concepts.includes('discovery')) {
              icon = '🟣';
            } else if (concepts.includes('why-it-exists')) {
              icon = '🟠';
            } else if (concepts.includes('how-it-works')) {
              icon = '🔵';
            } else if (concepts.includes('what-changed')) {
              icon = '🟢';
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

          output.push('');
          filesShown++;
        }
      }

      // Footer with MCP search instructions
      if (useColors) {
        output.push(`${colors.dim}Use claude-mem MCP search to access records with the given ID${colors.reset}`);
      } else {
        output.push(`*Use claude-mem MCP search to access records with the given ID*`);
      }
      output.push('');
    }

    // SECTION 2: Recent Summary
    if (recentSummary) {
      if (useColors) {
        output.push(`${colors.bright}${colors.cyan}📋 RECENT SESSION SUMMARY${colors.reset} ${colors.dim}(${formatDateTime(recentSummary.created_at)})${colors.reset}`);
        output.push('');
      } else {
        output.push(`## Recent Session Summary *(${formatDateTime(recentSummary.created_at)})*`);
        output.push('');
      }

      if (recentSummary.request) {
        if (useColors) {
          output.push(`${colors.yellow}Request:${colors.reset} ${recentSummary.request}`);
        } else {
          output.push(`**Request**: ${recentSummary.request}`);
        }
        output.push('');
      }

      if (recentSummary.completed) {
        if (useColors) {
          output.push(`${colors.green}Completed:${colors.reset} ${recentSummary.completed}`);
        } else {
          output.push(`**Completed**: ${recentSummary.completed}`);
        }
        output.push('');
      }

      if (recentSummary.next_steps) {
        if (useColors) {
          output.push(`${colors.magenta}Next Steps:${colors.reset} ${recentSummary.next_steps}`);
        } else {
          output.push(`**Next Steps**: ${recentSummary.next_steps}`);
        }
        output.push('');
      }
    }

    // Footer
    if (useColors) {
      output.push(`${colors.gray}${'─'.repeat(60)}${colors.reset}`);
      output.push('');
    }

    return output.join('\n');
  } finally {
    db.close();
  }
}
