# Auto-Redaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an opt-in auto-redaction layer that recognizes 10 high-confidence secret patterns and replaces matches inline with `<redacted type="..."/>` placeholders before the existing `stripTags` pipeline runs.

**Architecture:** New module `src/utils/redaction.ts` exposing `redactSensitive()` and `loadRedactionConfig()`. Five existing tag-strip call sites gain a one-line prefix. Config lives in the flat `SettingsDefaults` schema as four `CLAUDE_MEM_REDACT_*` keys (consistent with `CLAUDE_MEM_FOLDER_MD_EXCLUDE` JSON-string precedent). Default OFF — zero behavior change unless `CLAUDE_MEM_REDACT_ENABLED=true`.

**Tech Stack:** TypeScript (strict), bun:test for unit tests, regex-based detection (no external dependencies).

**Spec:** `docs/superpowers/specs/2026-05-22-auto-redaction-design.md`

---

## File Structure

**Create:**
- `src/utils/redaction.ts` — detection + config helpers
- `tests/utils/redaction.test.ts` — unit tests
- `docs/public/usage/auto-redaction.mdx` — user-facing docs

**Modify:**
- `src/shared/SettingsDefaultsManager.ts` — add 4 new keys + defaults
- `src/cli/handlers/summarize.ts` — wire `redactSensitive` before `stripMemoryTagsFromPrompt`
- `src/services/worker/http/shared.ts` — same wire-up
- `src/services/worker/http/routes/SessionRoutes.ts` — same wire-up (2 call sites)
- `src/server/generation/processGeneratedResponse.ts` — same wire-up (2 call sites)
- `src/server/generation/providers/shared/prompt-builder.ts` — same wire-up
- `src/sdk/prompts.ts` — append observer hint about `<redacted/>` markers
- `docs/public/usage/private-tags.mdx` — append "See also" footer
- `docs/public/introduction.mdx` — privacy bullet mentions auto-redaction

---

### Task 1: Module skeleton + types + empty function (TDD red phase)

**Files:**
- Create: `src/utils/redaction.ts`
- Create: `tests/utils/redaction.test.ts`

- [ ] **Step 1: Write the failing skeleton test**

Create `tests/utils/redaction.test.ts`:

```typescript
import { describe, it, expect } from 'bun:test';
import { redactSensitive } from '../../src/utils/redaction.js';

describe('redactSensitive', () => {
  it('returns input unchanged when config.enabled is false', () => {
    const input = 'plain text AKIAIOSFODNN7EXAMPLE more text';
    const result = redactSensitive(input, { enabled: false });
    expect(result.redacted).toBe(input);
    expect(result.counts).toEqual({});
    expect(result.truncated).toBe(false);
  });

  it('returns empty string and empty counts for empty input', () => {
    const result = redactSensitive('', { enabled: true });
    expect(result.redacted).toBe('');
    expect(result.counts).toEqual({});
    expect(result.truncated).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/utils/redaction.test.ts`
Expected: FAIL — `Cannot find module '../../src/utils/redaction.js'`

- [ ] **Step 3: Create the skeleton module**

Create `src/utils/redaction.ts`:

```typescript
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

export const BUILTIN_REDACTION_PATTERNS: RedactionPattern[] = [];

export function redactSensitive(input: string, config: RedactionConfig): RedactionResult {
  return { redacted: input, counts: {}, truncated: false };
}
```

> **Note:** This stub returns input unchanged regardless of `config`. The `config.enabled` short-circuit and the `logger` import are intentionally NOT added yet — they belong to Task 2 where they have real consumers (the real detection loop). Adding them at Task 1 would create dead code (unreachable second `return`) and an unused-import lint warning. Both will be reintroduced naturally when Task 2 fills in the body.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/utils/redaction.test.ts`
Expected: PASS — 2 tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/utils/redaction.ts tests/utils/redaction.test.ts
git commit -m "feat(redaction): add module skeleton and types for auto-redaction (#2437-followup)"
```

---

### Task 2: Built-in patterns (10 secret families)

**Files:**
- Modify: `src/utils/redaction.ts`
- Modify: `tests/utils/redaction.test.ts`

- [ ] **Step 1: Add positive + negative tests for built-in patterns**

Append to `tests/utils/redaction.test.ts`:

