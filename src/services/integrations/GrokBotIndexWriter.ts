import { existsSync, mkdirSync, readdirSync, readFileSync } from 'fs';
import path from 'path';
import { Database } from 'bun:sqlite';
import { SettingsDefaultsManager, type SettingsDefaults } from '../../shared/SettingsDefaultsManager.js';
import { DB_PATH, USER_SETTINGS_PATH } from '../../shared/paths.js';
import { SQLITE_BUSY_TIMEOUT_MS } from '../sqlite/connection.js';
import { loadContextConfig } from '../context/ContextConfigLoader.js';
import { queryObservationsNewest } from '../context/ObservationCompiler.js';
import { logger } from '../../utils/logger.js';
import { discoverGrokBotAgentDataRoot, resolveGrokBotProject } from './GrokBotInstaller.js';
import {
  AGENT_ID_RE,
  DEFAULT_INDEX_LINE_CHARS,
  DEFAULT_INDEX_WINDOW,
  assertSafeInjectPath,
  formatIndexFactLines,
  injectLogPath,
  mergeIndexObservations,
  renderIndexFile,
  resolveIndexWindow,
  resolveTier,
  shouldRewriteInject,
  writeFileIfChanged,
  type GrokBotIndexObservation,
  type GrokBotIndexTier,
} from './grok-bot-index-format.js';

const DEFAULT_DEBOUNCE_MS = 1500;

export interface GrokBotIndexConfig {
  enabled: boolean;
  agentIdsAuto: boolean;
  agentIds: string[];
  projectsByAgent: Map<string, string[]>;
  fallback: 'house' | 'off';
  platformSource: string;
  tier: GrokBotIndexTier;
  window: number;
  maxLineChars: number;
  debounceMs: number;
  agentDataRoot: string;
  watchConfigFile: string;
}

export interface GrokBotIndexSeat {
  id: string;
  name: string;
  projects: string[];
}

export interface GrokBotIndexRefreshResult {
  agentId: string;
  projects: string[];
  status: 'written' | 'unchanged' | 'skipped' | 'error';
  reason?: string;
  filePath?: string;
  factLines?: number;
  houseFilled?: boolean;
}

export interface GrokBotIndexQueryFns {
  querySeat: (projects: string[], limit: number, platformSource?: string) => GrokBotIndexObservation[];
  queryHouse: (limit: number, platformSource?: string) => GrokBotIndexObservation[];
}

function splitCsv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0);
}

function readJson(file: string, fallback: unknown): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function parseProjectMap(raw: string | undefined): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const entry of String(raw ?? '').split(';')) {
    const [agentId, projects] = entry.split('=');
    if (!agentId || !projects) continue;
    const id = agentId.trim();
    if (!AGENT_ID_RE.test(id)) continue;
    const list = splitCsv(projects);
    if (list.length > 0) map.set(id.toLowerCase(), list);
  }
  return map;
}

export function loadGrokBotIndexConfig(
  settingsPath: string = USER_SETTINGS_PATH,
  env: NodeJS.ProcessEnv = process.env,
): GrokBotIndexConfig {
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  const pick = (key: keyof SettingsDefaults): string => {
    const envValue = env[key];
    if (envValue !== undefined) return envValue;
    return String(settings[key] ?? '');
  };

  const agentIdsRaw = pick('CLAUDE_MEM_GROK_BOT_INJECT_AGENT_IDS').trim();
  const agentIdsAuto = agentIdsRaw === '' || agentIdsRaw === '*' || agentIdsRaw.toLowerCase() === 'all';
  const fallbackRaw = pick('CLAUDE_MEM_GROK_BOT_INJECT_FALLBACK').trim().toLowerCase();
  const debounceRaw = Number(pick('CLAUDE_MEM_GROK_BOT_INJECT_DEBOUNCE_MS'));

  return {
    enabled: pick('CLAUDE_MEM_GROK_BOT_INJECT_ENABLED').toLowerCase() !== 'false',
    agentIdsAuto,
    agentIds: agentIdsAuto ? [] : splitCsv(agentIdsRaw).filter(id => AGENT_ID_RE.test(id)),
    projectsByAgent: parseProjectMap(pick('CLAUDE_MEM_GROK_BOT_INJECT_PROJECTS_BY_AGENT')),
    fallback: fallbackRaw === 'off' ? 'off' : 'house',
    platformSource: pick('CLAUDE_MEM_GROK_BOT_INJECT_PLATFORM_SOURCE').trim(),
    tier: resolveTier(pick('CLAUDE_MEM_GROK_BOT_INJECT_TIER')),
    window: resolveIndexWindow(pick('CLAUDE_MEM_GROK_BOT_INJECT_WINDOW') || DEFAULT_INDEX_WINDOW),
    maxLineChars: Math.min(
      Number(pick('CLAUDE_MEM_GROK_BOT_INJECT_MAX_LINE_CHARS')) || DEFAULT_INDEX_LINE_CHARS,
      480,
    ),
    debounceMs: Number.isFinite(debounceRaw) && debounceRaw >= 0 ? debounceRaw : DEFAULT_DEBOUNCE_MS,
    agentDataRoot: discoverGrokBotAgentDataRoot(env),
    watchConfigFile: pick('CLAUDE_MEM_TRANSCRIPTS_CONFIG_PATH') || path.join(
      env.CLAUDE_MEM_DATA_DIR?.trim() || path.join(process.env.HOME || '', '.claude-mem'),
      'transcript-watch.json',
    ),
  };
}

