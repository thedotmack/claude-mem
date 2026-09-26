import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import path from 'path';
import { formatTime } from '../../shared/timeline-formatting.js';
import { ModeManager } from '../domain/ModeManager.js';

export const INJECT_LOG_BASENAME = 'zz-claude-mem-inject.md';
export const INJECT_TAG = '[claude-mem]';
export const HOST_MAX_FACT_CHARS = 500;
export const DEFAULT_INDEX_WINDOW = 80;
export const MAX_INDEX_WINDOW = 100;
export const DEFAULT_INDEX_LINE_CHARS = 160;
export const AGENT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const TIER_PREFIXES = {
  episode: '[episode] ',
  plain: '',
  note: '[note] ',
} as const;

export type GrokBotIndexTier = keyof typeof TIER_PREFIXES;

export interface GrokBotIndexObservation {
  id: number;
  type: string;
  title: string | null;
  created_at: string;
  created_at_epoch: number;
  project?: string;
}

export const FILE_HEADER = [
  '# Memory log',
  '',
  '<!-- Written by the claude-mem worker (Grok Bot live INDEX).',
  '     Growing observation timeline. The host Memory mid-attach reads this file.',
  '     Dated facts: "- (YYYY-MM-DD) [episode] [claude-mem] ID TIME ICON TITLE".',
  '     Each row keeps its observation ID for get_observations.',
  '     This file is overwritten as new observations land. Do not edit profile.md. -->',
  '',
].join('\n');

/** Host Memory fact grammar pinned in tests/grok-bot-session-inject.test.ts */
export const HOST_MEMORY_FACT_LINE = /^-\s+\((\d{4}-\d{2}-\d{2})\)\s+(.+?)\s*$/;

export function resolveIndexWindow(windowRaw: unknown, fallback = DEFAULT_INDEX_WINDOW): number {
  const parsed = Number(windowRaw);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(Math.trunc(parsed), MAX_INDEX_WINDOW);
}

export function resolveTier(raw: unknown): GrokBotIndexTier {
  const tier = String(raw ?? 'episode').trim().toLowerCase();
  return tier in TIER_PREFIXES ? (tier as GrokBotIndexTier) : 'episode';
}

export function collapseWhitespace(value: string): string {
  return String(value).replace(/\s+/g, ' ').trim();
}

function compactTime(time: string): string {
  return time.toLowerCase().replace(' am', 'a').replace(' pm', 'p');
}

const FALLBACK_TYPE_ICONS: Record<string, string> = {
  bugfix: '🔴',
  feature: '🟣',
  refactor: '🔄',
  change: '✅',
  discovery: '🔵',
  decision: '⚖️',
  session: '🎯',
  prompt: '💬',
};

export function typeIcon(type: string): string {
  try {
    return ModeManager.getInstance().getTypeIcon(type);
  } catch {
    return FALLBACK_TYPE_ICONS[type] || '📝';
  }
}

export function formatIndexRow(obs: GrokBotIndexObservation): string {
  const title = collapseWhitespace(obs.title || 'Untitled');
  const time = compactTime(formatTime(obs.created_at_epoch));
  return `${obs.id} ${time} ${typeIcon(obs.type)} ${title}`;
}

export function factLine(date: string, body: string, maxChars: number, tier: GrokBotIndexTier): string {
  const line = `- (${date}) ${TIER_PREFIXES[tier] ?? ''}${INJECT_TAG} ${collapseWhitespace(body)}`;
  return line.length <= maxChars ? line : `${line.slice(0, maxChars - 1)}…`;
}

/**
 * Seat rows first, house rows only fill the remaining slots.
 *
 * The seat's own project rows (newest first, unique IDs) claim the window
 * before any house row, so a busy house can never push a seat's diary —
 * including manual /api/memory/save self-saves — out of the INDEX. When the
 * seat diary is thinner than the window, house rows (newest first, skipping
 * IDs already listed) fill what is left. Seat rows alone reaching the window
 * means no house rows at all.
 */