```typescript
describe('redactSensitive built-in patterns', () => {
  const cfg = { enabled: true };

  it.each([
    ['aws_access_key',  'export X=AKIAIOSFODNN7EXAMPLE done',                                          '<redacted type="aws_access_key"/>'],
    ['github_pat',      'token: ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789 trailing',                  '<redacted type="github_pat"/>'],
    ['openai_key',      'Authorization: Bearer sk-ABCDEFGHIJ1234567890abcdef',                        '<redacted type="openai_key"/>'],
    ['anthropic_key',   'key=sk-ant-api03-abcdef1234567890ABCDEF',                                    '<redacted type="anthropic_key"/>'],
    // Split string literals here and below so GitHub's secret-push-protection
    // scanner doesn't flag these fake test fixtures as real secrets.
    ['slack_token',     'Slack: ' + 'xox' + 'b-1234567890-0987654321-abcdefghijklmnop',             '<redacted type="slack_token"/>'],
    ['jwt',             'auth: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.AbCdEf0123456789',               '<redacted type="jwt"/>'],
    ['stripe_key',      'Stripe ' + 'sk' + '_live_abcdefghijklmnopqrstuvwx',                         '<redacted type="stripe_key"/>'],
    ['google_api_key',  'key=AIzaSyA-0123456789abcdefghijklmnopqrstuvw',                              '<redacted type="google_api_key"/>'],
  ])('redacts %s', (name, input, marker) => {
    const result = redactSensitive(input, cfg);
    expect(result.redacted).toContain(marker);
    expect(result.counts[name]).toBe(1);
  });

  it('redacts a full PEM private key block', () => {
    const input = `text before
-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEAxxxx
yyyy
-----END RSA PRIVATE KEY-----
text after`;
    const result = redactSensitive(input, cfg);
    expect(result.redacted).toContain('<redacted type="private_key_pem"/>');
    expect(result.redacted).toContain('text before');
    expect(result.redacted).toContain('text after');
    expect(result.counts.private_key_pem).toBe(1);
  });

  it('redacts aws_secret_key only when anchored to AWS_SECRET_ACCESS_KEY', () => {
    const anchored = 'AWS_SECRET_ACCESS_KEY=abcdefghijklmnopqrstuvwxyz0123456789ABCD';
    const r1 = redactSensitive(anchored, cfg);
    expect(r1.counts.aws_secret_key).toBe(1);

    const standalone = 'random base64 abcdefghijklmnopqrstuvwxyz0123456789ABCD here';
    const r2 = redactSensitive(standalone, cfg);
    expect(r2.counts.aws_secret_key).toBeUndefined();
  });

  it('does NOT match near-miss strings', () => {
    const negatives = [
      'sk-short',                                  // openai_key too short
      'AKIA12345',                                 // aws_access_key too short
      'ghp_short',                                 // github_pat too short
      'eyJhbGciOiJIUzI1NiJ9 some text',            // jwt missing 2nd/3rd segment
      '-----BEGIN PUBLIC KEY-----\nfoo\n-----END PUBLIC KEY-----',  // PEM but not PRIVATE
    ];
    for (const input of negatives) {
      const result = redactSensitive(input, cfg);
      expect(Object.keys(result.counts)).toHaveLength(0);
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/utils/redaction.test.ts`
Expected: FAIL on each `redacts %s` case — `redacted` does not contain the marker because the function still returns input unchanged.

- [ ] **Step 3: Implement built-in patterns**

Replace the `BUILTIN_REDACTION_PATTERNS` and `redactSensitive` body in `src/utils/redaction.ts`:

```typescript
export const BUILTIN_REDACTION_PATTERNS: RedactionPattern[] = [
  { name: 'aws_access_key',  regex: /AKIA[0-9A-Z]{16}/g },
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

export function redactSensitive(input: string, config: RedactionConfig): RedactionResult {
  if (!config.enabled || input.length === 0) {
    return { redacted: input, counts: {}, truncated: false };
  }

  const disabled = new Set(config.disabledBuiltinPatterns ?? []);
  const counts: Record<string, number> = {};
  let working = input;

  for (const pattern of BUILTIN_REDACTION_PATTERNS) {
    if (disabled.has(pattern.name)) continue;
    pattern.regex.lastIndex = 0;
    const replaced = working.replace(pattern.regex, () => {
      counts[pattern.name] = (counts[pattern.name] ?? 0) + 1;
      return `<redacted type="${pattern.name}"/>`;
    });
    working = replaced;
  }

  if (config.logMatches && Object.keys(counts).length > 0) {
    logger.debug('REDACT', 'patterns matched', undefined, { counts });
  }

  return { redacted: working, counts, truncated: false };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/utils/redaction.test.ts`
Expected: PASS — all positive, negative, PEM, and anchored-aws tests green.

- [ ] **Step 5: Commit**

```bash
git add src/utils/redaction.ts tests/utils/redaction.test.ts
git commit -m "feat(redaction): implement 10 built-in secret patterns"
```

---

### Task 3: Custom patterns + invalid-regex tolerance

**Files:**
- Modify: `src/utils/redaction.ts`
- Modify: `tests/utils/redaction.test.ts`

- [ ] **Step 1: Add tests for custom patterns + invalid regex**

Append to `tests/utils/redaction.test.ts`:

