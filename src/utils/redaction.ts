import { logger } from './logger.js';
import { SettingsDefaultsManager } from '../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../shared/paths.js';

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
  /** The input was over the size cap and was replaced whole by an oversize marker. */
  oversize: boolean;
}

export const BUILTIN_REDACTION_PATTERNS: RedactionPattern[] = [
  { name: 'aws_access_key',  regex: /AKIA[0-9A-Z]{16}/g },
  // Known limitation: only matches shell-style (`KEY=val`, `KEY='val'`) and
  // yaml-style (`KEY: val`); JSON-style `"KEY": "val"` is not anchored
  // because the lookbehind expects `=`/`:` directly after the key name.
  { name: 'aws_secret_key',  regex: /(?<=AWS_SECRET_ACCESS_KEY\s*[=:]\s*['"]?)[A-Za-z0-9/+=]{40}/g },
  { name: 'github_pat',      regex: /\bgh[oprs]_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{82}\b/g },
  { name: 'openai_key',      regex: /\bsk-(?!ant-)[A-Za-z0-9_-]{20,}\b/g },
  { name: 'anthropic_key',   regex: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { name: 'slack_token',     regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: 'jwt',             regex: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g },
  { name: 'private_key_pem', regex: /-----BEGIN (?:RSA |DSA |EC |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |DSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g },
  { name: 'stripe_key',      regex: /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{24,}\b/g },
  { name: 'google_api_key',  regex: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  // claude-mem's own credentials: server API keys (`cmem_` + 43 base64url
  // chars, server-bootstrap.ts createRawApiKey) and cmem.ai Pro memory keys.
  { name: 'claude_mem_key',  regex: /\bcmem_[A-Za-z0-9_-]{32,}|\bcm_pro_[A-Za-z0-9_-]{8,}/g },
];

// Measured in UTF-16 code units (string.length). Bounds the regex work per
// field. Redaction fails closed: a field over the cap is replaced whole by an
// oversize marker rather than stored unscanned (see the "Limits" section of
// docs/public/usage/auto-redaction.mdx).
const MAX_INPUT_CHARS = 1024 * 1024;
export const OVERSIZE_MARKER = "<redacted type='oversize'/>";

export function redactSensitive(input: string, config: RedactionConfig): RedactionResult {
  if (!config.enabled || input.length === 0) {
    return { redacted: input, counts: {}, oversize: false };
  }

  if (input.length > MAX_INPUT_CHARS) {
    logger.warn('REDACT', 'field exceeds the 1M-char redaction cap; replaced by an oversize marker', undefined, {
      inputLength: input.length,
    });
    return { redacted: OVERSIZE_MARKER, counts: { oversize: 1 }, oversize: true };
  }

  const disabled = new Set(config.disabledBuiltinPatterns ?? []);
  const counts: Record<string, number> = {};
  let working = input;

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

  // Every match is redacted: there is no match cap, so a field with many
  // secrets never lets the tail through.
  for (const pattern of allPatterns) {
    if (disabled.has(pattern.name)) continue;
    pattern.regex.lastIndex = 0;
    working = working.replace(pattern.regex, () => {
      counts[pattern.name] = (counts[pattern.name] ?? 0) + 1;
      return `<redacted type='${pattern.name}'/>`;
    });
  }

  if (config.logMatches && Object.keys(counts).length > 0) {
    logger.debug('REDACT', 'patterns matched', undefined, { counts });
  }

  return { redacted: working, counts, oversize: false };
}

/**
 * Told to the observer only when a payload actually carries a marker, so
 * prompts cost nothing extra while redaction is off or found nothing.
 */
export const REDACTION_MARKER_HINT =
  `If you see a "<redacted type='...'/>" marker, that field was a recognized secret pattern and was removed before storage. Treat it as a placeholder; do not infer the literal value or copy the marker itself into generated memory content.`;

/** True when text carries a redaction marker, raw or XML-escaped. */
export function hasRedactionMarker(text: string): boolean {
  return text.includes("<redacted type='") || text.includes('&lt;redacted type=');
}

interface RedactionSettings {
  CLAUDE_MEM_REDACT_ENABLED: string;
  CLAUDE_MEM_REDACT_DISABLED_BUILTINS: string;
  CLAUDE_MEM_REDACT_CUSTOM_PATTERNS: string;
  CLAUDE_MEM_REDACT_LOG_MATCHES: string;
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

// Cached config for the tag-stripping choke point, which runs on every
// captured field — avoids re-reading settings.json each time. A 5 s TTL lets
// settings.json edits propagate within one hook cycle without a restart.
let cachedConfig: RedactionConfig | null = null;
let cacheStamp = 0;
const CACHE_TTL_MS = 5000;

export function getRedactionConfig(): RedactionConfig {
  const now = Date.now();
  if (cachedConfig && now - cacheStamp < CACHE_TTL_MS) {
    return cachedConfig;
  }
  // The same settings source as every other reader (data dir resolved by
  // paths.ts, env overrides applied by SettingsDefaultsManager).
  // TODO(server-beta config scope): source tenant-scoped settings once
  // multi-tenant deployments have them.
  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
  cachedConfig = loadRedactionConfig(settings as unknown as Partial<RedactionSettings>);
  cacheStamp = now;
  return cachedConfig;
}

// Test helper — resets the cache so unit tests can re-stub settings.
export function _resetRedactionConfigCache(): void {
  cachedConfig = null;
  cacheStamp = 0;
}