export function mergeIndexObservations(
  seatRows: GrokBotIndexObservation[],
  houseRows: GrokBotIndexObservation[],
  window: number,
): GrokBotIndexObservation[] {
  const size = resolveIndexWindow(window);
  const seen = new Set<number>();
  const merged: GrokBotIndexObservation[] = [];
  const newestFirst = (rows: GrokBotIndexObservation[]) =>
    [...rows].sort((a, b) => b.created_at_epoch - a.created_at_epoch);
  for (const row of [...newestFirst(seatRows), ...newestFirst(houseRows)]) {
    if (merged.length >= size) break;
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    merged.push(row);
  }
  return merged;
}

export function formatIndexFactLines(
  observations: GrokBotIndexObservation[],
  options: {
    primaryProject: string;
    window?: number;
    maxLineChars?: number;
    tier?: GrokBotIndexTier;
    now?: Date;
    houseFilled?: boolean;
    /** Operator line pinned above the header; survives every worker rewrite. */
    standingLine?: string;
  },
): string[] {
  const now = options.now ?? new Date();
  const date = now.toISOString().slice(0, 10);
  const tier = options.tier ?? 'episode';
  const maxLineChars = Math.min(options.maxLineChars ?? DEFAULT_INDEX_LINE_CHARS, HOST_MAX_FACT_CHARS - 20);
  const headerMax = Math.min(HOST_MAX_FACT_CHARS - 20, Math.max(maxLineChars, 460));
  const primary = options.primaryProject || 'unknown';
  const houseNote = options.houseFilled ? ' · house fill' : '';
  const head = [
    `Claude-Mem timeline index for ${primary}${houseNote}`,
    `${observations.length} rows; fetch get_observations by ID`,
  ].join(' — ');

  const lines: string[] = [];
  const standingLine = collapseWhitespace(options.standingLine ?? '');
  if (standingLine) lines.push(factLine(date, standingLine, headerMax, tier));
  lines.push(factLine(date, head, headerMax, tier));
  for (const obs of observations) {
    lines.push(factLine(date, formatIndexRow(obs), maxLineChars, tier));
  }
  return lines;
}

export function renderIndexFile(factLines: string[]): string {
  return `${FILE_HEADER}${factLines.join('\n')}\n`;
}

export function factBlock(contents: string): string {
  return String(contents ?? '')
    .split('\n')
    .filter(line => line.startsWith('- ('))
    .join('\n');
}

export function shouldRewriteInject(existingContents: string, nextContents: string): boolean {
  return factBlock(existingContents) !== factBlock(nextContents);
}

export function injectLogPath(agentDataRoot: string, agentId: string): string {
  if (!AGENT_ID_RE.test(agentId)) {
    throw new Error(`Refusing inject path for non-UUID agent id: ${agentId}`);
  }
  return path.join(agentDataRoot, 'agents', agentId, 'memory', 'log', INJECT_LOG_BASENAME);
}

export function assertSafeInjectPath(agentDataRoot: string, agentId: string, filePath: string): void {
  const expectedDir = path.resolve(path.join(agentDataRoot, 'agents', agentId, 'memory', 'log'));
  const resolved = path.resolve(filePath);
  if (path.basename(resolved).toLowerCase() === 'profile.md') {
    throw new Error('Refusing write to profile.md');
  }
  if (path.dirname(resolved) !== expectedDir) {
    throw new Error('Refusing inject write outside agent memory/log');
  }
  if (path.basename(resolved) !== INJECT_LOG_BASENAME) {
    throw new Error(`Refusing inject write to a file this writer does not own: ${path.basename(resolved)}`);
  }
}

function writeFileAtomic(filePath: string, contents: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, contents, 'utf8');
  renameSync(tmp, filePath);
}

export function writeFileIfChanged(filePath: string, contents: string): { changed: boolean; filePath: string } {
  if (existsSync(filePath) && readFileSync(filePath, 'utf8') === contents) {
    return { changed: false, filePath };
  }
  writeFileAtomic(filePath, contents);
  return { changed: true, filePath };
}