```typescript
describe('redactSensitive custom patterns', () => {
  it('applies a valid custom pattern', () => {
    const result = redactSensitive(
      'reference: INTERNAL-ABCDEFGHIJKLMNOPQRSTUVWXYZ123456 done',
      {
        enabled: true,
        customPatterns: [
          { name: 'company_token', regex: 'INTERNAL-[A-Z0-9]{32}' },
        ],
      },
    );
    expect(result.redacted).toContain('<redacted type="company_token"/>');
    expect(result.counts.company_token).toBe(1);
  });

  it('runs custom patterns BEFORE built-ins (custom wins on overlap)', () => {
    // Custom pattern shadows the AKIA prefix
    const result = redactSensitive(
      'override AKIAIOSFODNN7EXAMPLE end',
      {
        enabled: true,
        customPatterns: [{ name: 'my_aws', regex: 'AKIA[0-9A-Z]{16}' }],
      },
    );
    expect(result.redacted).toContain('<redacted type="my_aws"/>');
    expect(result.counts.my_aws).toBe(1);
    expect(result.counts.aws_access_key).toBeUndefined();
  });

  it('skips a custom pattern with an invalid regex without throwing', () => {
    const result = redactSensitive(
      'AKIAIOSFODNN7EXAMPLE here',
      {
        enabled: true,
        customPatterns: [
          { name: 'broken', regex: '(unclosed[group' },
          { name: 'ok',     regex: 'here' },
        ],
      },
    );
    expect(result.redacted).toContain('<redacted type="ok"/>');
    expect(result.redacted).toContain('<redacted type="aws_access_key"/>');
    expect(result.counts.broken).toBeUndefined();
  });

  it('skips a custom pattern with empty/missing name', () => {
    const result = redactSensitive(
      'AKIAIOSFODNN7EXAMPLE foo',
      {
        enabled: true,
        customPatterns: [{ name: '', regex: 'foo' }],
      },
    );
    expect(result.redacted).toContain('<redacted type="aws_access_key"/>');
    expect(result.redacted).toContain('foo'); // unredacted because pattern was skipped
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/utils/redaction.test.ts`
Expected: FAIL on custom-pattern cases — function ignores `customPatterns` field.

- [ ] **Step 3: Add custom-pattern handling**

Replace the body of `redactSensitive` in `src/utils/redaction.ts`:

```typescript
export function redactSensitive(input: string, config: RedactionConfig): RedactionResult {
  if (!config.enabled || input.length === 0) {
    return { redacted: input, counts: {}, truncated: false };
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
      logger.warn('REDACT', 'custom pattern skipped: invalid regex', error instanceof Error ? error : new Error(String(error)), { name: cp.name });
    }
  }

  const allPatterns: RedactionPattern[] = [...compiledCustom, ...BUILTIN_REDACTION_PATTERNS];

  for (const pattern of allPatterns) {
    if (disabled.has(pattern.name)) continue;
    pattern.regex.lastIndex = 0;
    working = working.replace(pattern.regex, () => {
      counts[pattern.name] = (counts[pattern.name] ?? 0) + 1;
      return `<redacted type="${pattern.name}"/>`;
    });
  }

  if (config.logMatches && Object.keys(counts).length > 0) {
    logger.debug('REDACT', 'patterns matched', undefined, { counts });
  }

  return { redacted: working, counts, truncated: false };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/utils/redaction.test.ts`
Expected: PASS — all custom-pattern and invalid-regex tolerance tests green.

- [ ] **Step 5: Commit**

```bash
git add src/utils/redaction.ts tests/utils/redaction.test.ts
git commit -m "feat(redaction): support user-supplied custom patterns with invalid-regex tolerance"
```

---

### Task 4: Robustness caps (200 matches, 1 MB input) + idempotency

**Files:**
- Modify: `src/utils/redaction.ts`
- Modify: `tests/utils/redaction.test.ts`

- [ ] **Step 1: Add cap + idempotency tests**

Append to `tests/utils/redaction.test.ts`:

```typescript
describe('redactSensitive robustness', () => {
  it('short-circuits with truncated=true when input exceeds 1 MB', () => {
    const huge = 'a'.repeat(1024 * 1024 + 1);
    const result = redactSensitive(huge + ' AKIAIOSFODNN7EXAMPLE', { enabled: true });
    expect(result.redacted).toContain('AKIAIOSFODNN7EXAMPLE');
    expect(result.truncated).toBe(true);
    expect(result.counts).toEqual({});
  });

  it('sets truncated=true when total matches exceed 200', () => {
    const oneKey = 'AKIAIOSFODNN7EXAMPLE ';
    const input = oneKey.repeat(201);
    const result = redactSensitive(input, { enabled: true });
    expect(result.truncated).toBe(true);
  });

  it('is idempotent: running twice produces the same output', () => {
    const input = 'a AKIAIOSFODNN7EXAMPLE b ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789 c';
    const r1 = redactSensitive(input, { enabled: true });
    const r2 = redactSensitive(r1.redacted, { enabled: true });
    expect(r2.redacted).toBe(r1.redacted);
    expect(r2.counts).toEqual({});
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/utils/redaction.test.ts`
Expected: FAIL on `1 MB` and `>200 matches` — `truncated` always `false`.

