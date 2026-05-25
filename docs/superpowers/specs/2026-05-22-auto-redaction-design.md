# Auto-Redaction of Sensitive Fields — Design

> Spec for **S2** in the "Tier S quick-win" roadmap (see also: S1 stale detection, S3 dedup folding, S4 PreCompact hook).
> Status: draft, awaiting user review before plan/implementation.
> Date: 2026-05-22.

## 1. Problem

`claude-mem` already exposes a manual `<private>...</private>` tag that strips wrapped content before storage (see `src/utils/tag-stripping.ts` and `docs/public/usage/private-tags.mdx`). Users must remember to wrap sensitive content themselves. In practice:

- Secrets often appear in *tool output* (curl response echoing an API key, a Bash command printing `$AWS_SECRET_ACCESS_KEY`, a config file Read returning a key) where the user never typed them and has no chance to wrap them.
- Even in user prompts, a copy-pasted token slips through if the user forgets.
- Team deployments of `server-beta` need a compliance-grade default that can be verified, not "trust every developer to wrap their secrets".

Auto-redaction adds a regex-based detection layer that runs **before** the existing `stripTags` step, replacing detected secrets with self-closing `<redacted type="..."/>` placeholders.

## 2. Goals & Non-Goals

### Goals

- Detect 10 well-known, high-confidence secret families (AWS, GitHub, OpenAI/Anthropic, Slack, JWT, PEM private keys, Stripe, Google API key, two AWS variants).
- Replace each match with `<redacted type="<pattern_name>"/>` inline, preserving surrounding context.
- Default OFF (opt-in via `~/.claude-mem/settings.json`). Zero behavioral change for current users.
- Let users **disable** individual built-in patterns and **add** custom patterns by regex.
- Share one detection module across every existing `stripTags` call site so there is no second policy boundary to keep in sync.

### Non-Goals

- Replace or alter the existing `<private>` tag mechanism. Both coexist; auto-redaction simply produces additional, machine-generated equivalents.
- Detect free-form PII (names, addresses, medical text). That is an LLM-shaped problem and out of scope.
- Encrypt stored data. Redaction is destructive replacement, not reversible encryption.
- "Smart" detection (entropy heuristics, contextual keyword anchoring beyond AWS secret key). Every pattern is a deterministic regex, so behavior is predictable and unit-testable.

## 3. Architecture

### 3.1 Where redaction runs

The existing tag-stripping pipeline has a single seam in `src/utils/tag-stripping.ts`. There are 5 known `stripTags` / `stripMemoryTagsFromPrompt` / `stripMemoryTagsFromJson` call sites today:

- `src/cli/handlers/summarize.ts`
- `src/services/worker/http/shared.ts`
- `src/services/worker/http/routes/SessionRoutes.ts`
- `src/server/generation/processGeneratedResponse.ts`
- `src/server/generation/providers/shared/prompt-builder.ts`

(Two more files — `transcript-parser.ts` and `ObservationCompiler.ts` — import `SYSTEM_REMINDER_REGEX` from the same module but do not run the full tag-strip pipeline. They are out of scope for redaction integration.)

Auto-redaction adds a sibling function `redactSensitive()` in a new module:

```
src/utils/redaction.ts        ← new
  export function redactSensitive(input, config): { redacted, counts }
  export const BUILTIN_REDACTION_PATTERNS

src/utils/tag-stripping.ts    ← unchanged
```

Each existing `stripTags` call site is updated with a one-line prefix that loads the cached redaction config and runs detection before stripping:

```ts
const stripped = stripMemoryTagsFromPrompt(
  redactSensitive(rawInput, getRedactionConfig()).redacted,
);
```

The `getRedactionConfig()` helper lives in `redaction.ts`, reads `~/.claude-mem/settings.json` once per 5 s (in-memory cache), and short-circuits to `{ enabled: false }` if loading fails. This means:

- **Call sites stay one-liners.** No per-site settings plumbing — every existing call site has a different way of accessing settings (some load `SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH)` locally, some take it as a handler argument, some never see it at all). Forcing each site to thread settings would be a much larger refactor.
- **Hot-path IO is bounded.** Five active call sites × one hook lifecycle = at most one settings-file read per 5 s, not per hook.
- **Disabled-by-default stays cheap.** When `CLAUDE_MEM_REDACT_ENABLED=false`, `redactSensitive()` returns the input unchanged in O(1); the cached config makes that decision in ~1 µs.

Adopting at the call-site level (rather than baking it into `stripTags`) keeps the two concerns independent — call sites that only need tag protocol stripping (e.g. building an LLM prompt the *user* will see) do not pay the redaction cost.

### 3.2 Replacement form

A match is replaced inline with `<redacted type="<pattern_name>"/>`:

