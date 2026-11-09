import { existsSync, readFileSync } from 'fs';
import { logger } from './logger.js';
import { SettingsDefaultsManager } from '../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../shared/paths.js';
import { stripUtf8Bom } from '../shared/atomic-json.js';

export interface RedactionPattern {
  name: string;
  regex: RegExp;
}

export interface RedactionConfig {
  enabled: boolean;
  disabledBuiltinPatterns?: string[];
  customPatterns?: { name: string; regex: string }[];
  logMatches?: boolean;
  /** CLAUDE_MEM_REDACT_GENERIC_ENABLED: also run GENERIC_REDACTION_PATTERNS. Off by default. */
  genericEnabled?: boolean;
}

export interface RedactionResult {
  redacted: string;
  counts: Record<string, number>;
  /** The input was over the size cap and was replaced whole by an oversize marker. */
  oversize: boolean;
}

// The value shape shared by the generic built-ins below (issue #4745): a
// lookahead demands 8 value-class chars, then the match itself demands at
// least one letter — so purely numeric values (`max_tokens=4096`) and shorter
// strings never redact. The class holds only bytes found in real secrets and
// stops at whitespace/quotes/angle brackets, so `<redacted …/>` markers can
// never re-match and a value never swallows surrounding shell/JSON syntax.
const GENERIC_VALUE_CLASS = String.raw`[A-Za-z0-9_.\-+/=~@#$%^*!?]`;
const GENERIC_VALUE = `(?=${GENERIC_VALUE_CLASS}{8})${GENERIC_VALUE_CLASS}*[A-Za-z]${GENERIC_VALUE_CLASS}*`;

// An optional quote, possibly JSON-escaped: the worker scans
// `JSON.stringify(toolInput)`, where `DB_PASSWORD="x"` arrives as
// `DB_PASSWORD=\"x\"`. The backslash stays out of GENERIC_VALUE_CLASS, so a
// value still ends at the escaped closing quote.
const OPTIONAL_QUOTE = String.raw`(?:\\{0,3}["'])?`;
// Bounded on purpose: an unbounded `\s*` inside a lookbehind re-scans the
// whole whitespace run at every position in it, which is quadratic and
// stalled the synchronous capture path for seconds on padded output.
const BOUNDED_SPACE = String.raw`\s{0,8}`;

function genericBuiltinRegex(lookbehind: string): RegExp {
  // 'i' because the key spellings above are lowercase while captured keys are
  // not (`db_password:`, `authorization:`); every entry stays disable-able by
  // name via CLAUDE_MEM_REDACT_DISABLED_BUILTINS like the vendor built-ins.
  return new RegExp(`${lookbehind}${GENERIC_VALUE}`, 'gi');
}

// A webhook host, matched in any letter case (DNS names are case-insensitive)
// and only where a host can start: after `//`, after userinfo `@`, or after a
// character that cannot be part of a URL path. `host` is a regex source whose
// letters are made case-insensitive one by one, so the rest of the pattern
// keeps its case-sensitive path checks.
function webhookHost(host: string): string {
  const ci = host.replace(/\\.|[a-z]/g, (c) => (c.length === 1 ? `[${c}${c.toUpperCase()}]` : c));
  return String.raw`(?:^|\/\/|@|[^\w.\/@%-])${ci}`;
}

/** `key=value`, `key: value`, `"key": "value"`, with JSON-escaped quotes too. */
function keyedLookbehind(key: string): string {
  return `(?<=${key}${OPTIONAL_QUOTE}${BOUNDED_SPACE}[=:]${BOUNDED_SPACE}${OPTIONAL_QUOTE})`;
}

// generic_token takes any `*_TOKEN` / `*_SECRET` / `*_API_KEY` key in every
// keyed style. The bare names (`token`, `secret`, `api_key`), the same keys
// GENERIC_TOKEN_KEY pairs in structured payloads, are also ordinary
// identifiers in source code (`const token = getToken();`, `token: TokenType;`),
// so in text they count only in config-shaped positions:
// - a quoted key with a quoted value (`"secret": "…"`, JSON-escaped too);
// - an env/shell or query assignment with no spaces around `=`, at the start
//   or after whitespace, `?` or `&` (`api_key=…`, `export secret=…`,
//   `?token=…`), whose value is not a call (`token=getAuthToken()`);
// - a CLI flag (`--token=…`, `--api-key …`), prefixed ones too
//   (`--auth-token …`, `--client-secret=…`, `--hf-token …`);
// - a yaml line (`token: …` at a line start, raw or JSON-escaped `\n`) whose
//   value runs to the end of the line, which a typed field (`token: T;`) doesn't.
// The worker scans tool output as `JSON.stringify(response)`, so a JSON
// string's own quotes count as the start and end of its text, and escaped
// whitespace (`\n`, `\t`) as whitespace.
const BARE_TOKEN_KEY = String.raw`(?:token|secret|api_key)`;
const ESCAPED_QUOTE = String.raw`\\{0,3}["']`;
const STRING_EDGE = String.raw`(?<!\\)"`;
const ASSIGNMENT_START = String.raw`(?:^|[\s?&]|\\[nrt]|${STRING_EDGE})`;
const LINE_START = String.raw`(?:^|\n|\\n|${STRING_EDGE})[ \t]{0,8}(?:-[ \t]{1,8})?`;
const LINE_END = String.raw`(?:${ESCAPED_QUOTE})?[ \t]{0,8}(?:$|\r?\n|\\{1,3}[rn]|#|${STRING_EDGE})`;
const GENERIC_TOKEN_REGEX = new RegExp([
  `${keyedLookbehind(String.raw`\b\w*_${BARE_TOKEN_KEY}`)}${GENERIC_VALUE}`,
  `(?<=${ESCAPED_QUOTE}${BARE_TOKEN_KEY}${ESCAPED_QUOTE}${BOUNDED_SPACE}:${BOUNDED_SPACE}${ESCAPED_QUOTE})${GENERIC_VALUE}`,
  `(?<=${ASSIGNMENT_START}${BARE_TOKEN_KEY}=${OPTIONAL_QUOTE})${GENERIC_VALUE}(?!\\(|${GENERIC_VALUE_CLASS})`,
  String.raw`(?<=--(?:[a-z0-9]+[-_])*(?:token|secret|api[-_]key)(?:=|[ \t]{1,8})${OPTIONAL_QUOTE})${GENERIC_VALUE}`,
  `(?<=${LINE_START}${BARE_TOKEN_KEY}:[ \\t]{1,8}${OPTIONAL_QUOTE})${GENERIC_VALUE}(?=${LINE_END})`,
].join('|'), 'gi');