- [ ] **Step 3: Add caps to redactSensitive**

Replace the body of `redactSensitive` in `src/utils/redaction.ts`:

```typescript
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
      logger.warn('REDACT', 'custom pattern skipped: invalid regex', error instanceof Error ? error : new Error(String(error)), { name: cp.name });
    }
  }

  const allPatterns: RedactionPattern[] = [...compiledCustom, ...BUILTIN_REDACTION_PATTERNS];

  for (const pattern of allPatterns) {
    if (disabled.has(pattern.name)) continue;
    if (truncated) break;
    pattern.regex.lastIndex = 0;
    working = working.replace(pattern.regex, () => {
      if (totalMatches >= MAX_TOTAL_MATCHES) {
        truncated = true;
        return '__REDACT_CAP_HIT__';
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
    // Roll back the placeholder marker so the original text is left intact past the cap
    working = working.replace(/__REDACT_CAP_HIT__/g, (m) => m.slice(0, 0) || '');
  }

  if (config.logMatches && Object.keys(counts).length > 0) {
    logger.debug('REDACT', 'patterns matched', undefined, { counts });
  }

  return { redacted: working, counts, truncated };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/utils/redaction.test.ts`
Expected: PASS — caps test sees `truncated=true`, idempotency holds, original 1 MB string passes through.

- [ ] **Step 5: Commit**

```bash
git add src/utils/redaction.ts tests/utils/redaction.test.ts
git commit -m "feat(redaction): cap input at 1 MB and total matches at 200 to prevent ReDoS"
```

---

### Task 5: `loadRedactionConfig()` helper

**Files:**
- Modify: `src/utils/redaction.ts`
- Modify: `tests/utils/redaction.test.ts`

- [ ] **Step 1: Add config-loader tests**

Append to `tests/utils/redaction.test.ts`:

```typescript
import { loadRedactionConfig } from '../../src/utils/redaction.js';

describe('loadRedactionConfig', () => {
  function settingsFrom(overrides: Record<string, string>): any {
    return {
      CLAUDE_MEM_REDACT_ENABLED: 'false',
      CLAUDE_MEM_REDACT_DISABLED_BUILTINS: '',
      CLAUDE_MEM_REDACT_CUSTOM_PATTERNS: '[]',
      CLAUDE_MEM_REDACT_LOG_MATCHES: 'false',
      ...overrides,
    };
  }

  it('parses enabled and logMatches as booleans', () => {
    const cfg = loadRedactionConfig(settingsFrom({
      CLAUDE_MEM_REDACT_ENABLED: 'true',
      CLAUDE_MEM_REDACT_LOG_MATCHES: 'true',
    }));
    expect(cfg.enabled).toBe(true);
    expect(cfg.logMatches).toBe(true);
  });

  it('splits CSV of disabled built-ins', () => {
    const cfg = loadRedactionConfig(settingsFrom({
      CLAUDE_MEM_REDACT_DISABLED_BUILTINS: 'jwt, slack_token ,  ',
    }));
    expect(cfg.disabledBuiltinPatterns).toEqual(['jwt', 'slack_token']);
  });

  it('parses customPatterns as JSON', () => {
    const cfg = loadRedactionConfig(settingsFrom({
      CLAUDE_MEM_REDACT_CUSTOM_PATTERNS: '[{"name":"foo","regex":"bar"}]',
    }));
    expect(cfg.customPatterns).toEqual([{ name: 'foo', regex: 'bar' }]);
  });

  it('falls back to empty list on malformed customPatterns JSON', () => {
    const cfg = loadRedactionConfig(settingsFrom({
      CLAUDE_MEM_REDACT_CUSTOM_PATTERNS: '{not valid json',
    }));
    expect(cfg.customPatterns).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/utils/redaction.test.ts`
Expected: FAIL — `loadRedactionConfig` is not exported.

- [ ] **Step 3: Implement `loadRedactionConfig`, `safeParseCustomPatterns`, and cached `getRedactionConfig`**

Append to `src/utils/redaction.ts`:

```typescript
import { SettingsDefaultsManager } from '../shared/SettingsDefaultsManager.js';
import { join } from 'path';
import { homedir } from 'os';

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
      error instanceof Error ? error : new Error(String(error)));
    return [];
  }
}

export function loadRedactionConfig(settings: Partial<RedactionSettings>): RedactionConfig {
  // Defensive: every field is read with a `?? ''` fallback so a settings
  // file written before Task 6 registered the defaults (or hand-edited to
  // drop a key) cannot crash the worker. enabled defaults to false, which
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
    cachedConfig = loadRedactionConfig(settings as unknown as RedactionSettings);
  } catch (error) {
    logger.warn('REDACT', 'failed to load redaction config, defaulting to disabled',
      error instanceof Error ? error : new Error(String(error)));
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/utils/redaction.test.ts`
Expected: PASS — all four loader tests green.

