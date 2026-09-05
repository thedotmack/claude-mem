/**
 * Configuration resolution for the harness.
 *
 * Two independent surfaces are configured here:
 *   1. The OpenRouter model that drives the solving agent.
 *   2. The claude-mem worker whose HTTP API backs the mem-search tools.
 *
 * Both honor the same precedence claude-mem itself uses: explicit env vars win,
 * then values in ~/.claude-mem/settings.json (flat or nested under `env`), then
 * built-in defaults. This keeps the harness in lock-step with a plugin install
 * on the same machine — the agent searches the very memory the plugin writes.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

export interface OpenRouterConfig {
  apiKey: string;
  model: string;
  /** Fully-qualified chat-completions URL. */
  apiUrl: string;
  siteUrl: string;
  appName: string;
  temperature: number;
  maxTokens: number;
}

export interface WorkerConfig {
  /** Base URL of the claude-mem worker, e.g. http://127.0.0.1:37742 */
  baseUrl: string;
  /** claude-mem project name used to scope mem-search (defaults per-repo). */
  project?: string;
  /** Platform source filter for mem-search, e.g. "claude". */
  platformSource?: string;
}

let cachedSettings: Record<string, unknown> | null = null;

/** Resolve the claude-mem data dir the same way the plugin does. */
export function resolveDataDir(): string {
  if (process.env.CLAUDE_MEM_DATA_DIR) return process.env.CLAUDE_MEM_DATA_DIR;
  return join(homedir(), '.claude-mem');
}

/**
 * Load ~/.claude-mem/settings.json once. The file may store keys flat or under
 * an `env` object (claude-mem accepts both spellings), so both are merged.
 */
export function loadClaudeMemSettings(): Record<string, unknown> {
  if (cachedSettings) return cachedSettings;
  const settingsPath = join(resolveDataDir(), 'settings.json');
  let merged: Record<string, unknown> = {};
  try {
    if (existsSync(settingsPath)) {
      const raw = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>;
      const envBlock = (raw.env && typeof raw.env === 'object') ? (raw.env as Record<string, unknown>) : {};
      merged = { ...raw, ...envBlock };
    }
  } catch {
    // Missing or corrupt settings — env vars and defaults still apply.
  }
  cachedSettings = merged;
  return merged;
}

/** For tests: drop the memoized settings so a changed file is re-read. */
export function resetConfigCache(): void {
  cachedSettings = null;
}

function setting(key: string): string | undefined {
  if (process.env[key] !== undefined) return process.env[key];
  const v = loadClaudeMemSettings()[key];
  return typeof v === 'string' ? v : undefined;
}

/**
 * OpenRouter's chat-completions endpoint. A bare host or an OpenAI-compatible
 * base ("…/v1") is normalized to end in "/chat/completions"; a URL that already
 * names the endpoint is used verbatim. Mirrors the plugin's resolver so custom
 * gateways (DeepSeek, LM Studio, LiteLLM) work identically.
 */
export function resolveChatCompletionsUrl(baseUrl?: string): string {
  const DEFAULT = 'https://openrouter.ai/api/v1/chat/completions';
  const raw = (baseUrl ?? '').trim();
  if (!raw) return DEFAULT;
  const trimmed = raw.replace(/\/+$/, '');
  if (/\/chat\/completions$/.test(trimmed)) return trimmed;
  if (/\/v\d+$/.test(trimmed)) return `${trimmed}/chat/completions`;
  return `${trimmed}/chat/completions`;
}

export function resolveOpenRouterConfig(overrides: Partial<OpenRouterConfig> = {}): OpenRouterConfig {
  const apiKey =
    overrides.apiKey ??
    setting('CLAUDE_MEM_OPENROUTER_API_KEY') ??
    setting('OPENROUTER_API_KEY') ??
    '';

  const model =
    overrides.model ??
    setting('SWEBENCH_MODEL') ??
    setting('CLAUDE_MEM_OPENROUTER_MODEL') ??
    'anthropic/claude-sonnet-4.5';

  const baseUrl = setting('CLAUDE_MEM_OPENROUTER_BASE_URL') ?? setting('OPENROUTER_BASE_URL') ?? '';

  return {
    apiKey,
    model,
    apiUrl: overrides.apiUrl ?? resolveChatCompletionsUrl(baseUrl),
    siteUrl: overrides.siteUrl ?? setting('CLAUDE_MEM_OPENROUTER_SITE_URL') ?? 'https://github.com/thedotmack/claude-mem',
    appName: overrides.appName ?? setting('CLAUDE_MEM_OPENROUTER_APP_NAME') ?? 'claude-mem-swebench',
    temperature: overrides.temperature ?? numberSetting('SWEBENCH_TEMPERATURE', 0.0),
    maxTokens: overrides.maxTokens ?? numberSetting('SWEBENCH_MAX_TOKENS', 8192),
  };
}

/**
 * Default worker port matches SettingsDefaultsManager: 37700 + (uid % 100).
 * On platforms without getuid (Windows), 77 is used, exactly like the plugin.
 */
export function defaultWorkerPort(): number {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 77;
  return 37700 + (uid % 100);
}

export function resolveWorkerConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  const host = setting('CLAUDE_MEM_WORKER_HOST') ?? '127.0.0.1';
  const portStr = setting('CLAUDE_MEM_WORKER_PORT');
  const port = portStr && Number.isFinite(Number(portStr)) ? Number(portStr) : defaultWorkerPort();
  const explicitBase = setting('CLAUDE_MEM_WORKER_URL');
  return {
    baseUrl: overrides.baseUrl ?? explicitBase ?? `http://${host}:${port}`,
    project: overrides.project ?? setting('SWEBENCH_MEM_PROJECT'),
    platformSource: overrides.platformSource ?? setting('SWEBENCH_MEM_PLATFORM_SOURCE'),
  };
}

function numberSetting(key: string, fallback: number): number {
  const raw = setting(key);
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) ? n : fallback;
}
