import { logger } from './logger.js';
import { SettingsDefaultsManager } from '../shared/SettingsDefaultsManager.js';
import { join } from 'path';
import { homedir } from 'os';

export interface RedactionPattern {
  name: string;
  regex: RegExp;
}

export interface RedactionConfig {
  enabled: boolean;
  disabledBuiltinPatterns?: string[];
  customPatterns?: { name: string; regex: string }[];
  logMatches?: boolean;
}

export interface RedactionResult {
  redacted: string;
  counts: Record<string, number>;
  truncated: boolean;
}

export const BUILTIN_REDACTION_PATTERNS: RedactionPattern[] = [
  { name: 'aws_access_key',  regex: /AKIA[0-9A-Z]{16}/g },
  // Known limitation: only matches shell-style (`KEY=val`, `KEY='val'`) and
  // yaml-style (`KEY: val`); JSON-style `"KEY": "val"` is not anchored
  // because the lookbehind expects `=`/`:` directly after the key name.
  { name: 'aws_secret_key',  regex: /(?<=AWS_SECRET_ACCESS_KEY\s*[=:]\s*['"]?)[A-Za-z0-9/+=]{40}/g },
  { name: 'github_pat',      regex: /\bgh[ps]_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{82}\b/g },
  { name: 'openai_key',      regex: /\bsk-(?!ant-)[A-Za-z0-9_-]{20,}\b/g },
  { name: 'anthropic_key',   regex: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { name: 'slack_token',     regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: 'jwt',             regex: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g },
  { name: 'private_key_pem', regex: /-----BEGIN (?:RSA |DSA |EC |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |DSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g },
  { name: 'stripe_key',      regex: /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{24,}\b/g },
  { name: 'google_api_key',  regex: /\bAIza[0-9A-Za-z_-]{35}\b/g },
];

// Note: measured in UTF-16 code units (string.length), not bytes. ASCII inputs
// are equivalent; multi-byte inputs (emoji, CJK) reach the cap at fewer code
// points. Kept named *_BYTES for spec compatibility; semantics live in the
// docs/public/usage/auto-redaction.mdx "Limits" section.
const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_TOTAL_MATCHES = 200;

export function redactSensitive(input: string, config: RedactionConfig): RedactionResult {
  if (!config.enabled || input.length === 0) {
    return { redacted: input, counts: {}, truncated: false };
  }

  if (input.length > MAX_INPUT_BYTES) {
    logger.warn('REDACT', 'input exceeds 1 MB cap, skipping redaction', undefined, {
      inputLength: input.length,
    });
    return { redacted: input, counts: {}, truncated: true };
  }

  const disabled = new Set(config.disabledBuiltinPatterns ?? []);
  const counts: Record<string, number> = {};
  let working = input;
  let totalMatches = 0;
  let truncated = false;

  const compiledCustom: RedactionPattern[] = [];
  for (const cp of config.customPatterns ?? []) {
    if (!cp.name || cp.name.length === 0) {
      logger.warn('REDACT', 'custom pattern skipped: missing name', undefined, { pattern: cp });
      continue;
    }
    try {
      compiledCustom.push({ name: cp.name, regex: new RegExp(cp.regex, 'g') });
    } catch (error) {
      logger.warn('REDACT', 'custom pattern skipped: invalid regex', { name: cp.name }, error instanceof Error ? error : new Error(String(error)));
    }
  }

  const allPatterns: RedactionPattern[] = [...compiledCustom, ...BUILTIN_REDACTION_PATTERNS];

  for (const pattern of allPatterns) {
    if (disabled.has(pattern.name)) continue;
    if (truncated) break;
    pattern.regex.lastIndex = 0;
    working = working.replace(pattern.regex, (match) => {
      if (totalMatches >= MAX_TOTAL_MATCHES) {
        truncated = true;
        return match; // leave the original token in place once cap is hit
      }
      totalMatches += 1;
      counts[pattern.name] = (counts[pattern.name] ?? 0) + 1;
      return `<redacted type="${pattern.name}"/>`;
    });
  }

  if (truncated) {
    logger.warn('REDACT', 'match cap reached, some secrets may remain in output', undefined, {
      cap: MAX_TOTAL_MATCHES,
      counts,
    });
  }

  if (config.logMatches && Object.keys(counts).length > 0) {
    logger.debug('REDACT', 'patterns matched', undefined, { counts });
  }

  return { redacted: working, counts, truncated };
}

interface RedactionSettings {
  CLAUDE_MEM_REDACT_ENABLED: string;
  CLAUDE_MEM_REDACT_DISABLED_BUILTINS: string;
  CLAUDE_MEM_REDACT_CUSTOM_PATTERNS: string;
  CLAUDE_MEM_REDACT_LOG_MATCHES: string;
  CLAUDE_MEM_DATA_DIR: string;
  [key: string]: string;
}

function safeParseCustomPatterns(raw: string): { name: string; regex: string }[] {
  if (!raw || raw.trim() === '') return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      logger.warn('REDACT', 'CLAUDE_MEM_REDACT_CUSTOM_PATTERNS is not a JSON array, ignoring');
      return [];
    }
    return parsed.filter((p) => p && typeof p.name === 'string' && typeof p.regex === 'string');
  } catch (error) {
    logger.warn('REDACT', 'failed to parse CLAUDE_MEM_REDACT_CUSTOM_PATTERNS as JSON',
      undefined, error instanceof Error ? error : new Error(String(error)));
    return [];
  }
}

export function loadRedactionConfig(settings: Partial<RedactionSettings>): RedactionConfig {
  // Defensive: every field is read with a `?? ''` fallback so a settings
  // file written before Task 6 registered the defaults (or hand-edited to
  // drop a key) cannot crash the worker. `enabled` defaults to false, which
  // is also the documented user-facing default.
  return {
    enabled: settings.CLAUDE_MEM_REDACT_ENABLED === 'true',
    disabledBuiltinPatterns: (settings.CLAUDE_MEM_REDACT_DISABLED_BUILTINS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    customPatterns: safeParseCustomPatterns(settings.CLAUDE_MEM_REDACT_CUSTOM_PATTERNS ?? '[]'),
    logMatches: settings.CLAUDE_MEM_REDACT_LOG_MATCHES === 'true',
  };
}

// Cached config for the 5 hot-path call sites — avoids re-reading
// ~/.claude-mem/settings.json on every hook invocation. 5 s TTL is short
// enough that settings.json edits propagate within one hook cycle without
// requiring a worker restart.
let cachedConfig: RedactionConfig | null = null;
let cacheStamp = 0;
const CACHE_TTL_MS = 5000;

export function getRedactionConfig(): RedactionConfig {
  const now = Date.now();
  if (cachedConfig && now - cacheStamp < CACHE_TTL_MS) {
    return cachedConfig;
  }
  try {
    const dataDir = process.env.CLAUDE_MEM_DATA_DIR || join(homedir(), '.claude-mem');
    const settingsPath = join(dataDir, 'settings.json');
    const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
    // TODO(server-beta config scope): once tenant-scoped settings are sourced
    // for multi-tenant deployments, replace this single-user-settings load
    // with the tenant-resolved config. Tracked in plan polish notes.
    cachedConfig = loadRedactionConfig(settings as unknown as Partial<RedactionSettings>);
  } catch (error) {
    logger.warn('REDACT', 'failed to load redaction config, defaulting to disabled',
      undefined, error instanceof Error ? error : new Error(String(error)));
    cachedConfig = { enabled: false };
  }
  cacheStamp = now;
  return cachedConfig;
}

// Test helper — resets the cache so unit tests can re-stub settings.
export function _resetRedactionConfigCache(): void {
  cachedConfig = null;
  cacheStamp = 0;
}