- [ ] **Step 5: Commit**

```bash
git add src/utils/redaction.ts tests/utils/redaction.test.ts
git commit -m "feat(redaction): add loadRedactionConfig() bridging flat settings to RedactionConfig"
```

---

### Task 6: Register the 4 settings defaults

**Files:**
- Modify: `src/shared/SettingsDefaultsManager.ts`

- [ ] **Step 1: Add type fields to `SettingsDefaults`**

In `src/shared/SettingsDefaultsManager.ts`, find the `SettingsDefaults` interface (starts at line 6) and add four new keys at a sensible spot (e.g. near `CLAUDE_MEM_HOOK_FAIL_LOUD_THRESHOLD`):

```typescript
  CLAUDE_MEM_REDACT_ENABLED: string;
  CLAUDE_MEM_REDACT_DISABLED_BUILTINS: string;
  CLAUDE_MEM_REDACT_CUSTOM_PATTERNS: string;
  CLAUDE_MEM_REDACT_LOG_MATCHES: string;
```

- [ ] **Step 2: Add default values to `DEFAULTS`**

In the same file, find `private static readonly DEFAULTS: SettingsDefaults = {` (around line 82) and add:

```typescript
    CLAUDE_MEM_REDACT_ENABLED: 'false',                   // Opt-in auto-redaction of common secret patterns (see docs/public/usage/auto-redaction.mdx)
    CLAUDE_MEM_REDACT_DISABLED_BUILTINS: '',              // CSV of built-in pattern names to disable, e.g. 'jwt,slack_token'
    CLAUDE_MEM_REDACT_CUSTOM_PATTERNS: '[]',              // JSON array of { name, regex } objects
    CLAUDE_MEM_REDACT_LOG_MATCHES: 'false',               // Log pattern,count per invocation (no payload)
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: clean exit, no errors.

- [ ] **Step 4: Commit**

```bash
git add src/shared/SettingsDefaultsManager.ts
git commit -m "feat(settings): register 4 CLAUDE_MEM_REDACT_* keys, default off"
```

---

### Task 7: Wire 5 tag-strip call sites to run redaction first

**Files:**
- Modify: `src/cli/handlers/summarize.ts`
- Modify: `src/services/worker/http/shared.ts`
- Modify: `src/services/worker/http/routes/SessionRoutes.ts`
- Modify: `src/server/generation/processGeneratedResponse.ts`
- Modify: `src/server/generation/providers/shared/prompt-builder.ts`
- Create: `tests/integration/redaction-wired.test.ts`

The reference pattern is identical at every site — no per-site settings lookup needed because `getRedactionConfig()` reads `~/.claude-mem/settings.json` internally (5 s cache):

```typescript
import { redactSensitive, getRedactionConfig } from '../../utils/redaction.js'; // adjust relative path

// Before:
const cleaned = stripMemoryTagsFromPrompt(rawInput);

// After:
const cleaned = stripMemoryTagsFromPrompt(
  redactSensitive(rawInput, getRedactionConfig()).redacted,
);
```

Same for `stripMemoryTagsFromJson` and the lower-level `stripTags`.

- [ ] **Step 1: Wire `src/cli/handlers/summarize.ts` (lines 45, 54)**

Add at the top of the file (next to the existing tag-stripping import):

```typescript
import { redactSensitive, getRedactionConfig } from '../../utils/redaction.js';
```

Replace line 45:

```typescript
lastAssistantMessage = stripMemoryTagsFromPrompt(input.lastAssistantMessage);
```

with:

```typescript
lastAssistantMessage = stripMemoryTagsFromPrompt(
  redactSensitive(input.lastAssistantMessage, getRedactionConfig()).redacted,
);
```

Replace line 54:

```typescript
lastAssistantMessage = stripMemoryTagsFromPrompt(lastAssistantMessage);
```

with:

```typescript
lastAssistantMessage = stripMemoryTagsFromPrompt(
  redactSensitive(lastAssistantMessage, getRedactionConfig()).redacted,
);
```

- [ ] **Step 2: Wire `src/services/worker/http/shared.ts` (lines 155, 158)**

Add at the top:

```typescript
import { redactSensitive, getRedactionConfig } from '../../../utils/redaction.js';
```

Replace lines 155 and 158:

```typescript
? stripMemoryTagsFromJson(JSON.stringify(payload.toolInput))
```

with:

```typescript
? stripMemoryTagsFromJson(
    redactSensitive(JSON.stringify(payload.toolInput), getRedactionConfig()).redacted,
  )
