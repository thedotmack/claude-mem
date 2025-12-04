/**
 * Context Hook - SessionStart
 * Consolidated entry point + logic
 */

import path from 'path';
import { homedir } from 'os';
import { existsSync, readFileSync, unlinkSync } from 'fs';
import { stdin } from 'process';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { SessionStore } from '../services/sqlite/SessionStore.js';
import {
  OBSERVATION_TYPES,
  OBSERVATION_CONCEPTS,
  TYPE_ICON_MAP,
  TYPE_WORK_EMOJI_MAP,
  DEFAULT_OBSERVATION_TYPES_STRING,
  DEFAULT_OBSERVATION_CONCEPTS_STRING
} from '../constants/observation-metadata.js';
import { logger } from '../utils/logger.js';

// Get __dirname equivalent in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Version marker path (same as smart-install.js)
// From src/hooks/ we need to go up to plugin root: ../../
const VERSION_MARKER_PATH = path.join(__dirname, '../../.install-version');

interface ContextConfig {
  // Display counts
  totalObservationCount: number;
  fullObservationCount: number;
  sessionCount: number;

  // Token display toggles
  showReadTokens: boolean;
  showWorkTokens: boolean;
  showSavingsAmount: boolean;
  showSavingsPercent: boolean;

  // Filters
  observationTypes: Set<string>;
  observationConcepts: Set<string>;

  // Display options
  fullObservationField: 'narrative' | 'facts';
  showLastSummary: boolean;
  showLastMessage: boolean;
}

/**
 * Load all context configuration settings
 * Priority: ~/.claude-mem/settings.json > env var > defaults
 */
function loadContextConfig(): ContextConfig {
  const defaults = {
    totalObservationCount: parseInt(process.env.CLAUDE_MEM_CONTEXT_OBSERVATIONS || '50', 10),
    fullObservationCount: 5,
    sessionCount: 10,
    showReadTokens: true,
    showWorkTokens: true,
    showSavingsAmount: true,
    showSavingsPercent: true,
    observationTypes: new Set(OBSERVATION_TYPES),
    observationConcepts: new Set(OBSERVATION_CONCEPTS),
    fullObservationField: 'narrative' as const,
    showLastSummary: true,
    showLastMessage: false,
  };

  try {
    const settingsPath = path.join(homedir(), '.claude-mem', 'settings.json');
    if (!existsSync(settingsPath)) return defaults;

    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    const env = settings.env || {};

    return {
      totalObservationCount: parseInt(env.CLAUDE_MEM_CONTEXT_OBSERVATIONS || '50', 10),
      fullObservationCount: parseInt(env.CLAUDE_MEM_CONTEXT_FULL_COUNT || '5', 10),
      sessionCount: parseInt(env.CLAUDE_MEM_CONTEXT_SESSION_COUNT || '10', 10),
      showReadTokens: env.CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS !== 'false',
      showWorkTokens: env.CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS !== 'false',
      showSavingsAmount: env.CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT !== 'false',
      showSavingsPercent: env.CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT !== 'false',
      observationTypes: new Set(
        (env.CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES || DEFAULT_OBSERVATION_TYPES_STRING)
          .split(',').map((t: string) => t.trim()).filter(Boolean)
      ),
      observationConcepts: new Set(
        (env.CLAUDE_MEM_CONTEXT_OBSERVATION_CONCEPTS || DEFAULT_OBSERVATION_CONCEPTS_STRING)
          .split(',').map((c: string) => c.trim()).filter(Boolean)
      ),
      fullObservationField: (env.CLAUDE_MEM_CONTEXT_FULL_FIELD || 'narrative') as 'narrative' | 'facts',
      showLastSummary: env.CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY !== 'false',
      showLastMessage: env.CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE === 'true',
    };
  } catch (error) {
    logger.warn('HOOK', 'Failed to load context settings, using defaults', {}, error as Error);
    return defaults;
  }
}

// Configuration constants
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
  discovery_tokens: number | null;
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