export function listLiveGrokBotAgents(agentDataRoot: string): Array<{ id: string; name: string }> {
  const agentsDir = path.join(agentDataRoot, 'agents');
  if (!existsSync(agentsDir)) return [];
  const out: Array<{ id: string; name: string }> = [];
  for (const entry of readdirSync(agentsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !AGENT_ID_RE.test(entry.name)) continue;
    const profilePath = path.join(agentsDir, entry.name, 'profile.json');
    if (!existsSync(profilePath)) continue;
    let name = entry.name;
    try {
      const profile = JSON.parse(readFileSync(profilePath, 'utf8')) as { name?: unknown };
      if (typeof profile?.name === 'string' && profile.name.trim()) name = profile.name.trim();
    } catch {
      // keep id
    }
    out.push({ id: entry.name, name });
  }
  return out;
}

export function projectsForAgent(cfg: GrokBotIndexConfig, agentId: string, seatName?: string): string[] {
  const override = cfg.projectsByAgent.get(agentId.toLowerCase());
  if (override) return override;
  const watches = ((readJson(cfg.watchConfigFile, {}) as { watches?: Array<Record<string, unknown>> })?.watches) ?? [];
  const projects: string[] = [];
  for (const watch of watches) {
    if (String(watch?.agentId ?? '').toLowerCase() !== agentId.toLowerCase()) continue;
    const project = String(watch?.project ?? '').trim();
    if (project && !projects.includes(project)) projects.push(project);
  }
  if (projects.length === 0 && seatName) {
    projects.push(resolveGrokBotProject(seatName));
  }
  return projects;
}

export function resolveIndexSeats(cfg: GrokBotIndexConfig): GrokBotIndexSeat[] {
  const live = listLiveGrokBotAgents(cfg.agentDataRoot);
  const selected = cfg.agentIdsAuto
    ? live
    : live.filter(agent => cfg.agentIds.includes(agent.id));
  return selected.map(agent => ({
    id: agent.id,
    name: agent.name,
    projects: projectsForAgent(cfg, agent.id, agent.name),
  }));
}

