/**
 * Human-readable table formatting using cli-table3 and chalk.
 */

import Table from 'cli-table3';
import chalk from 'chalk';
import { getTypeIcon } from './icons.js';
import type { SearchResult, TimelineItem, Observation, WorkerStats, ProjectWithCount } from '../types.js';
import { terminalWidth } from '../utils/detect.js';
import { formatBytes, formatUptime, formatTimestamp } from '../utils/format.js';

/** Safely coerce a field that may be a JSON string, array, or undefined into a string[]. */
function safeArray(value: string[] | string | undefined | null): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
  }
  return [];
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1) + '\u2026';
}

export function renderSearchIndex(results: SearchResult[]): string {
  if (results.length === 0) return chalk.dim('No results found.');

  const width = terminalWidth();
  const titleWidth = Math.max(30, width - 40);

  const table = new Table({
    head: [
      chalk.dim('#'),
      chalk.dim('Time'),
      chalk.dim('Type'),
      chalk.dim('Title'),
    ],
    colWidths: [7, 16, 5, titleWidth],
    style: { head: [], border: [] },
    chars: {
      top: '', 'top-mid': '', 'top-left': '', 'top-right': '',
      bottom: '', 'bottom-mid': '', 'bottom-left': '', 'bottom-right': '',
      left: '', 'left-mid': '', mid: '', 'mid-mid': '',
      right: '', 'right-mid': '', middle: ' ',
    },
  });

  for (const r of results) {
    table.push([
      chalk.dim(String(r.id)),
      chalk.dim(formatTimestamp(r.timestamp)),
      getTypeIcon(r.type),
      truncate(r.title, titleWidth - 2),
    ]);
  }

  return table.toString();
}

export function renderTimeline(items: TimelineItem[]): string {
  if (items.length === 0) return chalk.dim('No timeline items.');

  const width = terminalWidth();
  const titleWidth = Math.max(30, width - 45);

  const lines: string[] = [];
  for (const item of items) {
    const marker = item.isAnchor ? chalk.yellow('\u25b6') : chalk.dim('\u2502');
    const id = chalk.dim(`#${item.id}`);
    const time = chalk.dim(formatTimestamp(item.timestamp));
    const icon = getTypeIcon(item.type === 'observation' ? 'discovery' : 'feature');
    const title = item.isAnchor ? chalk.yellow(truncate(item.title, titleWidth)) : truncate(item.title, titleWidth);

    lines.push(`  ${marker} ${id.padEnd(10)} ${time.padEnd(20)} ${icon} ${title}`);
  }

  return lines.join('\n');
}

export function renderObservations(observations: Observation[]): string {
  if (observations.length === 0) return chalk.dim('No observations found.');

  const lines: string[] = [];
  for (const obs of observations) {
    lines.push('');
    lines.push(chalk.bold(`${getTypeIcon(obs.type)} #${obs.id} ${obs.title}`));
    if (obs.subtitle) lines.push(chalk.dim(`  ${obs.subtitle}`));
    lines.push(chalk.dim(`  ${formatTimestamp(obs.created_at_epoch)} | ${obs.project || 'no project'} | ${obs.type}`));

    if (obs.narrative) {
      lines.push('');
      const wrapped = wordWrap(obs.narrative, terminalWidth() - 4);
      for (const line of wrapped.split('\n')) {
        lines.push(`  ${line}`);
      }
    }

    const facts = safeArray(obs.facts);
    if (facts.length > 0) {
      lines.push('');
      lines.push(chalk.dim('  Facts:'));
      for (const fact of facts) {
        lines.push(`    \u2022 ${fact}`);
      }
    }

    const files = safeArray(obs.files_modified);
    if (files.length > 0) {
      lines.push(chalk.dim(`  Files: ${files.join(', ')}`));
    }

    lines.push(chalk.dim('  ' + '\u2500'.repeat(Math.min(60, terminalWidth() - 4))));
  }

  return lines.join('\n');
}

export function renderStats(stats: WorkerStats): string {
  const lines: string[] = [];

  lines.push(chalk.bold('Worker'));
  lines.push(`  Version:  ${stats.worker.version}`);
  lines.push(`  Uptime:   ${formatUptime(stats.worker.uptime)}`);
  lines.push(`  Port:     ${stats.worker.port}`);
  lines.push(`  Sessions: ${stats.worker.activeSessions}`);
  lines.push(`  SSE:      ${stats.worker.sseClients} clients`);

  lines.push('');
  lines.push(chalk.bold('Database'));
  lines.push(`  Observations: ${stats.database.observations}`);
  lines.push(`  Sessions:     ${stats.database.sessions}`);
  lines.push(`  Summaries:    ${stats.database.summaries}`);
  lines.push(`  Size:         ${formatBytes(stats.database.size)}`);

  return lines.join('\n');
}

export function renderProjects(projects: string[]): string {
  if (projects.length === 0) return chalk.dim('No projects found.');
  return projects.map(p => `  ${p}`).join('\n');
}

/**
 * Render a list of projects alongside their observation counts.
 *
 * Useful when the worker returns aggregated project statistics — e.g. after a
 * future `/projects?counts=true` endpoint lands. The count column is
 * right-aligned and colour-coded: dim for empty projects, normal for active
 * ones with a few observations, bold-green for busy ones (>=100).
 */
export function renderProjectList(projects: ProjectWithCount[]): string {
  if (projects.length === 0) return chalk.dim('No projects found.');

  // Determine column widths from actual data
  const maxNameLen = Math.max(...projects.map(p => p.name.length), 'Project'.length);
  const header =
    chalk.dim('Project'.padEnd(maxNameLen + 2)) +
    chalk.dim('Observations'.padStart(14));
  const divider = chalk.dim('\u2500'.repeat(maxNameLen + 16));

  const rows = projects.map(p => {
    const name = p.name.padEnd(maxNameLen + 2);
    const count = p.observationCount;
    let countStr: string;
    if (count === 0) {
      countStr = chalk.dim(String(count).padStart(14));
    } else if (count >= 100) {
      countStr = chalk.bold.green(String(count).padStart(14));
    } else {
      countStr = String(count).padStart(14);
    }
    return `  ${name}${countStr}`;
  });

  return [header, divider, ...rows].join('\n');
}

function wordWrap(text: string, width: number): string {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    if (current.length + word.length + 1 > width) {
      lines.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) lines.push(current);

  return lines.join('\n');
}