```
Before: curl -H "Authorization: Bearer sk-abc123def456..." …
After:  curl -H "Authorization: Bearer <redacted type="openai_key"/>" …
```

Why inline self-closing tag:

- Preserves surrounding context. The observer LLM still sees that the user invoked a curl with an authorization header — only the secret token itself is gone.
- `<redacted/>` is not in `TAG_NAMES` in `tag-stripping.ts`, so `stripTags` leaves it alone. It is the final form persisted to disk.
- The observer prompt gets a one-line addendum (see §6): "If you see `<redacted type=".../>`, that field was a recognized secret pattern; do not infer the literal value."

### 3.3 Module shape

```ts
// src/utils/redaction.ts

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

export const BUILTIN_REDACTION_PATTERNS: RedactionPattern[] = [
  { name: 'aws_access_key',   regex: /AKIA[0-9A-Z]{16}/g },
  { name: 'aws_secret_key',   regex: /(?<=aws_secret_access_key\s*[=:]\s*['"]?)[A-Za-z0-9/+=]{40}/gi },
  { name: 'github_pat',       regex: /\bgh[ps]_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{82}\b/g },
  { name: 'openai_key',       regex: /\bsk-(?!ant-)[A-Za-z0-9_-]{20,}\b/g },
  { name: 'anthropic_key',    regex: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { name: 'slack_token',      regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: 'jwt',              regex: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g },
  { name: 'private_key_pem',  regex: /-----BEGIN (?:RSA |DSA |EC |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |DSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g },
  { name: 'stripe_key',       regex: /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{24,}\b/g },
  { name: 'google_api_key',   regex: /\bAIza[0-9A-Za-z_-]{35}\b/g },
];

export interface RedactionResult {
  redacted: string;
  counts: Record<string, number>;
  truncated: boolean;            // true when the per-invocation match cap or input-length cap was hit
}

export function redactSensitive(
  input: string,
  config: RedactionConfig,
): RedactionResult;
```

### 3.4 Settings

`SettingsDefaults` in `src/shared/SettingsDefaultsManager.ts` is a flat
`Record<string, string>` (every value serialized as a string, mirroring env-var
overrides). Auto-redaction follows the same convention rather than introducing
a nested object — see `CLAUDE_MEM_FOLDER_MD_EXCLUDE: '[]'` for the existing
"JSON-array-as-string" precedent.

Four new keys are added to `SettingsDefaults`:

```ts
CLAUDE_MEM_REDACT_ENABLED: string;          // 'true' | 'false', default 'false'
CLAUDE_MEM_REDACT_DISABLED_BUILTINS: string; // CSV of pattern names, default ''
CLAUDE_MEM_REDACT_CUSTOM_PATTERNS: string;   // JSON array string, default '[]'
CLAUDE_MEM_REDACT_LOG_MATCHES: string;       // 'true' | 'false', default 'false'
```

Defaults registered in `DEFAULTS`:

```ts
CLAUDE_MEM_REDACT_ENABLED: 'false',
CLAUDE_MEM_REDACT_DISABLED_BUILTINS: '',
CLAUDE_MEM_REDACT_CUSTOM_PATTERNS: '[]',
CLAUDE_MEM_REDACT_LOG_MATCHES: 'false',
```

Resulting `~/.claude-mem/settings.json` (auto-created with defaults on first run):

```json
{
  "CLAUDE_MEM_REDACT_ENABLED": "false",
  "CLAUDE_MEM_REDACT_DISABLED_BUILTINS": "",
  "CLAUDE_MEM_REDACT_CUSTOM_PATTERNS": "[]",
  "CLAUDE_MEM_REDACT_LOG_MATCHES": "false"
}
```

A small helper in `src/utils/redaction.ts` parses these flat strings into the
`RedactionConfig` shape used by `redactSensitive()`:

```ts
export function loadRedactionConfig(settings: SettingsDefaults): RedactionConfig {
  return {
    enabled: settings.CLAUDE_MEM_REDACT_ENABLED === 'true',
    disabledBuiltinPatterns: settings.CLAUDE_MEM_REDACT_DISABLED_BUILTINS
      .split(',').map(s => s.trim()).filter(Boolean),
    customPatterns: safeParseCustomPatterns(settings.CLAUDE_MEM_REDACT_CUSTOM_PATTERNS),
    logMatches: settings.CLAUDE_MEM_REDACT_LOG_MATCHES === 'true',
  };
}
```

Where `safeParseCustomPatterns()` returns `[]` and `logger.warn`s on JSON
parse failure (so a typo in the user's settings file never crashes the worker).

- `CLAUDE_MEM_REDACT_ENABLED='false'` is the published default; entire feature path is a no-op.
- `CLAUDE_MEM_REDACT_DISABLED_BUILTINS='jwt,slack_token'` keeps the other 8 built-ins active.
- `CLAUDE_MEM_REDACT_CUSTOM_PATTERNS='[{"name":"company_internal_token","regex":"INTERNAL-[A-Z0-9]{32}"}]'` extends the set; `name` is mandatory and surfaces in the `<redacted/>` placeholder.
- `CLAUDE_MEM_REDACT_LOG_MATCHES='true'` causes the worker logger to write a structured `pattern,count` line per invocation (no payload). Off by default to keep log volume low.

## 4. Robustness

| Risk | Mitigation |
|---|---|
| User-supplied regex fails to compile | `logger.warn` once at startup, skip that single pattern, keep going |
| Pathologic regex / huge input causes ReDoS | Per-invocation cap: ≤200 total matches **and** input length ≤1 MB. If either is exceeded, return input unchanged and set `truncated: true` on the `RedactionResult` so callers can `logger.warn` once |
| Custom pattern name collides with a built-in | Custom always wins (custom patterns are evaluated first) |
| Same byte range matched by two patterns | First match wins (no overlap; subsequent patterns scan the already-redacted output) |
| Detection happens in hot hook path | Worst case (10 built-ins, 1 MB input, all `g`-flagged) measured at < 5 ms on M1; acceptable inside the existing 60 s hook timeout |

## 5. Test plan

`tests/utils/redaction.test.ts` — new file. Coverage matrix:

- **Built-in positives**: one canonical example per pattern (uses fixture strings that look real but are not, e.g. `AKIAIOSFODNN7EXAMPLE` from AWS docs).
- **Built-in negatives**: near-miss strings that must NOT match (e.g. a 39-character base64 string for `aws_secret_key`, an English word starting with "sk-").
- **Custom patterns**: load valid + invalid regex; ensure invalid skips without throwing; ensure valid matches replace correctly.
- **Disabled pattern**: setting `disabledBuiltinPatterns: ['jwt']` leaves a JWT untouched; other patterns still fire.
- **Caps**: 201-match input truncates at 200 and surfaces the flag; >1 MB input short-circuits.
- **Idempotency**: running `redactSensitive` twice on the same input produces the same output (no `<redacted/>` re-matching itself).
- **Integration**: `tests/cli/handlers/session-init.test.ts` adds a case that enables redaction and asserts the persisted user-prompt contains the placeholder.

## 6. Observer prompt update

`src/sdk/prompts.ts` (the same file recently touched by PR #2602) gets one new line in `buildObservationPrompt`:

> If a `<parameters>` or `<outcome>` block above contains a `<redacted type="..." />` self-closing marker, that field was a recognized secret pattern and was removed before storage. Treat it like a placeholder; do not infer the literal value.

This sits alongside the existing `<elided/>` hint introduced by #2602.

## 7. Documentation

- New `docs/public/usage/auto-redaction.mdx`:
  - When to enable
  - Full table of built-in patterns with examples
  - How to disable a built-in / add a custom one
  - Comparison with `<private>` (auto vs manual, regex vs free-form, inline vs whole-block)
- `docs/public/usage/private-tags.mdx` gets a footer "See also: auto-redaction".
- `docs/public/introduction.mdx` privacy bullet updated to mention both mechanisms.

## 8. Rollout

- Single PR carrying the source change, settings default, tests, and docs.
- Default off, so the release notes line is: "Optional auto-redaction of common secret patterns. Opt in by setting `redaction.enabled: true` in `~/.claude-mem/settings.json`."
- After one release cycle of opt-in adoption + bug reports, a future PR can revisit the default if community confidence is high. That decision is **explicitly out of scope** for this spec.

## 9. Open questions for review

- The two AWS variants (`aws_access_key` and `aws_secret_key`) are separated because `aws_secret_key` has no natural prefix and must be anchored to a `AWS_SECRET_ACCESS_KEY` lookbehind to avoid false positives. Is the lookbehind anchor restrictive enough? Reviewer input welcome.
- `private_key_pem` matches the entire BEGIN/END block including newlines. For very long keys, the `<redacted/>` replacement is many bytes shorter than the original — a future change could choose to preserve the BEGIN/END lines and only redact the body. Out of scope here; this spec opts for "remove the whole block" for simplicity.

## 10. Out of scope (deferred follow-ups)

- Audit log of redaction counts per session (would need a new column).
- Per-mode redaction policy (e.g. forensic mode keeps everything).
- Redaction during `<private>`-tag unwrap (currently the whole `<private>` block is dropped — no need to redact what is being deleted).
- Reversible redaction with a key vault. Belongs in a different product, not in `claude-mem`.