function openReadonlyObservationDb(): Database | null {
  try {
    if (!existsSync(DB_PATH)) return null;
    const db = new Database(DB_PATH, { readonly: true, create: false });
    db.run(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
    return db;
  } catch (error) {
    logger.warn('GROK_INDEX', 'Could not open observations DB for live INDEX', {}, error instanceof Error ? error : undefined);
    return null;
  }
}

export function defaultIndexQueries(): GrokBotIndexQueryFns {
  const config = loadContextConfig();
  return {
    querySeat(projects, limit, platformSource) {
      const db = openReadonlyObservationDb();
      if (!db) return [];
      try {
        return queryObservationsNewest({ db }, config, { limit, platformSource, projects });
      } finally {
        db.close();
      }
    },
    queryHouse(limit, platformSource) {
      const db = openReadonlyObservationDb();
      if (!db) return [];
      try {
        return queryObservationsNewest({ db }, config, { limit, platformSource });
      } finally {
        db.close();
      }
    },
  };
}

export function refreshSeatIndex(
  cfg: GrokBotIndexConfig,
  seat: GrokBotIndexSeat,
  queries: GrokBotIndexQueryFns,
  now: Date = new Date(),
): GrokBotIndexRefreshResult {
  const agentDir = path.join(cfg.agentDataRoot, 'agents', seat.id);
  if (!existsSync(agentDir)) {
    return { agentId: seat.id, projects: seat.projects, status: 'skipped', reason: 'agent dir missing' };
  }
  if (seat.projects.length === 0) {
    return { agentId: seat.id, projects: seat.projects, status: 'skipped', reason: 'no project mapped for agent' };
  }

  const filePath = injectLogPath(cfg.agentDataRoot, seat.id);
  assertSafeInjectPath(cfg.agentDataRoot, seat.id, filePath);

  const platformSource = cfg.platformSource || undefined;
  const seatRows = queries.querySeat(seat.projects, cfg.window, platformSource);
  const houseRows = cfg.fallback === 'house'
    ? queries.queryHouse(cfg.window, platformSource)
    : [];
  const merged = mergeIndexObservations(seatRows, houseRows, cfg.window);
  const houseFilled = cfg.fallback === 'house' && merged.some(row => !seatRows.some(seatRow => seatRow.id === row.id));

  const factLines = formatIndexFactLines(merged, {
    primaryProject: seat.projects[seat.projects.length - 1] ?? seat.name,
    window: cfg.window,
    maxLineChars: cfg.maxLineChars,
    tier: cfg.tier,
    now,
    houseFilled,
  });
  const contents = renderIndexFile(factLines);
  const existing = existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
  if (!shouldRewriteInject(existing, contents)) {
    return {
      agentId: seat.id,
      projects: seat.projects,
      status: 'unchanged',
      filePath,
      factLines: factLines.length,
      houseFilled,
    };
  }

  writeFileIfChanged(filePath, contents);
  return {
    agentId: seat.id,
    projects: seat.projects,
    status: 'written',
    filePath,
    factLines: factLines.length,
    houseFilled,
  };
}

export async function refreshGrokBotIndexes(
  cfg: GrokBotIndexConfig = loadGrokBotIndexConfig(),
  queries: GrokBotIndexQueryFns = defaultIndexQueries(),
  now: Date = new Date(),
): Promise<GrokBotIndexRefreshResult[]> {
  if (!cfg.enabled) return [];
  const seats = resolveIndexSeats(cfg);
  const results: GrokBotIndexRefreshResult[] = [];
  for (const seat of seats) {
    try {
      const result = refreshSeatIndex(cfg, seat, queries, now);
      results.push(result);
      if (result.status === 'written') {
        logger.info('GROK_INDEX', 'Wrote live Grok Bot INDEX', {
          agentId: seat.id,
          projects: seat.projects,
          factLines: result.factLines,
          houseFilled: result.houseFilled,
          filePath: result.filePath,
        });
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.warn('GROK_INDEX', 'Failed to write live Grok Bot INDEX', { agentId: seat.id }, err);
      results.push({ agentId: seat.id, projects: seat.projects, status: 'error', reason: err.message });
    }
  }
  return results;
}

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let refreshInFlight = false;
let refreshQueued = false;

export function notifyGrokBotIndex(): void {
  try {
    const cfg = loadGrokBotIndexConfig();
    if (!cfg.enabled) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void runDebouncedRefresh();
    }, cfg.debounceMs);
  } catch (error) {
    logger.warn('GROK_INDEX', 'Grok Bot INDEX notify skipped', {}, error instanceof Error ? error : undefined);
  }
}

async function runDebouncedRefresh(): Promise<void> {
  if (refreshInFlight) {
    refreshQueued = true;
    return;
  }
  refreshInFlight = true;
  try {
    await refreshGrokBotIndexes();
  } catch (error) {
    logger.warn('GROK_INDEX', 'Grok Bot INDEX refresh failed', {}, error instanceof Error ? error : undefined);
  } finally {
    refreshInFlight = false;
    if (refreshQueued) {
      refreshQueued = false;
      void runDebouncedRefresh();
    }
  }
}

/** Test helper: drop in-flight debounce so unit tests do not leak timers. */
export function resetGrokBotIndexWriterForTests(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  refreshInFlight = false;
  refreshQueued = false;
}

/** Used by installer printout / --status-style checks. */
export function ensureIndexLogDir(agentDataRoot: string, agentId: string): string {
  const filePath = injectLogPath(agentDataRoot, agentId);
  assertSafeInjectPath(agentDataRoot, agentId, filePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  return filePath;
}