// The worker scans tool I/O as JSON.stringify(...) (worker/http/shared.ts), so a
// newline, tab or carriage return right before a key arrives as the two
// characters `\n`, `\t` or `\r`. The letter is a word character, so a pattern
// that starts with `\b` can't match there, and a key printed at the start of a
// line was stored verbatim. Every `\b` that opens a pattern or one of its
// alternatives also accepts that escaped pair, the way ASSIGNMENT_START does
// for the generic patterns.
const ESCAPED_WHITESPACE_OR_WORD_BOUNDARY = String.raw`(?:(?<=\\[nrt])|\b)`;
function matchAfterEscapedWhitespace(pattern: RedactionPattern): RedactionPattern {
  const source = pattern.regex.source.replace(/(^|\||\(\?:)\\b/g, `$1${ESCAPED_WHITESPACE_OR_WORD_BOUNDARY}`);
  return { ...pattern, regex: new RegExp(source, pattern.regex.flags) };
}

export const BUILTIN_REDACTION_PATTERNS: RedactionPattern[] = [
  // The password in a URL's userinfo: `postgres://app:hunter2@db/prod`,
  // `redis://:hunter2@cache:6379/0`, `https://user:pass@host/repo.git` (what
  // `git remote -v` and a DATABASE_URL print). Only the password is replaced,
  // so the scheme, user and host stay readable. The value stops at `/`, `@`,
  // whitespace and quotes; a `<` start keeps an earlier marker and a `$`/`{`
  // start keeps a `${DB_PASS}` placeholder from being taken for a secret.
  // First in the list, so the whole password goes before a vendor pattern can
  // split it with its marker and leave the rest of it behind.
  { name: 'url_credentials', regex: /(?<=\b[a-z][a-z0-9+.-]*:\/\/[^\s:\/@'"<>]*:)(?![${<])[^\s\/@'"<>]+(?=@)/gi },
  // `AKIA` is a long-term access key ID; `ASIA` is the temporary one that STS,
  // SSO and instance roles hand out (`aws sts assume-role`, `aws configure
  // export-credentials`), printed next to its secret and session token.
  { name: 'aws_access_key',  regex: /(?:AKIA|ASIA)[0-9A-Z]{16}/g },
  // Anchored to its key names: `AWS_SECRET_ACCESS_KEY=…` in env output,
  // `aws_secret_access_key = …` in ~/.aws/credentials and SDK arguments (any
  // letter case), and `"SecretAccessKey": "…"` in `aws sts` / `aws configure
  // export-credentials` JSON, which prints it beside the ASIA key ID and the
  // session token. keyedLookbehind also takes JSON-style `"KEY": "val"`.
  { name: 'aws_secret_key',  regex: new RegExp(`${keyedLookbehind(String.raw`(?:aws_secret_access_key|\bSecretAccessKey)`)}[A-Za-z0-9/+=]{40}`, 'gi') },
  // The session token of temporary credentials (STS, SSO, `aws configure
  // export-credentials`) grants access together with the key pair, so it is
  // anchored to its key names the same way: `AWS_SESSION_TOKEN=…` in env
  // output, `aws_session_token = …` in ~/.aws/credentials and
  // `"SessionToken": "…"` in `aws sts` JSON. Real tokens run to hundreds of
  // base64 characters; the 100-char floor keeps short placeholders out.
  { name: 'aws_session_token', regex: new RegExp(`${keyedLookbehind(String.raw`\b(?:aws_session_token|SessionToken)`)}[A-Za-z0-9/+=]{100,}`, 'gi') },
  { name: 'github_pat',      regex: /\bgh[oprsu]_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{82}\b/g },
  // openai_key, anthropic_key, slack_token, jwt and google_api_key end in a
  // class that includes `-`. A closing `\b` after a `-` needs a word character
  // to follow, so a Google key ending in `-` was not redacted at all and the
  // others left their final `-` in the stored text. `(?!\w)` is the same
  // "the token ends here" check without that gap.
  { name: 'openai_key',      regex: /\bsk-(?!ant-)[A-Za-z0-9_-]{20,}(?!\w)/g },
  { name: 'anthropic_key',   regex: /\bsk-ant-[A-Za-z0-9_-]{20,}(?!\w)/g },
  // Slack bot/user/legacy tokens (`xoxb-`, `xoxp-`, …), refresh tokens from
  // token rotation (`xoxe-`) and app-level Socket Mode tokens (`xapp-`).
  { name: 'slack_token',     regex: /\b(?:xox[abeprs]|xapp)-[A-Za-z0-9-]{10,}(?!\w)/g },
  { name: 'jwt',             regex: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?!\w)/g },
  // A PGP secret key is armored as `PRIVATE KEY BLOCK`, and an encrypted
  // PKCS#8 key as `ENCRYPTED PRIVATE KEY`.
  { name: 'private_key_pem', regex: /-----BEGIN (?:RSA |DSA |EC |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END (?:RSA |DSA |EC |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g },
  // API keys (`sk_`/`pk_`/`rk_`) and webhook signing secrets (`whsec_`, what
  // `stripe listen` prints and STRIPE_WEBHOOK_SECRET holds), which forge events.
  { name: 'stripe_key',      regex: /\b(?:(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{24,}|whsec_[A-Za-z0-9]{32,})\b/g },
  { name: 'google_api_key',  regex: /\bAIza[0-9A-Za-z_-]{35}(?!\w)/g },
  // Google OAuth 2.0 access tokens: `ya29.` + a base64url body, plus the
  // `ya29.c.` form the GCE metadata server hands out. `gcloud auth
  // print-access-token`, `curl -H "Authorization: Bearer …"` lines and token
  // JSON print them; each grants an hour of the account's API access.
  { name: 'google_oauth_token', regex: /\bya29\.(?:c\.)?[0-9A-Za-z_-]{20,}(?!\w)/g },
  // GitLab personal/project/group access tokens (`glpat-`), deploy tokens (`gldt-`),
  // and runner authentication tokens (`glrt-` + 20 chars; newer routable tokens
  // add dot-separated segments), Hugging Face user access tokens (`hf_` + 34 chars),
  // npm access tokens (`npm_` + 36 chars) and Docker Hub personal access tokens
  // (`dckr_pat_` + 27 chars): credentials printed in config files, CLI commands
  // (`glab`, `huggingface-cli`, `npm`, `docker login`), and env dumps.
  { name: 'gitlab_token',    regex: /\bgl(?:pat|dt|rt)-[A-Za-z0-9_-]{20,}(?:\.[A-Za-z0-9_-]+)*(?!\w)/g },
  { name: 'huggingface_token', regex: /\bhf_[A-Za-z0-9]{30,}\b/g },
  { name: 'npm_token',       regex: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { name: 'docker_pat',     regex: /\bdckr_pat_[A-Za-z0-9_-]{27,}(?!\w)/g },
  // Linear personal API keys (`lin_api_` + 40 alphanumerics) and Notion
  // integration tokens (`ntn_` + 46 alphanumerics, and the older `secret_` +
  // 43): what `LINEAR_API_KEY=…` / `NOTION_TOKEN=…` lines, MCP server configs
  // and `curl -H "Authorization: …"` commands print. Fixed lengths keep
  // `secret_` words and short look-alikes out.
  { name: 'linear_key',      regex: /\blin_api_[A-Za-z0-9]{40}(?!\w)/g },
  { name: 'notion_token',    regex: /\b(?:ntn_[A-Za-z0-9]{46}|secret_[A-Za-z0-9]{43})(?!\w)/g },
  // SendGrid API keys (`SG.` + 22 + `.` + 43 base64url chars), DigitalOcean
  // personal access, OAuth and refresh tokens (`dop_v1_`/`doo_v1_`/`dor_v1_` +
  // 64 hex) and Shopify Admin API, app and shared-secret tokens (`shpat_`,
  // `shpca_`, `shppa_`, `shpss_` + 32 hex): what `doctl`, the Shopify CLI and
  // `.env` dumps print.
  { name: 'sendgrid_key',    regex: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}(?![\w-])/g },
  { name: 'digitalocean_token', regex: /\bdo[opr]_v1_[a-f0-9]{64}\b/g },
  { name: 'shopify_token',   regex: /\bshp(?:at|ca|pa|ss)_[a-fA-F0-9]{32}\b/g },
  // PyPI API tokens: `pypi-` + a base64url macaroon whose header always
  // starts `AgE` (pypi.org and test.pypi.org alike), printed by `twine`,
  // `uv publish` and `~/.pypirc` dumps. Real tokens run past 150 characters.
  { name: 'pypi_token',      regex: /\bpypi-AgE[A-Za-z0-9_-]{50,}(?!\w)/g },
  // Databricks personal access tokens (`dapi` + 32 hex, sometimes with a
  // `-<digit>` suffix) that DATABRICKS_TOKEN, `~/.databrickscfg` and
  // `databricks tokens create` print, and HashiCorp Vault service and batch
  // tokens (`hvs.` + 90-120 and `hvb.` + 138-300 base64url chars) that
  // VAULT_TOKEN, `~/.vault-token` and `vault login` / `vault token create`
  // print.
  { name: 'databricks_token', regex: /\bdapi[a-f0-9]{32}(?:-\d)?(?!\w)/g },
  { name: 'vault_token',     regex: /\b(?:hvs\.[\w-]{90,120}|hvb\.[\w-]{138,300})(?![\w-])/g },
  // Two OpenAI-compatible providers this project onboards users for
  // (src/shared/openai-compat-presets.ts): NVIDIA NIM issues `nvapi-` keys and
  // Runcrate issues `rc_live_` keys. Both presets tell the user the prefix in
  // their installer hint, and neither was claimed by openai_key (`sk-`), so a
  // key pasted into a session (or printed by a `curl`/`.env` dump) was stored
  // verbatim. 32+ trailing chars keeps short placeholders out.
  { name: 'nvidia_nim_key',  regex: /\bnvapi-[A-Za-z0-9_-]{32,}(?!\w)/g },
  { name: 'runcrate_key',    regex: /\brc_live_[A-Za-z0-9_-]{24,}(?!\w)/g },
  // Groq API keys (`gsk_` + 52 alphanumerics) and xAI API keys (`xai-` + 80
  // chars): LLM provider keys that `.env` files, `export GROQ_API_KEY=…` /
  // `XAI_API_KEY=…` lines and `curl -H "Authorization: Bearer …"` commands
  // print. Neither prefix is claimed by openai_key, so they stayed in the text.
  { name: 'groq_key',        regex: /\bgsk_[A-Za-z0-9]{52}(?!\w)/g },
  { name: 'xai_key',         regex: /\bxai-[A-Za-z0-9_]{80}(?!\w)/g },
  // Perplexity API keys (`pplx-` + 48 alphanumerics): an LLM provider key
  // that `.env` files, `export PERPLEXITY_API_KEY=…` lines and `curl -H
  // "Authorization: Bearer …"` commands print. The prefix is not claimed by
  // openai_key, and Perplexity model ids share it (`pplx-embed-v1-4b`), so
  // the fixed 48-char alphanumeric body keeps the model ids out.
  { name: 'perplexity_key',  regex: /\bpplx-[A-Za-z0-9]{48}(?!\w)/g },
  // Supabase personal access tokens (`sbp_` + 40 hex, what `supabase login`
  // stores and SUPABASE_ACCESS_TOKEN holds) and Sentry auth tokens: personal
  // ones (`sntryu_` + 64 hex) and organization ones (`sntrys_` + a base64
  // payload + `_` + a 43-char base64 secret), which SENTRY_AUTH_TOKEN lines,
  // `.sentryclirc` dumps and source-map upload commands print.
  { name: 'supabase_token',  regex: /\bsbp_[a-f0-9]{40}(?!\w)/g },
  { name: 'sentry_token',    regex: /\b(?:sntryu_[a-f0-9]{64}(?!\w)|sntrys_[A-Za-z0-9+\/]{20,}={0,2}_[A-Za-z0-9+\/]{43}(?![\w+\/]))/g },
  // Incoming webhook URLs carry their secret in the path, so anyone holding
  // one can post to the channel: Slack (`hooks.slack.com/services/T…/B…/…`,
  // plus workflow and trigger URLs) and Discord (`discord.com/api/webhooks/
  // <id>/<token>`, discordapp.com and the ptb/canary hosts too), as printed by
  // `.env` dumps, CI configs and `curl -X POST` commands. Only the last path
  // segment is replaced, so the host and the workspace/channel ids stay
  // readable. The host must start the URL's host part (after `//`, `@`, or a
  // non-URL character), so `example.com/hooks.slack.com/…` keeps its path, and
  // it matches in any letter case, as DNS does; the path stays case-sensitive.
  { name: 'slack_webhook',   regex: new RegExp(String.raw`(?<=${webhookHost(String.raw`hooks\.slack\.com`)}\/(?:services|workflows|triggers)\/T[A-Z0-9]+\/[A-Z0-9]+\/(?:[0-9]+\/)?)[A-Za-z0-9]{20,}(?!\w)`, 'g') },
  { name: 'discord_webhook', regex: new RegExp(String.raw`(?<=${webhookHost(String.raw`(?:(?:ptb|canary)\.)?discord(?:app)?\.com`)}\/api\/(?:v\d+\/)?webhooks\/[0-9]{17,20}\/)[A-Za-z0-9_-]{60,}(?![\w-])`, 'g') },
  // claude-mem's own credentials: server API keys (`cmem_` + 43 base64url
  // chars, server-bootstrap.ts createRawApiKey) and cmem.ai Pro memory keys.
  { name: 'claude_mem_key',  regex: /\bcmem_[A-Za-z0-9_-]{32,}|\bcm_pro_[A-Za-z0-9_-]{8,}/g },
].map(matchAfterEscapedWhitespace);

// Generic, lower-confidence built-ins (issue #4745): credentials that carry no
// vendor prefix. Opt-in on top of redaction (CLAUDE_MEM_REDACT_GENERIC_ENABLED,
// default off), and run LAST so a vendor-shaped value is claimed by its
// specific pattern above and keeps that marker; GENERIC_VALUE bounds false
// positives. Each can still be turned off by name via
// CLAUDE_MEM_REDACT_DISABLED_BUILTINS.
export const GENERIC_REDACTION_PATTERNS: RedactionPattern[] = [
  // `pwd` only as a suffix (`DB_PWD`, `MYSQL_PWD`): the bare `PWD` and
  // `OLDPWD` environment variables hold a working directory, not a secret.
  { name: 'generic_password', regex: genericBuiltinRegex(keyedLookbehind(String.raw`\b(?:\w*_?(?:password|passwd)|\w+_pwd)`)) },
  { name: 'generic_token',    regex: GENERIC_TOKEN_REGEX },
  { name: 'bearer_token',     regex: genericBuiltinRegex(`(?<=\\bAuthorization${OPTIONAL_QUOTE}${BOUNDED_SPACE}:${BOUNDED_SPACE}${OPTIONAL_QUOTE}Bearer${BOUNDED_SPACE})`) },
  // `Authorization: Basic …` carries base64(user:password), a password anyone
  // can decode, as in `curl -H "Authorization: Basic dXNlcjpodW50ZXIy"`.
  { name: 'basic_auth',       regex: genericBuiltinRegex(`(?<=\\bAuthorization${OPTIONAL_QUOTE}${BOUNDED_SPACE}:${BOUNDED_SPACE}${OPTIONAL_QUOTE}Basic${BOUNDED_SPACE})`) },
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

  const allPatterns: RedactionPattern[] = [
    ...compiledCustom,
    ...BUILTIN_REDACTION_PATTERNS,
    ...(config.genericEnabled ? GENERIC_REDACTION_PATTERNS : []),
  ];

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
  CLAUDE_MEM_REDACT_GENERIC_ENABLED: string;
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
    genericEnabled: settings.CLAUDE_MEM_REDACT_GENERIC_ENABLED === 'true',
  };
}

// Cached config for the tag-stripping choke point, which runs on every
// captured field — avoids re-reading settings.json each time. A 5 s TTL lets
// settings.json edits propagate within one hook cycle without a restart.
let cachedConfig: RedactionConfig | null = null;
let cacheStamp = 0;
const CACHE_TTL_MS = 5000;
// The last configuration read from a settings.json that parsed, kept so a
// file that later becomes unreadable cannot quietly turn redaction off.
let lastLoadedConfig: RedactionConfig | null = null;
let warnedUnreadableSettings = false;

const BUILTINS_ONLY: RedactionConfig = { enabled: true, disabledBuiltinPatterns: [], customPatterns: [], logMatches: false };
// How a settings.json that no longer parses can still show it asked for redaction.
const REDACTION_REQUESTED_IN_RAW = /"CLAUDE_MEM_REDACT_ENABLED"\s*:\s*"true"/;

function readSettingsText(settingsPath: string): string | null {
  if (!existsSync(settingsPath)) return null;
  try {
    return readFileSync(settingsPath, 'utf-8');
  } catch {
    // [ANTI-PATTERN IGNORED]: an unreadable file is exactly the case the caller
    // handles (it falls back toward redacting); there is nothing else to report.
    return '';
  }
}

/** True when settings.json exists but is not a JSON object, so every reader fell back to defaults. */
function isUnreadableSettings(text: string | null): text is string {
  if (text === null) return false;
  try {
    const parsed: unknown = JSON.parse(stripUtf8Bom(text));
    return parsed === null || typeof parsed !== 'object' || Array.isArray(parsed);
  } catch {
    // [ANTI-PATTERN IGNORED]: a parse failure is the signal being tested for.
    return true;
  }
}

/**
 * A settings.json that does not parse makes every reader fall back to the
 * defaults, and the default is redaction off. When the user had asked for
 * redaction (the last configuration that loaded, or the broken file's own
 * text), keep redacting instead: with that last configuration, or the
 * built-in patterns. An explicit CLAUDE_MEM_REDACT_ENABLED=false in the
 * environment still wins.
 */
function configForUnreadableSettings(settingsPath: string, text: string, loaded: RedactionConfig): RedactionConfig {
  if (process.env.CLAUDE_MEM_REDACT_ENABLED === 'false') return loaded;
  const requested = lastLoadedConfig?.enabled === true || REDACTION_REQUESTED_IN_RAW.test(text);
  if (!requested) return loaded;
  if (!warnedUnreadableSettings) {
    warnedUnreadableSettings = true;
    logger.warn('REDACT', 'settings.json could not be read; secret redaction stays on until it is repaired', {
      settingsPath,
      using: lastLoadedConfig?.enabled ? 'the last configuration that loaded' : 'the built-in patterns',
    });
  }
  return lastLoadedConfig?.enabled ? lastLoadedConfig : BUILTINS_ONLY;
}

export function getRedactionConfig(settingsPath: string = USER_SETTINGS_PATH): RedactionConfig {
  const now = Date.now();
  if (cachedConfig && now - cacheStamp < CACHE_TTL_MS) {
    return cachedConfig;
  }
  // The same settings source as every other reader (data dir resolved by
  // paths.ts, env overrides applied by SettingsDefaultsManager).
  // TODO(server-beta config scope): source tenant-scoped settings once
  // multi-tenant deployments have them.
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  const loaded = loadRedactionConfig(settings as unknown as Partial<RedactionSettings>);
  const text = loaded.enabled ? null : readSettingsText(settingsPath);
  if (isUnreadableSettings(text)) {
    cachedConfig = configForUnreadableSettings(settingsPath, text, loaded);
  } else {
    cachedConfig = loaded;
    lastLoadedConfig = loaded;
  }
  cacheStamp = now;
  return cachedConfig;
}

/** A log line with every recognized secret replaced, while redaction is on. */
export function redactForLog(text: string): string {
  return redactSensitive(text, getRedactionConfig()).redacted;
}

// A structured payload holds the key and the value apart
// (`{client_secret: "…"}`), so the text patterns, which anchor on `key=`,
// never see them together; this pairs them again for the generic group.
// The password keys follow the generic_password text pattern: any key ending
// in `password`/`passwd` (`dbPassword`, `PGPASSWORD`) and `pwd` only as a
// suffix (`MYSQL_PWD`), so `{"MYSQL_PWD": "…"}` is caught like `MYSQL_PWD=…`.
const GENERIC_PASSWORD_KEY = /(?:password|passwd)$|\w_pwd$/i;
const GENERIC_TOKEN_KEY = /(?:^|_)(?:secret|token|api_key)$/i;
const WHOLE_GENERIC_VALUE = new RegExp(`^${GENERIC_VALUE_CLASS}{8,}$`);

function genericMarkerForKeyedValue(key: string, value: string, config: RedactionConfig): string | null {
  if (!config.genericEnabled) return null;
  const name = GENERIC_PASSWORD_KEY.test(key) ? 'generic_password'
    : GENERIC_TOKEN_KEY.test(key) ? 'generic_token'
    : null;
  if (!name) return null;
  if (config.disabledBuiltinPatterns?.includes(name)) return null;
  if (!WHOLE_GENERIC_VALUE.test(value) || !/[A-Za-z]/.test(value)) return null;
  return `<redacted type='${name}'/>`;
}

// The bearer_token text pattern anchors on `Authorization: Bearer …`, so a
// header object like `{"headers": {"Authorization": "Bearer …"}}` needs the
// key paired with the value again. As in text, only the token after `Bearer`
// is replaced: the same spacing is accepted around `Bearer`, and whatever
// follows the token (trailing whitespace included) is kept, unanchored.
const AUTHORIZATION_KEY = /^(?:proxy-)?authorization$/i;
const KEYED_BEARER_VALUE = new RegExp(`^(${BOUNDED_SPACE}Bearer${BOUNDED_SPACE})${GENERIC_VALUE}`, 'i');

function bearerMarkerForKeyedValue(key: string, value: string, config: RedactionConfig): string | null {
  if (!config.genericEnabled || config.disabledBuiltinPatterns?.includes('bearer_token')) return null;
  if (!AUTHORIZATION_KEY.test(key)) return null;
  const match = KEYED_BEARER_VALUE.exec(value);
  return match ? `${match[1]}<redacted type='bearer_token'/>${value.slice(match[0].length)}` : null;
}

// The same pairing for the credentials of `{"Authorization": "Basic …"}`.
const KEYED_BASIC_VALUE = new RegExp(`^(${BOUNDED_SPACE}Basic${BOUNDED_SPACE})${GENERIC_VALUE}`, 'i');

function basicMarkerForKeyedValue(key: string, value: string, config: RedactionConfig): string | null {
  if (!config.genericEnabled || config.disabledBuiltinPatterns?.includes('basic_auth')) return null;
  if (!AUTHORIZATION_KEY.test(key)) return null;
  const match = KEYED_BASIC_VALUE.exec(value);
  return match ? `${match[1]}<redacted type='basic_auth'/>${value.slice(match[0].length)}` : null;
}

// The aws_session_token built-in anchors on `SessionToken: …`, so a payload
// like `{"Credentials": {"SessionToken": "…"}}` needs the key paired with the
// value again. Same key names and value floor as the text pattern; it is a
// built-in, so it applies whether or not the generic group is on.
const AWS_SESSION_TOKEN_KEY = /^(?:aws_session_token|SessionToken)$/i;
const WHOLE_AWS_SESSION_TOKEN_VALUE = /^[A-Za-z0-9/+=]{100,}$/;

function awsSessionTokenMarkerForKeyedValue(key: string, value: string, config: RedactionConfig): string | null {
  if (config.disabledBuiltinPatterns?.includes('aws_session_token')) return null;
  if (!AWS_SESSION_TOKEN_KEY.test(key) || !WHOLE_AWS_SESSION_TOKEN_VALUE.test(value)) return null;
  return "<redacted type='aws_session_token'/>";
}

// The same pairing for the secret key of `{"Credentials": {"SecretAccessKey": "…"}}`.
const AWS_SECRET_KEY_KEY = /^(?:aws_secret_access_key|SecretAccessKey)$/i;
const WHOLE_AWS_SECRET_KEY_VALUE = /^[A-Za-z0-9/+=]{40}$/;

function awsSecretKeyMarkerForKeyedValue(key: string, value: string, config: RedactionConfig): string | null {
  if (config.disabledBuiltinPatterns?.includes('aws_secret_key')) return null;
  if (!AWS_SECRET_KEY_KEY.test(key) || !WHOLE_AWS_SECRET_KEY_VALUE.test(value)) return null;
  return "<redacted type='aws_secret_key'/>";
}

/**
 * The value with every string in it (object values and array items, at any
 * depth) redacted, while redaction is on; the caller's value is not mutated.
 * For raw structured payloads that are stored as-is, such as server runtime
 * agent events.
 */
export function redactJsonStrings<T>(value: T, config: RedactionConfig = getRedactionConfig()): T {
  if (!config.enabled) return value;
  const walk = (node: unknown, key?: string): unknown => {
    if (typeof node === 'string') {
      const result = redactSensitive(node, config);
      if (key === undefined || Object.keys(result.counts).length > 0) return result.redacted;
      return awsSessionTokenMarkerForKeyedValue(key, node, config)
        ?? awsSecretKeyMarkerForKeyedValue(key, node, config)
        ?? bearerMarkerForKeyedValue(key, node, config)
        ?? basicMarkerForKeyedValue(key, node, config)
        ?? genericMarkerForKeyedValue(key, node, config)
        ?? result.redacted;
    }
    if (Array.isArray(node)) return node.map((child) => walk(child));
    if (node !== null && typeof node === 'object') {
      return Object.fromEntries(Object.entries(node).map(([childKey, child]) => [childKey, walk(child, childKey)]));
    }
    return node;
  };
  return walk(value) as T;
}

// Test helper — resets the cache so unit tests can re-stub settings.
export function _resetRedactionConfigCache(): void {
  cachedConfig = null;
  cacheStamp = 0;
  lastLoadedConfig = null;
  warnedUnreadableSettings = false;
}

// ---------------------------------------------------------------------------
// Secret detectors with kinds (wire gateway, plan Phase 6 task 2)
//
// magpie's secret rules (internal/redact/redact.go:104-143, MIT, Copyright (c)
// 2026 yetone): API_KEY families, TOKEN (JWT), PRIVATE_KEY, the PASSWORD of
// scheme://user:password@, and SECRET name=value. Each finding keeps its kind,
// so a scrubbed copy reads `[REDACTED:KIND]` and the wire gateway's outbound
// redaction can make a `{{KIND_…}}` placeholder from the same finding.
//
// These are deliberately a list of their own, not entries in
// BUILTIN_REDACTION_PATTERNS: the wire gateway scrubs what it keeps always,
// while the hook path's opt-in redaction (CLAUDE_MEM_REDACT_ENABLED, its
// markers and its generic patterns) stays exactly as it is.
//
// Go's RE2 never backtracks; JavaScript's engine does. The patterns that
// would rescan the rest of the text from many starts (PASSWORD's scheme,
// SECRET's field name and value, PRIVATE_KEY's lazy body) are found from
// their fixed text ("://", the secret names, the BEGIN/END lines) instead,
// so every detector stays linear in the text.

/** One secret found in a text: `text.slice(start, end)` is the value, `kind` what it is. */
export interface SecretSpan {
  start: number;
  end: number;
  kind: string;
}

const ALPHANUMERIC_CHARACTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const TOKEN_CHARACTERS = `${ALPHANUMERIC_CHARACTERS}_-`;
const IDENTIFIER_CHARACTERS = `${ALPHANUMERIC_CHARACTERS}_.-`;
/** A secret's value characters (magpie `secretCh`). */
const SECRET_VALUE_CLASS = String.raw`[A-Za-z0-9_\-./+=~!@#%^&*]`;
/** A field's or a value's quote, if it has one: " or ', or \" in JSON written inside a string (magpie `quote`). */
const FIELD_QUOTE = String.raw`(?:\\?["'])?`;
/** A secret field name is at most this long on each side of its secret word; past it nothing is found (RE2's unbounded run, bounded so JS stays linear). */
const SECRET_FIELD_NAME_MAX_SIDE_CHARACTERS = 256;

/** magpie `notAVariable`: what stands in for a value (${PASS}, <password>, ****) is no value. */
function isNotAVariable(value: string): boolean {
  if ('$%{<[*'.includes(value[0] ?? '')) return false;
  return value.replace(/^[*xX.]+|[*xX.]+$/g, '') !== '';
}

/** magpie `secretValue`: letters and digits both, and not a call, a reference or a placeholder of its own. */
function isSecretLookingValue(value: string): boolean {
  if (!isNotAVariable(value) || value.startsWith('process.env') || value.startsWith('os.')) return false;
  return /[0-9]/.test(value) && /[A-Za-z]/.test(value);
}

interface PatternSecretDetector {
  kind: string;
  /** Global, with no capturing group: the whole match is the value. */
  pattern: RegExp;
  /** One of these is in any text the pattern can match. */
  markers: string[];
  /** Characters that may not touch the value on either side (a key inside a longer word is no key). */
  boundCharacters?: string;
  isValue?: (value: string) => boolean;
}

const PATTERN_SECRET_DETECTORS: PatternSecretDetector[] = [
  { kind: 'API_KEY', pattern: /sk-(?:ant-|proj-|or-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g, markers: ['sk-'], boundCharacters: TOKEN_CHARACTERS },
  // a gateway's or a relay's own: oc_sk_…, or_sk_…
  { kind: 'API_KEY', pattern: /[a-z]{2,4}_sk_[A-Za-z0-9_-]{20,}/g, markers: ['_sk_'], boundCharacters: TOKEN_CHARACTERS, isValue: isSecretLookingValue },
  { kind: 'API_KEY', pattern: /(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|glpat-[A-Za-z0-9_-]{20,})/g, markers: ['gh', 'github_pat_', 'glpat-'], boundCharacters: TOKEN_CHARACTERS },
  { kind: 'API_KEY', pattern: /AIza[0-9A-Za-z_-]{35}/g, markers: ['AIza'], boundCharacters: TOKEN_CHARACTERS },
  { kind: 'API_KEY', pattern: /xox[abposr]-[0-9A-Za-z-]{10,}/g, markers: ['xox'], boundCharacters: TOKEN_CHARACTERS },
  { kind: 'API_KEY', pattern: /(?:sk|rk)_live_[0-9A-Za-z]{20,}/g, markers: ['_live_'], boundCharacters: TOKEN_CHARACTERS },
  { kind: 'API_KEY', pattern: /(?:AKIA|ASIA)[0-9A-Z]{16}/g, markers: ['AKIA', 'ASIA'], boundCharacters: ALPHANUMERIC_CHARACTERS },
  {
    kind: 'API_KEY',
    pattern: /(?:hf_[A-Za-z0-9]{30,}|gsk_[A-Za-z0-9]{40,}|xai-[A-Za-z0-9]{40,}|npm_[A-Za-z0-9]{36}|pypi-[A-Za-z0-9_-]{50,}|dop_v1_[a-f0-9]{64}|SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43})/g,
    markers: ['hf_', 'gsk_', 'xai-', 'npm_', 'pypi-', 'dop_v1_', 'SG.'],
    boundCharacters: TOKEN_CHARACTERS,
  },
  // claude-mem's own credentials (BUILTIN_REDACTION_PATTERNS claude_mem_key).
  { kind: 'API_KEY', pattern: /cmem_[A-Za-z0-9_-]{32,}|cm_pro_[A-Za-z0-9_-]{8,}/g, markers: ['cmem_', 'cm_pro_'], boundCharacters: TOKEN_CHARACTERS },
  { kind: 'TOKEN', pattern: /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, markers: ['eyJ'], boundCharacters: TOKEN_CHARACTERS },
];

/** What a field holding a secret has in its name: DB_PASSWORD, apiKey, x-api-key, client_secret (magpie `secretNames`). */
const SECRET_NAME_WORDS = String.raw`password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential`;
const SECRET_NAME_WORD_PATTERN = new RegExp(SECRET_NAME_WORDS, 'gi');
/** After a secret field's name: `= value`, `: "value"`, `\": \"value` (magpie's SECRET rule from its `[:=]` on). */
const SECRET_ASSIGNMENT_AFTER_NAME = new RegExp(`${FIELD_QUOTE}[ \\t]*[:=][ \\t]*${FIELD_QUOTE}(${SECRET_VALUE_CLASS}{8,})`, 'y');
/**
 * A field called key and nothing more ("key": "oc_sk_…"). Only a long value of
 * letters and digits both, since code calls anything a key.
 */
const BARE_KEY_FIELD_PATTERN = new RegExp(
  `(?<![A-Za-z0-9_.-])${FIELD_QUOTE}key${FIELD_QUOTE}[ \\t]*[:=][ \\t]*${FIELD_QUOTE}(${SECRET_VALUE_CLASS}{16,})`, 'gi');
/** The user:password@ of a URL, matched from just after its "://". */
const URL_USER_PASSWORD_AFTER_SCHEME = /[^\s:@/?#"'<>]+:([^\s@/?#"'<>]{3,})@/y;
const URL_SCHEME_CHARACTERS = `${ALPHANUMERIC_CHARACTERS}+.-`;

function touchesBoundCharacter(text: string, start: number, end: number, boundCharacters: string | undefined): boolean {
  if (!boundCharacters) return false;
  return (start > 0 && boundCharacters.includes(text[start - 1])) || (end < text.length && boundCharacters.includes(text[end]));
}

function patternSecretSpans(text: string, detector: PatternSecretDetector, found: SecretSpan[]): void {
  if (!detector.markers.some(marker => text.includes(marker))) return;
  detector.pattern.lastIndex = 0;
  for (const match of text.matchAll(detector.pattern)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (end <= start || touchesBoundCharacter(text, start, end, detector.boundCharacters)) continue;
    const value = text.slice(start, end);
    if (detector.isValue && !detector.isValue(value)) continue;
    found.push({ start, end, kind: detector.kind });
  }
}

/** A PEM private key's first and last lines (magpie's PRIVATE_KEY rule, split so its lazy body cannot rescan). */
const PRIVATE_KEY_BEGIN_LINE = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g;
const PRIVATE_KEY_END_LINE = /-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g;

/**
 * PRIVATE_KEY: a BEGIN line through the first END line after it, with at
 * least one character between (the RE2 rule's `[\s\S]+?`). A BEGIN with no
 * END after it means no later BEGIN has one either, so the search stops.
 */
function privateKeySpans(text: string, found: SecretSpan[]): void {
  if (!text.includes('PRIVATE KEY')) return;
  let searchFrom = 0;
  for (;;) {
    PRIVATE_KEY_BEGIN_LINE.lastIndex = searchFrom;
    const begin = PRIVATE_KEY_BEGIN_LINE.exec(text);
    if (!begin) return;
    PRIVATE_KEY_END_LINE.lastIndex = begin.index + begin[0].length + 1;
    const end = PRIVATE_KEY_END_LINE.exec(text);
    if (!end) return;
    const spanEnd = end.index + end[0].length;
    found.push({ start: begin.index, end: spanEnd, kind: 'PRIVATE_KEY' });
    searchFrom = spanEnd;
  }
}

/** PASSWORD: scheme://user:password@, found from each "://" (a scheme is a letter, then letters, digits, + . -). */
function urlPasswordSpans(text: string, found: SecretSpan[]): void {
  let searchFrom = 0;
  for (;;) {
    const separator = text.indexOf('://', searchFrom);
    if (separator < 0) return;
    searchFrom = separator + 3;
    // The scheme run before "://" needs a letter somewhere in it; stop at the first one.
    let schemeStart = separator;
    let schemeHasLetter = false;
    while (!schemeHasLetter && schemeStart > 0 && URL_SCHEME_CHARACTERS.includes(text[schemeStart - 1])) {
      schemeStart--;
      schemeHasLetter = /[A-Za-z]/.test(text[schemeStart]);
    }
    if (!schemeHasLetter) continue;
    URL_USER_PASSWORD_AFTER_SCHEME.lastIndex = separator + 3;
    const match = URL_USER_PASSWORD_AFTER_SCHEME.exec(text);
    if (!match) continue;
    const passwordEnd = match.index + match[0].length - 1;
    const passwordStart = passwordEnd - match[1].length;
    if (isNotAVariable(match[1])) found.push({ start: passwordStart, end: passwordEnd, kind: 'PASSWORD' });
    searchFrom = passwordEnd + 1;
  }
}

/** SECRET: a value assigned to a field whose name has a secret word in it (DB_PASSWORD=…, "apiKey": "…"). */
function secretAssignmentSpans(text: string, found: SecretSpan[]): void {
  SECRET_NAME_WORD_PATTERN.lastIndex = 0;
  // The end of the run of name characters the last secret word was in: every
  // secret word in one run (password_token, tokentoken…) ends its name there,
  // so the run is walked once, and looked at once.
  let identifierRunEnd = -1;
  let lastNameEnd = -1;
  for (;;) {
    const nameMatch = SECRET_NAME_WORD_PATTERN.exec(text);
    if (!nameMatch) return;
    const wordEnd = nameMatch.index + nameMatch[0].length;
    if (wordEnd > identifierRunEnd) {
      identifierRunEnd = wordEnd;
      while (identifierRunEnd < text.length && IDENTIFIER_CHARACTERS.includes(text[identifierRunEnd])) identifierRunEnd++;
    }
    const nameEnd = identifierRunEnd;
    if (nameEnd === lastNameEnd || nameEnd - wordEnd > SECRET_FIELD_NAME_MAX_SIDE_CHARACTERS) continue;
    lastNameEnd = nameEnd;
    SECRET_ASSIGNMENT_AFTER_NAME.lastIndex = nameEnd;
    const match = SECRET_ASSIGNMENT_AFTER_NAME.exec(text);
    if (!match) continue;
    const valueEnd = match.index + match[0].length;
    // RE2's matches never overlap: the next name is looked for after this value.
    SECRET_NAME_WORD_PATTERN.lastIndex = valueEnd;
    if (isSecretLookingValue(match[1])) found.push({ start: valueEnd - match[1].length, end: valueEnd, kind: 'SECRET' });
  }
}

function bareKeyFieldSpans(text: string, found: SecretSpan[]): void {
  if (!text.includes('key') && !text.includes('KEY') && !text.includes('Key')) return;
  BARE_KEY_FIELD_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(BARE_KEY_FIELD_PATTERN)) {
    if (!isSecretLookingValue(match[1])) continue;
    const valueEnd = (match.index ?? 0) + match[0].length;
    found.push({ start: valueEnd - match[1].length, end: valueEnd, kind: 'SECRET' });
  }
}

/** Every secret the detectors find in `text`, in detector order (overlaps are resolved by replaceSecretSpans). */
export function findSecretSpans(text: string): SecretSpan[] {
  const found: SecretSpan[] = [];
  if (text.length < 3) return found;
  privateKeySpans(text, found);
  for (const detector of PATTERN_SECRET_DETECTORS) patternSecretSpans(text, detector, found);
  urlPasswordSpans(text, found);
  secretAssignmentSpans(text, found);
  bareKeyFieldSpans(text, found);
  return found;
}

/** A placeholder as the wire gateway's outbound redaction writes it: {{KIND_<8 of base32>}} (magpie `placeholderRe`). */
const OUTBOUND_PLACEHOLDER = String.raw`\{\{[A-Z][A-Z0-9_]*_[a-z2-7]{8}\}\}`;
const OUTBOUND_PLACEHOLDER_PATTERN = new RegExp(OUTBOUND_PLACEHOLDER, 'g');
/** One placeholder and nothing else (a value that is one is not masked again). */
export const WHOLE_OUTBOUND_PLACEHOLDER_PATTERN = new RegExp(`^${OUTBOUND_PLACEHOLDER}$`);

/**
 * Swap each of `spans` in `text` for what `replacementFor` makes of its
 * value: the first to start, and of those the longest, wins where they
 * overlap; of two the same, the one found first; nothing inside a placeholder
 * already there (magpie `apply`). Returns the text and how many were swapped.
 */
export function replaceSecretSpans(
  text: string,
  spans: SecretSpan[],
  replacementFor: (kind: string, value: string) => string,
): { text: string; replacedCount: number } {
  if (spans.length === 0) return { text, replacedCount: 0 };
  let candidates = spans;
  if (text.includes('{{')) {
    OUTBOUND_PLACEHOLDER_PATTERN.lastIndex = 0;
    for (const placeholder of text.matchAll(OUTBOUND_PLACEHOLDER_PATTERN)) {
      const placeholderStart = placeholder.index ?? 0;
      const placeholderEnd = placeholderStart + placeholder[0].length;
      candidates = candidates.filter(span => !(span.start < placeholderEnd && span.end > placeholderStart));
    }
    if (candidates.length === 0) return { text, replacedCount: 0 };
  }
  // Array.prototype.sort is stable, so equal spans keep the order they were found in.
  const ordered = [...candidates].sort((a, b) => (a.start !== b.start ? a.start - b.start : b.end - a.end));
  let replaced = '';
  let last = 0;
  let replacedCount = 0;
  for (const span of ordered) {
    if (span.start < last) continue;
    replaced += text.slice(last, span.start) + replacementFor(span.kind, text.slice(span.start, span.end));
    last = span.end;
    replacedCount++;
  }
  return { text: replaced + text.slice(last), replacedCount };
}

/** What a field or header named for a secret holds once scrubbed (magpie `Scrubbed`). */
export const SECRET_NAMED_FIELD_MARKER = '[REDACTED]';

/** Every secret the detectors find, replaced by `[REDACTED:KIND]` for good: nothing is held to put it back (magpie `Scrub`). */
export function scrubSecretsToKindMarkers(text: string): string {
  return replaceSecretSpans(text, findSecretSpans(text), kind => `[REDACTED:${kind}]`).text;
}

const SECRET_FIELD_NAME_PATTERN = new RegExp(`${SECRET_NAME_WORDS}|authori[sz]ation|cookie|^key$`);

/**
 * A field or header called `name` holds a secret: a token, key, password or
 * cookie, but not a count of tokens (max_tokens, input_tokens) (magpie `SecretName`).
 */
export function isSecretFieldName(name: string): boolean {
  const lowerName = name.toLowerCase();
  return SECRET_FIELD_NAME_PATTERN.test(lowerName) && !lowerName.endsWith('tokens') && !lowerName.endsWith('token_count');
}
