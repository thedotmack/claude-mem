
import express, { Request, Response } from 'express';
import { z } from 'zod';
import path from 'path';
import { existsSync, renameSync } from 'fs';
import { getPackageRoot, paths, expandTilde } from '../../../../shared/paths.js';
import { logger } from '../../../../utils/logger.js';
import { SettingsManager } from '../../SettingsManager.js';
import { MIN_CONTEXT_WINDOW_TOKENS, OBSERVER_MAX_OUTPUT_TOKENS_BOUNDS } from '../../context-window.js';
import { ModeManager } from '../../../domain/ModeManager.js';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import { validateBody } from '../middleware/validateBody.js';
import { SettingsDefaultsManager } from '../../../../shared/SettingsDefaultsManager.js';
import { clearPortCache } from '../../../../shared/worker-utils.js';
import { snapshotDependencyHealth } from '../../../../shared/dependency-health.js';
import { ensureSettingsDocument, updateSettingsDocument } from '../../../../shared/settings-document.js';
import { isHttpUrl } from '../../../../shared/openrouter-base-url.js';
import { OPENROUTER_REASONING_EFFORTS, parseOpenRouterReasoningEffort } from '../../OpenRouterProvider.js';
import { CODEX_REASONING_EFFORTS, isCodexReasoningEffort } from '../../CodexProvider.js';
import { emitContextInvalidation, noteUserSettingsSaved } from '../../../../shared/context-invalidation.js';

const toggleMcpSchema = z.object({
  enabled: z.boolean(),
}).passthrough();

const updateSettingsSchema = z.object({}).passthrough();

// GET /api/settings has no auth. Mask known secrets before they leave the
// process. Explicit allowlist — a /API_KEY|_TOKEN|SECRET/i regex also matches
// CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS / SHOW_WORK_TOKENS (boolean display
// prefs) and corrupts them on every GET (#3680 / #3861).
const SECRET_SETTING_KEYS = new Set([
  'CLAUDE_MEM_GEMINI_API_KEY',
  // The rotation pools hold credentials exactly like the singular keys above.
  // Leaving them out would mask the primary key and hand back every rotation
  // key in cleartext from an unauthenticated GET.
  'CLAUDE_MEM_GEMINI_API_KEYS',
  'CLAUDE_MEM_OPENROUTER_API_KEY',
  'CLAUDE_MEM_OPENROUTER_API_KEYS',
  'CLAUDE_MEM_OPENAI_COMPAT_API_KEY',
  'CLAUDE_MEM_OPENAI_COMPAT_API_KEYS',
  'CLAUDE_MEM_CHROMA_API_KEY',
  'CLAUDE_MEM_CLOUD_SYNC_TOKEN',
  'CLAUDE_MEM_TELEGRAM_BOT_TOKEN',
  'CLAUDE_MEM_TELEGRAM_WRAPUP_ROUTES',
  'CLAUDE_MEM_SERVER_API_KEY',
  'CLAUDE_MEM_SERVER_BETA_API_KEY',
  'CLAUDE_MEM_TV_TOKEN',
  'CLAUDE_MEM_PRO_MEMORY_KEY',
  'CLAUDE_MEM_REDIS_URL',
  // Brainbeat webhook: the shared secret, and the URL (it can carry userinfo
  // or query tokens). Both are file/env only — never on the POST whitelist.
  'CLAUDE_MEM_GROK_BOT_WEBHOOK_SECRET',
  'CLAUDE_MEM_GROK_BOT_WEBHOOK_URL',
]);

function maskSecretString(value: string): string {
  if (value.length <= 4) return '*'.repeat(value.length);
  return `${'*'.repeat(value.length - 4)}${value.slice(-4)}`;
}

/**
 * A secret as GET may show it, in every shape settings.json can hold: a string
 * (a single key, or a comma/newline list, masked as a whole), an array (a key
 * pool written as JSON: each entry masked), or anything else (hidden whole).
 * Empty values stay as they are, so the viewer can tell "unset" apart.
 */
function maskSecretValue(value: unknown): unknown {
  if (value === undefined || value === null || value === '') return value;
  if (typeof value === 'string') return maskSecretString(value);
  if (Array.isArray(value)) return value.map(entry => (typeof entry === 'string' ? maskSecretString(entry) : '****'));
  return '****';
}

