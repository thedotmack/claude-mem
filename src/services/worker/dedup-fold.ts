import { createHash } from 'crypto';
import { join } from 'path';
import { homedir } from 'os';
import { logger } from '../../utils/logger.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';

export interface FoldKeyInput {
  tool_name: string;
  tool_input: unknown;
  cwd?: string;
  agent_id?: string;
}

function sortObjectKeys(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortObjectKeys);
  const obj = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = sortObjectKeys(obj[key]);
  }
  return sorted;
}

export function computeFoldKey(input: FoldKeyInput): string {
  const canonical = JSON.stringify({
    tool_name: input.tool_name,
    tool_input: sortObjectKeys(input.tool_input),
    cwd: input.cwd ?? '',
    agent_id: input.agent_id ?? '',
  });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

export interface DedupFoldConfig {
  enabled: boolean;
  windowSeconds: number;
  disabledTools: string[];
}

const DEFAULT_WINDOW_SECONDS = 30;
const MIN_WINDOW_SECONDS = 1;
const MAX_WINDOW_SECONDS = 3600;

export function loadDedupFoldConfig(settings: Record<string, string>): DedupFoldConfig {
  const enabled = settings.CLAUDE_MEM_DEDUP_FOLD_ENABLED === 'true';

  let windowSeconds = DEFAULT_WINDOW_SECONDS;
  const raw = settings.CLAUDE_MEM_DEDUP_FOLD_WINDOW_SECONDS;
  const parsed = parseInt(raw ?? '', 10);
  if (Number.isFinite(parsed) && parsed >= MIN_WINDOW_SECONDS && parsed <= MAX_WINDOW_SECONDS) {
    windowSeconds = parsed;
  } else if (raw && raw !== String(DEFAULT_WINDOW_SECONDS)) {
    logger.warn('DEDUP', 'invalid CLAUDE_MEM_DEDUP_FOLD_WINDOW_SECONDS, using default', undefined, { raw, default: DEFAULT_WINDOW_SECONDS });
  }

  const disabledTools = (settings.CLAUDE_MEM_DEDUP_FOLD_DISABLED_TOOLS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  return { enabled, windowSeconds, disabledTools };
}

const CACHE_TTL_MS = 5_000;
let cached: { config: DedupFoldConfig; expiresAt: number } | null = null;

export function getDedupFoldConfig(): DedupFoldConfig {
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.config;
  const dataDir = process.env.CLAUDE_MEM_DATA_DIR || join(homedir(), '.claude-mem');
  const settingsPath = join(dataDir, 'settings.json');
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  const config = loadDedupFoldConfig(settings as unknown as Record<string, string>);
  cached = { config, expiresAt: now + CACHE_TTL_MS };
  return config;
}

export function _resetDedupFoldConfigCache(): void {
  cached = null;
}