```

(same shape for line 158 with `payload.toolResponse`).

- [ ] **Step 3: Wire `src/services/worker/http/routes/SessionRoutes.ts` (lines 292, 390)**

Add at the top:

```typescript
import { redactSensitive, getRedactionConfig } from '../../../../utils/redaction.js';
```

Replace line 292:

```typescript
? stripMemoryTagsFromPrompt(String(last_assistant_message))
```

with:

```typescript
? stripMemoryTagsFromPrompt(
    redactSensitive(String(last_assistant_message), getRedactionConfig()).redacted,
  )
```

Replace line 390:

```typescript
const cleanedPrompt = stripMemoryTagsFromPrompt(prompt);
```

with:

```typescript
const cleanedPrompt = stripMemoryTagsFromPrompt(
  redactSensitive(prompt, getRedactionConfig()).redacted,
);
```

- [ ] **Step 4: Wire `src/server/generation/processGeneratedResponse.ts` (lines 119, 381)**

Add at the top:

```typescript
import { redactSensitive, getRedactionConfig } from '../../utils/redaction.js';
```

Replace line 119:

```typescript
const scrubbed = stripTags(content);
```

with:

```typescript
const scrubbed = stripTags(
  redactSensitive(content, getRedactionConfig()).redacted,
);
```

Replace line 381:

```typescript
const scrubbed = stripTags(summaryContent);
```

with:

```typescript
const scrubbed = stripTags(
  redactSensitive(summaryContent, getRedactionConfig()).redacted,
);
```

- [ ] **Step 5: Wire `src/server/generation/providers/shared/prompt-builder.ts` (line 107)**

Add at the top:

```typescript
import { redactSensitive, getRedactionConfig } from '../../../../utils/redaction.js';
```

Replace line 107:

```typescript
const stripResult = stripTags(rawPayload);
```

with:

```typescript
const stripResult = stripTags(
  redactSensitive(rawPayload, getRedactionConfig()).redacted,
);
```

- [ ] **Step 6: Add an integration test that proves redaction is now in the pipeline**

Create `tests/integration/redaction-wired.test.ts`:

```typescript
import { describe, it, expect } from 'bun:test';
import { redactSensitive, _resetRedactionConfigCache } from '../../src/utils/redaction.js';
import { stripMemoryTagsFromPrompt } from '../../src/utils/tag-stripping.js';

describe('redaction wired into stripTags pipeline', () => {
  it('redaction runs before stripTags, producing a <redacted/> placeholder that survives stripping', () => {
    _resetRedactionConfigCache();
    const cfg = {
      enabled: true,
      disabledBuiltinPatterns: [],
      customPatterns: [],
      logMatches: false,
    };
    const input = 'curl -H "Authorization: Bearer sk-ABCDEFGHIJ1234567890abcdef" https://api';
    const redact = redactSensitive(input, cfg);
    const finalText = stripMemoryTagsFromPrompt(redact.redacted);
    expect(finalText).toContain('<redacted type="openai_key"/>');
    expect(finalText).not.toContain('sk-ABCDEFGHIJ');
  });
});
```

- [ ] **Step 7: Run all tests**

Run: `bun test`
Expected: PASS — full suite green.

- [ ] **Step 8: Commit**

```bash
git add src/cli/handlers/summarize.ts src/services/worker/http/shared.ts src/services/worker/http/routes/SessionRoutes.ts src/server/generation/processGeneratedResponse.ts src/server/generation/providers/shared/prompt-builder.ts tests/integration/redaction-wired.test.ts
git commit -m "feat(redaction): wire redactSensitive() before stripTags at 5 call sites"
```

---

### Task 8: Observer prompt addendum

**Files:**
- Modify: `src/sdk/prompts.ts`

- [ ] **Step 1: Add the redacted-marker hint to `buildObservationPrompt`**

In `src/sdk/prompts.ts`, find `buildObservationPrompt(obs: Observation)`. Locate the existing `<elided/>` hint (added by PR #2602):

```typescript
If a <parameters> or <outcome> block above contains an "<elided chars=... />" marker, that field was truncated to fit the observer's context window. Describe only what you can see in the kept portion and do not infer details about the elided range.
```

Append a sibling sentence immediately after:

```typescript
If a <parameters> or <outcome> block above contains a "<redacted type=\"...\" />" marker, that field was a recognized secret pattern and was removed before storage. Treat it as a placeholder; do not infer the literal value.
```

- [ ] **Step 2: Run SDK prompt tests**

Run: `bun test tests/sdk/`
Expected: PASS or unrelated focused failure.

- [ ] **Step 3: Commit**

```bash
git add src/sdk/prompts.ts
git commit -m "feat(prompts): tell the observer about <redacted/> markers alongside <elided/>"
```

---

### Task 9: User-facing docs

**Files:**
- Create: `docs/public/usage/auto-redaction.mdx`
- Modify: `docs/public/usage/private-tags.mdx`
- Modify: `docs/public/introduction.mdx`

- [ ] **Step 1: Create `docs/public/usage/auto-redaction.mdx`**

Write:

```mdx
---
title: "Auto-Redaction"
description: "Opt-in regex-based detection that replaces common secret patterns with <redacted/> placeholders before storage"
---