// Viewer save posts the GET body back unchanged. Treat a secret as untouched
// only when the submitted value equals the mask of the currently stored
// secret — not "any string starting with *", which would silently drop a
// legitimate replacement key that happens to begin with '*'. Arrays compare
// entry by entry, so a pool written as JSON survives a save too.
function isUnchangedMaskedSecret(incoming: unknown, stored: unknown): boolean {
  if (incoming === undefined || incoming === null || incoming === '') return false;
  return JSON.stringify(incoming) === JSON.stringify(maskSecretValue(stored));
}

/** The posted settings whose value differs from the one settings.json holds. */
function settingsChangedBy(posted: Record<string, unknown>, onDisk: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(posted).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(onDisk[key])),
  );
}

function redactSecretSettings<T extends object>(settings: T): T {
  const redacted: Record<string, unknown> = { ...(settings as Record<string, unknown>) };
  for (const key of SECRET_SETTING_KEYS) {
    if (key in redacted) {
      redacted[key] = maskSecretValue(redacted[key]);
    }
  }
  return redacted as T;
}

/**
 * The posted settings minus those that only echo an environment override: the
 * variable is set, and the viewer sent back what GET showed for it (masked,
 * for a secret). The environment is that value's only source, so a save
 * neither checks nor writes it. Written, it would outlive the variable, and a
 * masked secret would replace the stored key.
 */
function withoutEnvironmentEchoes(posted: Record<string, unknown>, settingsPath: string): Record<string, unknown> {
  const shown = redactSecretSettings(SettingsDefaultsManager.loadFromFile(settingsPath)) as unknown as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(posted).filter(([key, value]) =>
      process.env[key] === undefined || JSON.stringify(value) !== JSON.stringify(shown[key])),
  );
}

// Spawn-binary paths: file/env only. Even if a key is accidentally re-added to
// the HTTP write list below, this set keeps it from being persisted via POST.
const FILE_ONLY_SETTING_KEYS = new Set([
  'CLAUDE_CODE_PATH',
  'CLAUDE_MEM_CODEX_PATH',
]);

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function splitHostHeader(hostHeader: string): { hostname: string; port: string } {
  if (hostHeader.startsWith('[')) {
    const match = hostHeader.match(/^\[([^\]]+)\](?::(\d+))?$/);
    return { hostname: match?.[1] ?? hostHeader, port: match?.[2] ?? '80' };
  }
  const colon = hostHeader.lastIndexOf(':');
  if (colon === -1) return { hostname: hostHeader, port: '80' };
  return { hostname: hostHeader.slice(0, colon), port: hostHeader.slice(colon + 1) };
}

/**
 * True when a browser Origin is present and is not the same loopback host:port
 * as this request. Used to reject settings writes from other localhost pages
 * without adding a new auth scheme. Exported for unit tests.
 */
export function isForeignLoopbackBrowserWrite(req: Pick<Request, 'headers'>): boolean {
  const rawOrigin = req.headers?.origin;
  if (Array.isArray(rawOrigin)) return true;
  const origin = rawOrigin;
  if (typeof origin !== 'string' || origin.length === 0) return false;

  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    return true;
  }
  if (originUrl.protocol !== 'http:') return true;
  if (!LOOPBACK_HOSTNAMES.has(originUrl.hostname)) return true;

  const rawHost = req.headers?.host;
  if (Array.isArray(rawHost)) return true;
  const hostHeader = rawHost;
  if (typeof hostHeader !== 'string' || hostHeader.length === 0) return true;

  const { hostname, port } = splitHostHeader(hostHeader);
  if (!LOOPBACK_HOSTNAMES.has(hostname)) return true;

  const originPort = originUrl.port || '80';
  return originPort !== port;
}

export class SettingsRoutes extends BaseRouteHandler {
  constructor(
    private settingsManager: SettingsManager
  ) {
    super();
  }

  setupRoutes(app: express.Application): void {
    app.get('/api/settings', this.handleGetSettings.bind(this));
    app.post('/api/settings', validateBody(updateSettingsSchema), this.handleUpdateSettings.bind(this));
    app.get('/api/settings/dependency-health', this.handleGetDependencyHealth.bind(this));

    app.get('/api/mcp/status', this.handleGetMcpStatus.bind(this));
    app.post('/api/mcp/toggle', validateBody(toggleMcpSchema), this.handleToggleMcp.bind(this));
  }