// Helper: Convert cwd path to dashed format for transcript directory name
function cwdToDashed(cwd: string): string {
  // Convert all slashes to dashes (including leading slash)
  return cwd.replace(/\//g, '-');
}

// Helper: Extract last assistant message from transcript file
function extractPriorMessages(transcriptPath: string): { userMessage: string; assistantMessage: string } {
  try {
    if (!existsSync(transcriptPath)) {
      return { userMessage: '', assistantMessage: '' };
    }

    const content = readFileSync(transcriptPath, 'utf-8').trim();
    if (!content) {
      return { userMessage: '', assistantMessage: '' };
    }

    const lines = content.split('\n').filter(line => line.trim());

    // Find the last assistant message by filtering for assistant type and taking the last one
    let lastAssistantMessage = '';

    // Iterate backwards to find the most recent assistant message with text content
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const line = lines[i];

        // Quick check if this line is an assistant message
        if (!line.includes('"type":"assistant"')) {
          continue;
        }

        const entry = JSON.parse(line);

        if (entry.type === 'assistant' && entry.message?.content && Array.isArray(entry.message.content)) {
          let text = '';
          for (const block of entry.message.content) {
            if (block.type === 'text') {
              text += block.text;
            }
          }
          // Remove system-reminder tags
          text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
          if (text) {
            lastAssistantMessage = text;
            break; // Found it, stop searching
          }
        }
      } catch (parseError) {
        // Skip malformed lines
        continue;
      }
    }

    return { userMessage: '', assistantMessage: lastAssistantMessage };
  } catch (error) {
    logger.failure('HOOK', `Failed to extract prior messages from transcript`, { transcriptPath }, error as Error);
    return { userMessage: '', assistantMessage: '' };
  }
}

/**
 * Context Hook Main Logic
 */