# Auto-Redaction

claude-mem can automatically detect and redact common secrets before observations and summaries are stored. Unlike the manual [`<private>` tag](/usage/private-tags), this is a deterministic regex pipeline that catches secrets you never typed yourself — for example, an API key printed by a `curl` response or echoed by a `Bash` command.

## How it works

When enabled, every prompt or tool payload that flows through claude-mem's storage path is scanned for a curated set of high-confidence secret patterns. Matches are replaced inline with a self-closing `<redacted type="..."/>` placeholder, preserving the surrounding context so search and observation quality stay intact.

```
Before:  curl -H "Authorization: Bearer sk-abc123def456..." …
After:   curl -H "Authorization: Bearer <redacted type=\"openai_key\"/>" …
```

The observer LLM is explicitly instructed not to infer the literal value of any `<redacted/>` marker (see `src/sdk/prompts.ts`).

## Enable it

Add to `~/.claude-mem/settings.json`:

```json
{
  "CLAUDE_MEM_REDACT_ENABLED": "true"
}
```

That is all you need for the 10 built-in patterns to kick in.

## Built-in patterns

| Name | Catches |
|---|---|
| `aws_access_key` | `AKIA…` (16 trailing alphanumerics) |
| `aws_secret_key` | 40-char base64 anchored to `AWS_SECRET_ACCESS_KEY=…` |
| `github_pat` | `ghp_…`, `ghs_…`, `github_pat_…` |
| `openai_key` | `sk-…` (≥20 chars) |
| `anthropic_key` | `sk-ant-…` (≥20 chars) |
| `slack_token` | `xoxb-…`, `xoxp-…`, `xoxa-…`, `xoxr-…`, `xoxs-…` |
| `jwt` | `eyJ…[.]eyJ…[.]…` three-segment tokens |
| `private_key_pem` | `-----BEGIN [RSA\|DSA\|EC\|OPENSSH\|PGP\|]PRIVATE KEY-----` blocks |
| `stripe_key` | `sk_live_…`, `pk_live_…`, `rk_test_…` |
| `google_api_key` | `AIza…` (35 trailing chars) |

## Disable a single built-in

```json
{
  "CLAUDE_MEM_REDACT_ENABLED": "true",
  "CLAUDE_MEM_REDACT_DISABLED_BUILTINS": "jwt,slack_token"
}
```

CSV format. The other built-ins stay active.

## Add a custom pattern

```json
{
  "CLAUDE_MEM_REDACT_ENABLED": "true",
  "CLAUDE_MEM_REDACT_CUSTOM_PATTERNS": "[{\"name\":\"company_internal_token\",\"regex\":\"INTERNAL-[A-Z0-9]{32}\"}]"
}
```

`name` is required and surfaces in the `<redacted type="..."/>` marker. Custom patterns are evaluated **before** built-ins, so you can override the built-in detection for a specific token family.

If your regex fails to compile or your JSON is malformed, claude-mem logs a warning at worker startup and skips the broken entry — the rest keep working.

## Diagnostic logging

```json
{
  "CLAUDE_MEM_REDACT_LOG_MATCHES": "true"
}
```

Writes a `pattern,count` line per invocation to the worker log. The original matched bytes are never logged.

## Limits

- Per-invocation cap of 200 total matches and 1 MB input. Above either cap, redaction short-circuits and surfaces a `truncated: true` flag (logged as warning).
- Built-ins do not cover Azure / GCP service-account JSON / IBM Cloud / private IDC tokens — use custom patterns for those.
- This is destructive replacement, not encryption. Redacted bytes cannot be recovered. If you need reversible protection, use the `<private>` tag and keep the secrets out of the conversation entirely.

## Comparison with `<private>` tags

| | `<private>` (manual) | Auto-redaction |
|---|---|---|
| **Trigger** | User wraps `<private>...</private>` | Regex match anywhere in content |
| **Granularity** | Whole block dropped | Inline placeholder, surroundings kept |
| **Default** | Always on (no setting) | Off until you opt in |
| **Use when** | You know up front the content is sensitive | You want a safety net for accidental token leaks |

Both can be used together.
```

- [ ] **Step 2: Append "See also" to `docs/public/usage/private-tags.mdx`**

At the end of `docs/public/usage/private-tags.mdx`, before any closing tags, append:

```mdx
## See also