  private handleGetSettings = this.wrapHandler((req: Request, res: Response): void => {
    const settingsPath = paths.settings();
    ensureSettingsDocument(settingsPath, SettingsDefaultsManager.getAllDefaults());
    const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
    res.json(redactSecretSettings(settings));
  });

  private handleGetDependencyHealth = this.wrapHandler((_req: Request, res: Response): void => {
    res.json(snapshotDependencyHealth());
  });

  private handleUpdateSettings = this.wrapHandler((req: Request, res: Response): void => {
    // Browser POSTs always send Origin. Reject cross-port loopback origins so
    // another http://localhost:* page cannot write settings. Origin-less
    // clients (hooks, CLI, curl) keep the existing loopback-trust model.
    if (isForeignLoopbackBrowserWrite(req)) {
      res.status(403).json({
        success: false,
        error: 'Settings writes from a different localhost origin are not allowed'
      });
      return;
    }

    const settingsPath = paths.settings();

    // The viewer posts every setting back, edited or not, as GET showed it:
    // with environment overrides applied. Those echoes are dropped first. The
    // rest is judged against settings.json itself, so only what this save
    // changes is checked: a value hand-edited into the file that the worker
    // already ignores (it falls back to the default) would otherwise fail
    // every later save of an unrelated field.
    const posted = withoutEnvironmentEchoes(req.body, settingsPath);
    const validation = this.validateSettings(
      settingsChangedBy(posted, SettingsDefaultsManager.loadFromFile(settingsPath, false) as unknown as Record<string, unknown>),
    );
    if (!validation.valid) {
      res.status(400).json({
        success: false,
        error: validation.error
      });
      return;
    }

    // Write whitelist. POST /api/settings has no authentication — the worker
    // trusts loopback — so any page that can reach this origin could set one
    // of these. Secrets stay off this list except the two provider keys the
    // viewer Settings UI must save (Gemini / OpenRouter); those are masked on
    // GET and an unchanged mask is skipped on POST. Observation TV / Chroma /
    // Telegram / CloudSync / Redis tokens remain file/env only.
    //
    // Executable spawn paths (CLAUDE_CODE_PATH, CLAUDE_MEM_CODEX_PATH) are also
    // file/env only: each value is a binary the worker spawns, so it must not be
    // HTTP-writable.
    const settingKeys = [
      'CLAUDE_MEM_MODEL',
      'CLAUDE_MEM_CONTEXT_OBSERVATIONS',
      'CLAUDE_MEM_SESSION_START_INCLUDE_ALL_SOURCES',
      'CLAUDE_MEM_WORKER_PORT',
      'CLAUDE_MEM_WORKER_HOST',
      'CLAUDE_MEM_PROVIDER',
      'CLAUDE_MEM_CODEX_MODEL',
      'CLAUDE_MEM_CODEX_REASONING_EFFORT',
      'CLAUDE_MEM_CLAUDE_AUTH_METHOD',
      'CLAUDE_MEM_GEMINI_API_KEY',
      'CLAUDE_MEM_GEMINI_API_KEYS',
      'CLAUDE_MEM_GEMINI_MODEL',
      'CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED',
      'CLAUDE_MEM_OPENROUTER_API_KEY',
      'CLAUDE_MEM_OPENROUTER_API_KEYS',
      'CLAUDE_MEM_OPENROUTER_BASE_URL',
      'CLAUDE_MEM_OPENROUTER_MODEL',
      'CLAUDE_MEM_OPENROUTER_SITE_URL',
      'CLAUDE_MEM_OPENROUTER_APP_NAME',
      // The openai-compatible endpoint, as the viewer edits it. Its key stays
      // file/env only (CLAUDE_MEM_OPENAI_COMPAT_API_KEY / OPENAI_COMPAT_API_KEY).
      'CLAUDE_MEM_OPENAI_COMPAT_PRESET',
      'CLAUDE_MEM_OPENAI_COMPAT_BASE_URL',
      'CLAUDE_MEM_OPENAI_COMPAT_MODEL',
      'CLAUDE_MEM_OPENROUTER_REASONING_EFFORT',
      'CLAUDE_MEM_OBSERVER_CONTEXT_WINDOW',
      'CLAUDE_MEM_OBSERVER_MAX_OUTPUT_TOKENS',
      'CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER',
      'CLAUDE_MEM_QUOTA_FALLBACK_MODEL',
      'CLAUDE_MEM_DATA_DIR',
      'CLAUDE_MEM_LOG_LEVEL',
      'CLAUDE_MEM_PYTHON_VERSION',
      'CLAUDE_MEM_CLAUDE_CONFIG_DIR',
      'CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS',
      'CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS',
      'CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT',
      'CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT',
      'CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES',
      'CLAUDE_MEM_CONTEXT_OBSERVATION_CONCEPTS',
      'CLAUDE_MEM_CONTEXT_FULL_COUNT',
      'CLAUDE_MEM_CONTEXT_FULL_FIELD',
      'CLAUDE_MEM_CONTEXT_SESSION_COUNT',
      'CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY',
      'CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE',
      'CLAUDE_MEM_FILE_READ_GATE_ENABLED',
      'CLAUDE_MEM_CONTEXT_MAIN_AGENT_ONLY',
      'CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED',
    ];

    // Every rule runs inside the settings-document boundary's mutate callback,
    // which sees the CURRENT on-disk settings (flat, or the env block of a
    // wrapped document) and refuses — without writing — a corrupt file.
    const result = updateSettingsDocument(settingsPath, {}, SettingsDefaultsManager.getAllDefaults(), target => {
      for (const key of settingKeys) {
        if (FILE_ONLY_SETTING_KEYS.has(key)) continue;
        if (posted[key] === undefined) continue;
        // The viewer posts GET's masked secret back unchanged: keep the stored value.
        if (SECRET_SETTING_KEYS.has(key) && isUnchangedMaskedSecret(posted[key], target[key])) continue;
        target[key] = posted[key];
      }

      // Expand `~` on a CLAUDE_CODE_PATH that was already on disk (file/env).
      // HTTP cannot set this key; the expand is only so a tilde written by the
      // user in settings.json is resolved before posix_spawn sees it.
      if (typeof target.CLAUDE_CODE_PATH === 'string' && target.CLAUDE_CODE_PATH) {
        target.CLAUDE_CODE_PATH = expandTilde(target.CLAUDE_CODE_PATH);
      }
    });
    if (result.status === 'refused') {
      logger.error('HTTP', 'Failed to persist settings file', { settingsPath }, result.error instanceof Error ? result.error : new Error(String(result.error)));
      res.status(500).json({ success: false, error: `Settings file could not be updated. Repair or restore ${settingsPath}.` });
      return;
    }

    clearPortCache();
    // Drop cached settings snapshots first, so the re-render below reads this save.
    noteUserSettingsSaved();
    // Context settings (counts, columns, welcome hint) shape the SessionStart block.
    emitContextInvalidation('all', 'settings');

    logger.info('WORKER', 'Settings updated');
    res.json({ success: true, message: 'Settings updated successfully' });
  });