async function contextHook(input?: SessionStartInput, useColors: boolean = false): Promise<string> {
  const config = loadContextConfig();
  const cwd = input?.cwd ?? process.cwd();
  const project = cwd ? path.basename(cwd) : 'unknown-project';

  let db: SessionStore | null = null;
  try {
    db = new SessionStore();
  } catch (error: any) {
    if (error.code === 'ERR_DLOPEN_FAILED') {
      // Native module ABI mismatch - delete version marker to trigger reinstall
      try {
        unlinkSync(VERSION_MARKER_PATH);
      } catch (unlinkError) {
        // Marker might not exist, that's okay
      }

      // Log once (not error spam) and exit cleanly
      console.error('⚠️  Native module rebuild needed - restart Claude Code to auto-fix');
      console.error('   (This happens after Node.js version upgrades)');
      process.exit(0); // Exit cleanly to avoid error spam
    }

    // Other errors should still throw
    throw error;
  }

  // Build SQL WHERE clause for observation types
  const typeArray = Array.from(config.observationTypes);
  const typePlaceholders = typeArray.map(() => '?').join(',');

  // Build SQL WHERE clause for concepts
  const conceptArray = Array.from(config.observationConcepts);
  const conceptPlaceholders = conceptArray.map(() => '?').join(',');

  // Get recent observations filtered by type and concepts at SQL level
  // This ensures we show observations even when summaries haven't been generated
  // Configurable via settings (default: 50)
  const observations = db.db.prepare(`
    SELECT
      id, sdk_session_id, type, title, subtitle, narrative,
      facts, concepts, files_read, files_modified, discovery_tokens,
      created_at, created_at_epoch
    FROM observations
    WHERE project = ?
      AND type IN (${typePlaceholders})
      AND EXISTS (
        SELECT 1 FROM json_each(concepts)
        WHERE value IN (${conceptPlaceholders})
      )
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `).all(project, ...typeArray, ...conceptArray, config.totalObservationCount) as Observation[];

  // Get recent summaries (optional - may not exist for recent sessions)
  // Fetch one extra for offset calculation
  const recentSummaries = db.db.prepare(`
    SELECT id, sdk_session_id, request, investigated, learned, completed, next_steps, created_at, created_at_epoch
    FROM session_summaries
    WHERE project = ?
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `).all(project, config.sessionCount + SUMMARY_LOOKAHEAD) as SessionSummary[];

  // Retrieve prior session messages if enabled
  let priorUserMessage = '';
  let priorAssistantMessage = '';
  // let debugInfo: string[] = [];

  if (config.showLastMessage && observations.length > 0) {
    try {
      const currentSessionId = input?.session_id;

      // Find the first observation from a different session (the prior session)
      const priorSessionObs = observations.find(obs => obs.sdk_session_id !== currentSessionId);

      if (priorSessionObs) {
        const priorSessionId = priorSessionObs.sdk_session_id;

        // Construct transcript path: ~/.claude/projects/{dashed-cwd}/{session_id}.jsonl
        const dashedCwd = cwdToDashed(cwd);
        const transcriptPath = path.join(homedir(), '.claude', 'projects', dashedCwd, `${priorSessionId}.jsonl`);

        // debugInfo.push(`📋 Prior Message Retrieval:`);
        // debugInfo.push(`  Session ID: ${priorSessionId}`);
        // debugInfo.push(`  Transcript: ${transcriptPath}`);
        // debugInfo.push(`  Exists: ${existsSync(transcriptPath)}`);

        // Extract messages from transcript
        const messages = extractPriorMessages(transcriptPath);
        priorUserMessage = messages.userMessage;
        priorAssistantMessage = messages.assistantMessage;

        // if (!priorUserMessage && !priorAssistantMessage) {
        //   debugInfo.push(`  ⚠️  No messages extracted from transcript`);
        // } else {
        //   debugInfo.push(`  ✅ Found user message: ${!!priorUserMessage}`);
        //   debugInfo.push(`  ✅ Found assistant message: ${!!priorAssistantMessage}`);
        // }
      } // else {
      //   debugInfo.push(`📋 Prior Message Retrieval: No prior session found (all observations from current session)`);
      // }
    } catch (error) {
      // debugInfo.push(`📋 Prior Message Retrieval Error: ${(error as Error).message}`);
    }
  }

  // If we have neither observations nor summaries, show empty state
  if (observations.length === 0 && recentSummaries.length === 0) {
    db?.close();
    if (useColors) {
      return `\n${colors.bright}${colors.cyan}📝 [${project}] recent context${colors.reset}\n${colors.gray}${'─'.repeat(60)}${colors.reset}\n\n${colors.dim}No previous sessions found for this project yet.${colors.reset}\n`;
    }
    return `# [${project}] recent context\n\nNo previous sessions found for this project yet.`;
  }

  const displaySummaries = recentSummaries.slice(0, config.sessionCount);

  // All filtered observations are shown in timeline
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
      output.push(`${colors.dim}Legend: 🎯 session-request | 🔴 bugfix | 🟣 feature | 🔄 refactor | ✅ change | 🔵 discovery | ⚖️  decision${colors.reset}`);
    } else {
      output.push(`**Legend:** 🎯 session-request | 🔴 bugfix | 🟣 feature | 🔄 refactor | ✅ change | 🔵 discovery | ⚖️  decision`);
    }
    output.push('');

    // Column Key
    if (useColors) {
      output.push(`${colors.bright}💡 Column Key${colors.reset}`);
      output.push(`${colors.dim}  Read: Tokens to read this observation (cost to learn it now)${colors.reset}`);
      output.push(`${colors.dim}  Work: Tokens spent on work that produced this record (🔍 research, 🛠️ building, ⚖️  deciding)${colors.reset}`);
    } else {
      output.push(`💡 **Column Key**:`);
      output.push(`- **Read**: Tokens to read this observation (cost to learn it now)`);
      output.push(`- **Work**: Tokens spent on work that produced this record (🔍 research, 🛠️ building, ⚖️  deciding)`);
    }
    output.push('');

    // Context Index Usage Instructions
    if (useColors) {
      output.push(`${colors.dim}💡 Context Index: This semantic index (titles, types, files, tokens) is usually sufficient to understand past work.${colors.reset}`);
      output.push('');
      output.push(`${colors.dim}When you need implementation details, rationale, or debugging context:${colors.reset}`);
      output.push(`${colors.dim}  - Use the mem-search skill to fetch full observations on-demand${colors.reset}`);
      output.push(`${colors.dim}  - Critical types (🔴 bugfix, ⚖️ decision) often need detailed fetching${colors.reset}`);
      output.push(`${colors.dim}  - Trust this index over re-reading code for past decisions and learnings${colors.reset}`);
    } else {
      output.push(`💡 **Context Index:** This semantic index (titles, types, files, tokens) is usually sufficient to understand past work.`);
      output.push('');
      output.push(`When you need implementation details, rationale, or debugging context:`);
      output.push(`- Use the mem-search skill to fetch full observations on-demand`);
      output.push(`- Critical types (🔴 bugfix, ⚖️ decision) often need detailed fetching`);
      output.push(`- Trust this index over re-reading code for past decisions and learnings`);
    }
    output.push('');

    // Section 1: Aggregate ROI Metrics
    const totalObservations = observations.length;
    const totalReadTokens = observations.reduce((sum, obs) => {
      // Estimate read tokens from observation size
      const obsSize = (obs.title?.length || 0) +
                      (obs.subtitle?.length || 0) +
                      (obs.narrative?.length || 0) +
                      JSON.stringify(obs.facts || []).length;
      return sum + Math.ceil(obsSize / CHARS_PER_TOKEN_ESTIMATE);
    }, 0);
    const totalDiscoveryTokens = observations.reduce((sum, obs) => sum + (obs.discovery_tokens || 0), 0);
    const savings = totalDiscoveryTokens - totalReadTokens;
    const savingsPercent = totalDiscoveryTokens > 0
      ? Math.round((savings / totalDiscoveryTokens) * 100)
      : 0;

    // Display Context Economics section only if at least one token setting is enabled
    const showContextEconomics = config.showReadTokens || config.showWorkTokens ||
                                   config.showSavingsAmount || config.showSavingsPercent;

    if (showContextEconomics) {
      if (useColors) {
        output.push(`${colors.bright}${colors.cyan}📊 Context Economics${colors.reset}`);
        output.push(`${colors.dim}  Loading: ${totalObservations} observations (${totalReadTokens.toLocaleString()} tokens to read)${colors.reset}`);
        output.push(`${colors.dim}  Work investment: ${totalDiscoveryTokens.toLocaleString()} tokens spent on research, building, and decisions${colors.reset}`);
        if (totalDiscoveryTokens > 0 && (config.showSavingsAmount || config.showSavingsPercent)) {
          let savingsLine = '  Your savings: ';
          if (config.showSavingsAmount && config.showSavingsPercent) {
            savingsLine += `${savings.toLocaleString()} tokens (${savingsPercent}% reduction from reuse)`;
          } else if (config.showSavingsAmount) {
            savingsLine += `${savings.toLocaleString()} tokens`;
          } else {
            savingsLine += `${savingsPercent}% reduction from reuse`;
          }
          output.push(`${colors.green}${savingsLine}${colors.reset}`);
        }
        output.push('');
      } else {
        output.push(`📊 **Context Economics**:`);
        output.push(`- Loading: ${totalObservations} observations (${totalReadTokens.toLocaleString()} tokens to read)`);
        output.push(`- Work investment: ${totalDiscoveryTokens.toLocaleString()} tokens spent on research, building, and decisions`);
        if (totalDiscoveryTokens > 0 && (config.showSavingsAmount || config.showSavingsPercent)) {
          let savingsLine = '- Your savings: ';
          if (config.showSavingsAmount && config.showSavingsPercent) {
            savingsLine += `${savings.toLocaleString()} tokens (${savingsPercent}% reduction from reuse)`;
          } else if (config.showSavingsAmount) {
            savingsLine += `${savings.toLocaleString()} tokens`;
          } else {
            savingsLine += `${savingsPercent}% reduction from reuse`;
          }
          output.push(savingsLine);
        }
        output.push('');
      }
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

    // Identify which observations should show full details (most recent N)
    const fullObservationIds = new Set(
      observations
        .slice(0, config.fullObservationCount)
        .map(obs => obs.id)
    );

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
          const file = (files.length > 0 && files[0]) ? toRelativePath(files[0], cwd) : 'General';

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
              output.push(`| ID | Time | T | Title | Read | Work |`);
              output.push(`|----|------|---|-------|------|------|`);
            }

            currentFile = file;
            tableOpen = true;
            lastTime = '';
          }

          const time = formatTime(obs.created_at);
          const title = obs.title || 'Untitled';

          // Map observation type to emoji icon
          const icon = TYPE_ICON_MAP[obs.type as keyof typeof TYPE_ICON_MAP] || '•';

          // Section 2: Calculate read tokens (estimate from observation size)
          const obsSize = (obs.title?.length || 0) +
                          (obs.subtitle?.length || 0) +
                          (obs.narrative?.length || 0) +
                          JSON.stringify(obs.facts || []).length;
          const readTokens = Math.ceil(obsSize / CHARS_PER_TOKEN_ESTIMATE);

          // Get discovery tokens (handle old observations without this field)
          const discoveryTokens = obs.discovery_tokens || 0;

          // Map observation type to work emoji
          const workEmoji = TYPE_WORK_EMOJI_MAP[obs.type as keyof typeof TYPE_WORK_EMOJI_MAP] || '🔍';

          const discoveryDisplay = discoveryTokens > 0 ? `${workEmoji} ${discoveryTokens.toLocaleString()}` : '-';

          const showTime = time !== lastTime;
          const timeDisplay = showTime ? time : '';
          lastTime = time;

          // Check if this observation should show full details
          const shouldShowFull = fullObservationIds.has(obs.id);

          if (shouldShowFull) {
            // Render with full details (narrative or facts)
            const detailField = config.fullObservationField === 'narrative'
              ? obs.narrative
              : (obs.facts ? parseJsonArray(obs.facts).join('\n') : null);

            if (useColors) {
              const timePart = showTime ? `${colors.dim}${time}${colors.reset}` : ' '.repeat(time.length);
              const readPart = (config.showReadTokens && readTokens > 0) ? `${colors.dim}(~${readTokens}t)${colors.reset}` : '';
              const discoveryPart = (config.showWorkTokens && discoveryTokens > 0) ? `${colors.dim}(${workEmoji} ${discoveryTokens.toLocaleString()}t)${colors.reset}` : '';

              output.push(`  ${colors.dim}#${obs.id}${colors.reset}  ${timePart}  ${icon}  ${colors.bright}${title}${colors.reset}`);
              if (detailField) {
                output.push(`    ${colors.dim}${detailField}${colors.reset}`);
              }
              if (readPart || discoveryPart) {
                output.push(`    ${readPart} ${discoveryPart}`);
              }
              output.push('');
            } else {
              // Close table for full observation
              if (tableOpen) {
                output.push('');
                tableOpen = false;
              }

              output.push(`**#${obs.id}** ${timeDisplay || '″'} ${icon} **${title}**`);
              if (detailField) {
                output.push('');
                output.push(detailField);
                output.push('');
              }
              const tokenParts: string[] = [];
              if (config.showReadTokens) {
                tokenParts.push(`Read: ~${readTokens}`);
              }
              if (config.showWorkTokens) {
                tokenParts.push(`Work: ${discoveryDisplay}`);
              }
              if (tokenParts.length > 0) {
                output.push(tokenParts.join(', '));
              }
              output.push('');

              // Reopen table for next items if in same file
              currentFile = null;
            }
          } else {
            // Compact index rendering (existing code)
            if (useColors) {
              const timePart = showTime ? `${colors.dim}${time}${colors.reset}` : ' '.repeat(time.length);
              const readPart = (config.showReadTokens && readTokens > 0) ? `${colors.dim}(~${readTokens}t)${colors.reset}` : '';
              const discoveryPart = (config.showWorkTokens && discoveryTokens > 0) ? `${colors.dim}(${workEmoji} ${discoveryTokens.toLocaleString()}t)${colors.reset}` : '';
              output.push(`  ${colors.dim}#${obs.id}${colors.reset}  ${timePart}  ${icon}  ${title} ${readPart} ${discoveryPart}`);
            } else {
              const readCol = config.showReadTokens ? `~${readTokens}` : '';
              const workCol = config.showWorkTokens ? discoveryDisplay : '';
              output.push(`| #${obs.id} | ${timeDisplay || '″'} | ${icon} | ${title} | ${readCol} | ${workCol} |`);
            }
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

    const shouldShowSummary = config.showLastSummary &&
      mostRecentSummary &&
      (mostRecentSummary.investigated || mostRecentSummary.learned || mostRecentSummary.completed || mostRecentSummary.next_steps) &&
      (!mostRecentObservation || mostRecentSummary.created_at_epoch > mostRecentObservation.created_at_epoch);

    if (shouldShowSummary) {
      output.push(...renderSummaryField('Investigated', mostRecentSummary.investigated, colors.blue, useColors));
      output.push(...renderSummaryField('Learned', mostRecentSummary.learned, colors.yellow, useColors));
      output.push(...renderSummaryField('Completed', mostRecentSummary.completed, colors.green, useColors));
      output.push(...renderSummaryField('Next Steps', mostRecentSummary.next_steps, colors.magenta, useColors));
    }

    // Previously section (last assistant message from prior session) - positioned at bottom for chronological sense
    if (priorAssistantMessage) {
      output.push('');
      output.push('---');
      output.push('');
      if (useColors) {
        output.push(`${colors.bright}${colors.magenta}📋 Previously${colors.reset}`);
        output.push('');
        output.push(`${colors.dim}A: ${priorAssistantMessage}${colors.reset}`);
      } else {
        output.push(`**📋 Previously**`);
        output.push('');
        output.push(`A: ${priorAssistantMessage}`);
      }
      output.push('');
    }

    // Footer with token savings message (only show if token economics is visible)
    if (showContextEconomics && totalDiscoveryTokens > 0 && savings > 0) {
      const workTokensK = Math.round(totalDiscoveryTokens / 1000);
      output.push('');
      if (useColors) {
        output.push(`${colors.dim}💰 Access ${workTokensK}k tokens of past research & decisions for just ${totalReadTokens.toLocaleString()}t. Use the mem-search skill to access memories by ID instead of re-reading files.${colors.reset}`);
      } else {
        output.push(`💰 Access ${workTokensK}k tokens of past research & decisions for just ${totalReadTokens.toLocaleString()}t. Use the mem-search skill to access memories by ID instead of re-reading files.`);
      }
    }
  }

  db?.close();

  // Add debug info directly to output
  // if (debugInfo.length > 0) {
  //   output.push('');
  //   output.push('---');
  //   output.push('');
  //   output.push(...debugInfo);
  // }

  return output.join('\n').trimEnd();
}

// Export for use by worker service
export { contextHook };

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