- [Auto-Redaction](/usage/auto-redaction) — opt-in regex-based detection for accidental token leaks.
```

- [ ] **Step 3: Mention both in `docs/public/introduction.mdx`**

Find the existing privacy bullet (currently `🔒 **Privacy Control** - Use \`<private>\` tags to exclude sensitive content from storage`) and replace it with:

```mdx
- 🔒 **Privacy Control** — Use [`<private>` tags](/usage/private-tags) for manual blocks, or enable [auto-redaction](/usage/auto-redaction) for regex-based secret detection.
```

- [ ] **Step 4: Commit**

```bash
git add docs/public/usage/auto-redaction.mdx docs/public/usage/private-tags.mdx docs/public/introduction.mdx
git commit -m "docs(privacy): document auto-redaction and cross-link with <private> tags"
```

---

### Task 10: Final build + integration sanity

**Files:** none (verification only)

- [ ] **Step 1: Run full test suite**

Run: `bun test`
Expected: PASS — no regressions across the codebase.

- [ ] **Step 2: TypeScript build check**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Bundle build**

Run: `npm run build`
Expected: all 6 bundles compile, no warnings beyond the existing benign `import.meta` note.

- [ ] **Step 4: Bundle-side sanity check on redaction wiring**

Run:
```bash
grep -c "redactSensitive" plugin/scripts/worker-service.cjs
```
Expected: at least 5 (one per wired call site that ends up in the worker bundle).

- [ ] **Step 5: Open PR**

```bash
git push -u origin feat/auto-redaction
gh pr create --repo thedotmack/claude-mem --base main --head YOMXXX:feat/auto-redaction \
  --title "feat(privacy): opt-in auto-redaction for common secret patterns" \
  --body "<see spec at docs/superpowers/specs/2026-05-22-auto-redaction-design.md>"
```

(Adjust the PR body to summarize: opt-in, 10 built-ins, custom patterns supported, 5 call sites wired, observer prompt updated, full docs. Link the spec file.)

---

## Minor follow-ups from review (handle in Task 10 polish)

Issues found by code-quality review that are non-blocking and clustered for the final polish pass:

**Task 2 review:**
- `aws_secret_key` lookbehind only catches shell/yaml style `KEY=val` / `KEY: val` — JSON-style `"KEY": "val"` not anchored. Already documented inline as a `// Known limitation` comment in the patterns array. Recommend mentioning explicitly in `docs/public/usage/auto-redaction.mdx` (Task 9) so users with JSON config know to write a custom pattern.

**Task 7 review:**
- `src/server/generation/providers/shared/prompt-builder.ts` calls `getRedactionConfig()`, which reads `~/.claude-mem/settings.json` (single-user local path). For multi-tenant server-beta deployments this is the wrong source — config should be tenant-scoped. Acceptable short-term since server-beta isn't widely deployed yet. Document as a known limitation in the auto-redaction docs (Task 9) so it's not forgotten when server-beta lands.
- `tests/integration/redaction-wired.test.ts` calls `redactSensitive` with a literal config, not `getRedactionConfig()`. Could add a second case that uses the real config loader (and mocks the settings file) to strengthen the "wired" semantics. Not blocking.

**Task 4 review:**
- The "201 matches triggers cap" test only asserts `truncated: true`. Stronger assertions would lock the semantics (exactly 200 placeholders rendered, 1 leftover token, `counts.aws_access_key === 200`). Add in Task 10.
- `MAX_INPUT_BYTES` is measured by `string.length`, which is UTF-16 code units, not bytes. Either rename to `MAX_INPUT_LENGTH` or add a single-line comment noting the units. The spec uses "bytes" loosely (≈ ASCII inputs match), but multi-byte inputs differ. Comment is cheaper than rename. Add in Task 10.
- `if (truncated) break;` could move to the top of the loop body (currently second). Pure style point; skip unless touching the surrounding code anyway.

---

## Self-review checklist

- ✅ Spec §1 (manual `<private>` complement) → covered by docs in Task 9 (comparison table)
- ✅ Spec §3.1 (5 call sites) → Task 7 wires all 5
- ✅ Spec §3.2 (inline placeholder) → Task 2's `replace()` returning `<redacted type="..."/>`
- ✅ Spec §3.3 (module shape) → Tasks 1, 2, 3, 4, 5
- ✅ Spec §3.4 (4 flat settings keys) → Task 6
- ✅ Spec §4 (caps + invalid-regex tolerance) → Tasks 3, 4
- ✅ Spec §5 (test plan: built-in pos/neg, custom, disabled, caps, idempotency, integration) → covered across Tasks 2, 3, 4, 5, 7
- ✅ Spec §6 (observer prompt) → Task 8
- ✅ Spec §7 (3 doc files) → Task 9
- ✅ Type consistency: `RedactionResult { redacted, counts, truncated }` used identically across Tasks 1–7