  private handleGetMcpStatus = this.wrapHandler((req: Request, res: Response): void => {
    const enabled = this.isMcpEnabled();
    res.json({ enabled });
  });

  private handleToggleMcp = this.wrapHandler((req: Request, res: Response): void => {
    const { enabled } = req.body as z.infer<typeof toggleMcpSchema>;

    this.toggleMcp(enabled);
    res.json({ success: true, enabled: this.isMcpEnabled() });
  });

  private validateSettings(settings: any): { valid: boolean; error?: string } {
    for (const key of ['CLAUDE_MEM_CODEX_MODEL', 'CLAUDE_MEM_CODEX_REASONING_EFFORT'] as const) {
      if (settings[key] !== undefined && typeof settings[key] !== 'string') {
        return { valid: false, error: `${key} must be a string` };
      }
    }

    // An effort Codex does not know fails every Codex request, and the
    // app-server takes any string. Like every rule here, it sees only the
    // values this save changes (settingsChangedBy).
    const codexEffort = settings.CLAUDE_MEM_CODEX_REASONING_EFFORT;
    if (typeof codexEffort === 'string' && codexEffort.trim() && !isCodexReasoningEffort(codexEffort.trim())) {
      return {
        valid: false,
        error: `CLAUDE_MEM_CODEX_REASONING_EFFORT must be empty (Codex's default) or one of: ${CODEX_REASONING_EFFORTS.join(', ')}`,
      };
    }

    if (settings.CLAUDE_MEM_PROVIDER) {
    const validProviders = ['claude', 'gemini', 'openrouter', 'codex', 'openai-compatible'];
    if (!validProviders.includes(settings.CLAUDE_MEM_PROVIDER)) {
      return { valid: false, error: 'CLAUDE_MEM_PROVIDER must be "claude", "gemini", "openrouter", "codex", or "openai-compatible"' };
      }
    }

    // Empty is valid: it turns the fallback off.
    if (settings.CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER) {
      // The names provider-dispatch's QUOTA_FALLBACK_PROVIDERS accepts.
      const validFallbacks = ['claude', 'gemini', 'openrouter', 'openai-compatible'];
      if (!validFallbacks.includes(settings.CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER)) {
        return { valid: false, error: 'CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER must be empty (off), "claude", "gemini", "openrouter", or "openai-compatible"' };
      }
    }

    if (settings.CLAUDE_MEM_CLAUDE_AUTH_METHOD) {
      const validClaudeAuthMethods = ['subscription', 'api-key', 'gateway', 'cli'];
      if (!validClaudeAuthMethods.includes(settings.CLAUDE_MEM_CLAUDE_AUTH_METHOD)) {
        return { valid: false, error: 'CLAUDE_MEM_CLAUDE_AUTH_METHOD must be "subscription", "api-key", "gateway", or "cli"' };
      }
    }

    if (settings.CLAUDE_MEM_GEMINI_MODEL) {
      const validGeminiModels = ['gemini-flash-latest', 'gemini-flash-lite-latest', 'gemini-3.5-flash', 'gemini-3.1-flash-lite', 'gemini-3-flash-preview'];
      if (!validGeminiModels.includes(settings.CLAUDE_MEM_GEMINI_MODEL)) {
        return { valid: false, error: 'CLAUDE_MEM_GEMINI_MODEL must be one of: gemini-flash-latest, gemini-flash-lite-latest, gemini-3.5-flash, gemini-3.1-flash-lite, gemini-3-flash-preview' };
      }
    }

    if (settings.CLAUDE_MEM_CONTEXT_OBSERVATIONS) {
      const obsCount = parseInt(settings.CLAUDE_MEM_CONTEXT_OBSERVATIONS, 10);
      if (isNaN(obsCount) || obsCount < 1 || obsCount > 200) {
        return { valid: false, error: 'CLAUDE_MEM_CONTEXT_OBSERVATIONS must be between 1 and 200' };
      }
    }

    // Empty = resolve the window automatically. Otherwise whole tokens, at
    // least the floor the resolver would clamp a smaller value up to.
    if (settings.CLAUDE_MEM_OBSERVER_CONTEXT_WINDOW) {
      const raw = String(settings.CLAUDE_MEM_OBSERVER_CONTEXT_WINDOW).trim();
      if (!/^\d+$/.test(raw) || Number(raw) < MIN_CONTEXT_WINDOW_TOKENS) {
        return { valid: false, error: `CLAUDE_MEM_OBSERVER_CONTEXT_WINDOW must be empty (automatic) or a whole number of tokens, at least ${MIN_CONTEXT_WINDOW_TOKENS}` };
      }
    }

    // A whole number of tokens inside the bounds the resolver accepts; anything
    // else would silently fall back to the default at request time.
    if (settings.CLAUDE_MEM_OBSERVER_MAX_OUTPUT_TOKENS !== undefined) {
      const raw = String(settings.CLAUDE_MEM_OBSERVER_MAX_OUTPUT_TOKENS).trim();
      const { min, max } = OBSERVER_MAX_OUTPUT_TOKENS_BOUNDS;
      if (!/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max) {
        return { valid: false, error: `CLAUDE_MEM_OBSERVER_MAX_OUTPUT_TOKENS must be a whole number of tokens between ${min} and ${max}` };
      }
    }

    if (settings.CLAUDE_MEM_SESSION_START_INCLUDE_ALL_SOURCES !== undefined
      && !['true', 'false'].includes(settings.CLAUDE_MEM_SESSION_START_INCLUDE_ALL_SOURCES)) {
      return { valid: false, error: 'CLAUDE_MEM_SESSION_START_INCLUDE_ALL_SOURCES must be "true" or "false"' };
    }

    if (settings.CLAUDE_MEM_WORKER_PORT) {
      const port = parseInt(settings.CLAUDE_MEM_WORKER_PORT, 10);
      if (isNaN(port) || port < 1024 || port > 65535) {
        return { valid: false, error: 'CLAUDE_MEM_WORKER_PORT must be between 1024 and 65535' };
      }
    }

    if (settings.CLAUDE_MEM_WORKER_HOST) {
      const host = settings.CLAUDE_MEM_WORKER_HOST;
      // Loopback, plus the documented bind-all addresses used by Observation TV
      // and Docker (docs/public/configuration.mdx). Arbitrary IPv4 used to be
      // accepted and would expose the unauthenticated worker API on that NIC.
      const validHostPattern = /^(127\.0\.0\.1|0\.0\.0\.0|::1|::|localhost)$/;
      if (!validHostPattern.test(host)) {
        return { valid: false, error: 'CLAUDE_MEM_WORKER_HOST must be a loopback address (127.0.0.1, ::1, localhost) or a bind-all address (0.0.0.0, ::) for Observation TV / Docker' };
      }
    }

    if (settings.CLAUDE_MEM_LOG_LEVEL) {
      const validLevels = ['DEBUG', 'INFO', 'WARN', 'ERROR', 'SILENT'];
      if (!validLevels.includes(settings.CLAUDE_MEM_LOG_LEVEL.toUpperCase())) {
        return { valid: false, error: 'CLAUDE_MEM_LOG_LEVEL must be one of: DEBUG, INFO, WARN, ERROR, SILENT' };
      }
    }

    if (settings.CLAUDE_MEM_PYTHON_VERSION) {
      const pythonVersionRegex = /^3\.\d{1,2}$/;
      if (!pythonVersionRegex.test(settings.CLAUDE_MEM_PYTHON_VERSION)) {
        return { valid: false, error: 'CLAUDE_MEM_PYTHON_VERSION must be in format "3.X" or "3.XX" (e.g., "3.13")' };
      }
    }

    // #2753 — CLAUDE_MEM_CLAUDE_CONFIG_DIR controls which keychain identity's
    // OAuth token gets read (oauth-token.ts's deriveMacKeychainServiceName)
    // and which CLAUDE_CONFIG_DIR gets stamped onto every spawned SDK
    // subprocess (EnvManager.ts's buildIsolatedEnv), so — unlike most of this
    // whitelist — a malformed value here has spawn/auth-identity consequences,
    // not just a rejected form field. Empty string is valid (the documented
    // "fall through to default" sentinel); a present value must be a
    // non-empty-after-trim string so a type-confused payload (number, array,
    // object) can't reach path.join/createHash downstream.
    if (settings.CLAUDE_MEM_CLAUDE_CONFIG_DIR !== undefined && settings.CLAUDE_MEM_CLAUDE_CONFIG_DIR !== '') {
      if (typeof settings.CLAUDE_MEM_CLAUDE_CONFIG_DIR !== 'string' || !settings.CLAUDE_MEM_CLAUDE_CONFIG_DIR.trim()) {
        return { valid: false, error: 'CLAUDE_MEM_CLAUDE_CONFIG_DIR must be a non-empty path string, or "" to use the default' };
      }
    }

    const booleanSettings = [
      'CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS',
      'CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS',
      'CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT',
      'CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT',
      'CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY',
      'CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE',
      'CLAUDE_MEM_FILE_READ_GATE_ENABLED',
      'CLAUDE_MEM_CONTEXT_MAIN_AGENT_ONLY',
    ];

    for (const key of booleanSettings) {
      if (settings[key] && !['true', 'false'].includes(settings[key])) {
        return { valid: false, error: `${key} must be "true" or "false"` };
      }
    }

    if (settings.CLAUDE_MEM_CONTEXT_FULL_COUNT) {
      const count = parseInt(settings.CLAUDE_MEM_CONTEXT_FULL_COUNT, 10);
      if (isNaN(count) || count < 0 || count > 20) {
        return { valid: false, error: 'CLAUDE_MEM_CONTEXT_FULL_COUNT must be between 0 and 20' };
      }
    }

    if (settings.CLAUDE_MEM_CONTEXT_SESSION_COUNT) {
      const count = parseInt(settings.CLAUDE_MEM_CONTEXT_SESSION_COUNT, 10);
      if (isNaN(count) || count < 1 || count > 50) {
        return { valid: false, error: 'CLAUDE_MEM_CONTEXT_SESSION_COUNT must be between 1 and 50' };
      }
    }

    if (settings.CLAUDE_MEM_CONTEXT_FULL_FIELD) {
      if (!['narrative', 'facts'].includes(settings.CLAUDE_MEM_CONTEXT_FULL_FIELD)) {
        return { valid: false, error: 'CLAUDE_MEM_CONTEXT_FULL_FIELD must be "narrative" or "facts"' };
      }
    }

    if (settings.CLAUDE_MEM_OPENROUTER_REASONING_EFFORT
      && !parseOpenRouterReasoningEffort(settings.CLAUDE_MEM_OPENROUTER_REASONING_EFFORT)) {
      return { valid: false, error: `CLAUDE_MEM_OPENROUTER_REASONING_EFFORT must be empty or one of: ${OPENROUTER_REASONING_EFFORTS.join(', ')}` };
    }

    if (settings.CLAUDE_MEM_OPENROUTER_SITE_URL) {
      try {
        new URL(settings.CLAUDE_MEM_OPENROUTER_SITE_URL);
      } catch (error) {
        logger.debug('SETTINGS', 'Invalid URL format', { url: settings.CLAUDE_MEM_OPENROUTER_SITE_URL, error: error instanceof Error ? error.message : String(error) });
        return { valid: false, error: 'CLAUDE_MEM_OPENROUTER_SITE_URL must be a valid URL' };
      }
    }

    if (settings.CLAUDE_MEM_OPENROUTER_BASE_URL) {
      if (!isHttpUrl(settings.CLAUDE_MEM_OPENROUTER_BASE_URL)) {
        logger.debug('SETTINGS', 'Invalid OpenRouter base URL protocol', { url: settings.CLAUDE_MEM_OPENROUTER_BASE_URL });
        return { valid: false, error: 'CLAUDE_MEM_OPENROUTER_BASE_URL must be an HTTP(S) URL' };
      }
    }

    // No preset-id check: the viewer posts the whole settings object, so a
    // hand-edited unknown preset would 400 every later save, and the worker
    // already reads an unknown preset as `custom`.
    if (settings.CLAUDE_MEM_OPENAI_COMPAT_BASE_URL && !isHttpUrl(settings.CLAUDE_MEM_OPENAI_COMPAT_BASE_URL)) {
      return { valid: false, error: 'CLAUDE_MEM_OPENAI_COMPAT_BASE_URL must be an HTTP(S) URL' };
    }

    if (settings.CLAUDE_MEM_CLOUD_SYNC_CONTENT_BATCH_SIZE) {
      const batch = parseInt(settings.CLAUDE_MEM_CLOUD_SYNC_CONTENT_BATCH_SIZE, 10);
      if (isNaN(batch) || batch < 1 || batch > 500) {
        return { valid: false, error: 'CLAUDE_MEM_CLOUD_SYNC_CONTENT_BATCH_SIZE must be between 1 and 500' };
      }
    }

    if (settings.CLAUDE_MEM_CLOUD_SYNC_REQUEST_TIMEOUT_MS) {
      const timeoutMs = parseInt(settings.CLAUDE_MEM_CLOUD_SYNC_REQUEST_TIMEOUT_MS, 10);
      if (isNaN(timeoutMs) || timeoutMs < 5000 || timeoutMs > 180000) {
        return { valid: false, error: 'CLAUDE_MEM_CLOUD_SYNC_REQUEST_TIMEOUT_MS must be between 5000 and 180000' };
      }
    }

    return { valid: true };
  }

  private isMcpEnabled(): boolean {
    const packageRoot = getPackageRoot();
    const mcpPath = path.join(packageRoot, 'plugin', '.mcp.json');
    return existsSync(mcpPath);
  }

  private toggleMcp(enabled: boolean): void {
    const packageRoot = getPackageRoot();
    const mcpPath = path.join(packageRoot, 'plugin', '.mcp.json');
    const mcpDisabledPath = path.join(packageRoot, 'plugin', '.mcp.json.disabled');

    if (enabled && existsSync(mcpDisabledPath)) {
      renameSync(mcpDisabledPath, mcpPath);
      logger.info('WORKER', 'MCP search server enabled');
    } else if (!enabled && existsSync(mcpPath)) {
      renameSync(mcpPath, mcpDisabledPath);
      logger.info('WORKER', 'MCP search server disabled');
    } else {
      logger.debug('WORKER', 'MCP toggle no-op (already in desired state)', { enabled });
    }
  }

}
