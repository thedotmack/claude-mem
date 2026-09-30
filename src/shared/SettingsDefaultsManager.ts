
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir, hostname } from 'os';
import { HOOK_TIMEOUTS, getTimeout } from './hook-constants.js';
import { parseJsonWithBom, writeJsonFileAtomic } from './atomic-json.js';
import { isOpenRouterApiUrl } from './openrouter-base-url.js';

// A fresh settings.json is seeded with EVERY default (see loadFromFile), and
// persisted values then win over DEFAULTS. So any install created after the
// Telegram notifier shipped (#2084) has that era's trigger list frozen on
// disk, and adding a type to the default list can never reach it — the new
// type would silently never notify. Rewrite the one exact legacy value to the
// current default; any other list is user-customized and is left untouched.
//
// This cannot distinguish a user who deliberately set exactly 'security_alert'
// from the seeded default — they read identically. Such a user is migrated and
// starts receiving `sensitive` notifications, which is the recoverable side of
// the trade: it is opt-out via this same key, whereas the alternative leaves
// the feature dead on arrival for every pre-existing install.
const LEGACY_TELEGRAM_TRIGGER_TYPES = 'security_alert';

/** Pinned workers.dev hub from the Cloudflare SyncHub era. */
const LEGACY_CLOUD_SYNC_HUB_HOST = 'sync-hub.black-pond-afbb.workers.dev';
/** Canonical Pro hub after the Fly cutover. */
const CANONICAL_CLOUD_SYNC_HUB_URL = 'https://sync.cmem.ai';

// OpenRouter retires `:free` model ids on its own schedule, and the same seeding
// (every default written on first load, persisted values winning over
// DEFAULTS) freezes the shipped OpenRouter default on disk. When that id is
// retired, every observer call 404s and nothing is remembered — the
// xiaomi/mimo-v2-flash:free outage (#3659). Rewrite a retired shipped default
// to the current one, but only for a tuple that talks to openrouter.ai (blank
// or openrouter.ai base URL): a custom OpenAI-compatible endpoint or the cmem
// gateway serves its own model ids, and any other value is a deliberate
// choice. Add the next retired shipped default here.
const RETIRED_OPENROUTER_DEFAULT_MODELS: ReadonlySet<string> = new Set([
  'xiaomi/mimo-v2-flash:free',
]);

function hasRetiredOpenRouterDefault(flatSettings: Record<string, any>): boolean {
  const model = flatSettings.CLAUDE_MEM_OPENROUTER_MODEL;
  if (typeof model !== 'string' || !RETIRED_OPENROUTER_DEFAULT_MODELS.has(model.trim())) {
    return false;
  }
  const baseUrl = typeof flatSettings.CLAUDE_MEM_OPENROUTER_BASE_URL === 'string'
    ? flatSettings.CLAUDE_MEM_OPENROUTER_BASE_URL.trim()
    : '';
  return baseUrl === '' || isOpenRouterApiUrl(baseUrl);
}

function migratedCloudSyncHubUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  try {
    if (new URL(trimmed).hostname === LEGACY_CLOUD_SYNC_HUB_HOST) {
      return CANONICAL_CLOUD_SYNC_HUB_URL;
    }
  } catch {
    return null;
  }
  return null;
}

export interface SettingsDefaults {
  CLAUDE_MEM_MODEL: string;
  CLAUDE_MEM_CONTEXT_OBSERVATIONS: string;
  CLAUDE_MEM_SESSION_START_INCLUDE_ALL_SOURCES: string;
  CLAUDE_MEM_WORKER_PORT: string;
  CLAUDE_MEM_WORKER_HOST: string;
  CLAUDE_MEM_PUBLIC_URL: string;
  CLAUDE_MEM_API_TIMEOUT_MS: string;
  CLAUDE_MEM_SKIP_TOOLS: string;
  CLAUDE_MEM_SKIP_BASH_PATTERNS: string;
  CLAUDE_MEM_SKIP_SUBAGENT_OBSERVATIONS: string;  // #2736 — skip ALL subagent observations (agent id AND agent type present)
  CLAUDE_MEM_SKIP_AGENT_TYPES: string;            // #2736 — comma-separated subagent agent_type values to skip (e.g. workflow-subagent,Explore)
  CLAUDE_MEM_PROVIDER: string;
  CLAUDE_MEM_CLAUDE_AUTH_METHOD: string;  
  CLAUDE_MEM_GEMINI_API_KEY: string;
  CLAUDE_MEM_GEMINI_MODEL: string;  
  CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED: string;
  CLAUDE_MEM_OPENROUTER_API_KEY: string;
  CLAUDE_MEM_OPENROUTER_MODEL: string;
  CLAUDE_MEM_OPENROUTER_BASE_URL: string;
  CLAUDE_MEM_OPENROUTER_SITE_URL: string;
  CLAUDE_MEM_OPENROUTER_APP_NAME: string;
  CLAUDE_MEM_DATA_DIR: string;
  CLAUDE_MEM_LOG_LEVEL: string;
  CLAUDE_MEM_PYTHON_VERSION: string;
  CLAUDE_CODE_PATH: string;
  /** #2753 — override the effective CLAUDE_CONFIG_DIR for the keychain lookup + SDK subprocess env only. Empty = fall through to process.env.CLAUDE_CONFIG_DIR / default. Never touches the worker's own MARKETPLACE_ROOT/paths. */
  CLAUDE_MEM_CLAUDE_CONFIG_DIR: string;
  CLAUDE_MEM_MODE: string;
  CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS: string;
  CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS: string;
  CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT: string;
  CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT: string;
  CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES: string;
  CLAUDE_MEM_CONTEXT_OBSERVATION_CONCEPTS: string;
  CLAUDE_MEM_CONTEXT_FULL_COUNT: string;
  CLAUDE_MEM_CONTEXT_FULL_FIELD: string;
  CLAUDE_MEM_CONTEXT_SESSION_COUNT: string;
  CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY: string;
  CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE: string;
  CLAUDE_MEM_CONTEXT_MAIN_AGENT_ONLY: string;
  CLAUDE_MEM_CONTEXT_SHOW_TERMINAL_OUTPUT: string;
  CLAUDE_MEM_WELCOME_HINT_ENABLED: string;
  CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED: string;
  CLAUDE_MEM_FOLDER_USE_LOCAL_MD: string;  
  CLAUDE_MEM_TRANSCRIPTS_ENABLED: string;  
  CLAUDE_MEM_TRANSCRIPTS_CONFIG_PATH: string;  
  CLAUDE_MEM_CODEX_TRANSCRIPT_INGESTION: string;
  CLAUDE_MEM_MAX_CONCURRENT_AGENTS: string;  
  CLAUDE_MEM_OBSERVER_MAX_CONVERSATION_CHARS: string;
  CLAUDE_MEM_HOOK_FAIL_LOUD_THRESHOLD: string;  
  CLAUDE_MEM_REDACT_ENABLED: string;
  CLAUDE_MEM_REDACT_DISABLED_BUILTINS: string;
  CLAUDE_MEM_REDACT_CUSTOM_PATTERNS: string;
  CLAUDE_MEM_REDACT_LOG_MATCHES: string;
  CLAUDE_MEM_EXCLUDED_PROJECTS: string;  
  CLAUDE_MEM_FOLDER_MD_EXCLUDE: string;
  CLAUDE_MEM_FOLDER_MD_SKELETON_DENYLIST: string;
  CLAUDE_MEM_SEMANTIC_INJECT: string;        
  CLAUDE_MEM_SEMANTIC_INJECT_LIMIT: string;  
  CLAUDE_MEM_TIER_ROUTING_ENABLED: string;
  CLAUDE_MEM_TIER_SIMPLE_MODEL: string;
  CLAUDE_MEM_TIER_SUMMARY_MODEL: string;
  CLAUDE_MEM_TIER_FAST_MODEL: string;        // #2289 — resolved by $TIER:fast in CLAUDE_MEM_MODEL
  CLAUDE_MEM_TIER_SMART_MODEL: string;       // #2289 — resolved by $TIER:smart in CLAUDE_MEM_MODEL
  CLAUDE_MEM_CHROMA_ENABLED: string;   
  CLAUDE_MEM_CHROMA_MODE: string;      
  CLAUDE_MEM_CHROMA_HOST: string;
  CLAUDE_MEM_CHROMA_PORT: string;
  CLAUDE_MEM_CHROMA_SSL: string;
  CLAUDE_MEM_CHROMA_API_KEY: string;
  CLAUDE_MEM_CHROMA_TENANT: string;
  CLAUDE_MEM_CHROMA_DATABASE: string;
  CLAUDE_MEM_CHROMA_PREWARM_TIMEOUT_MS: string;
  CLAUDE_MEM_CHROMA_MUTATION_TIMEOUT_MS: string;
  CLAUDE_MEM_CHROMA_MAX_PENDING_MUTATIONS: string;
  CLAUDE_MEM_CHROMA_EMBEDDING_FUNCTION: string;  // chroma-mcp embedding function for new collections
  // Worker-native cloud sync. Active ⇔ TOKEN, USER_ID, and HUB_URL are all
  // non-empty — there is no separate enabled flag. HUB_URL points at the
  // two-lane sync hub (workers/sync-hub); while it is empty, sync is OFF
  // entirely (the old per-kind cmem.ai lane was deleted in the hub cutover).
  CLAUDE_MEM_CLOUD_SYNC_TOKEN: string;
  CLAUDE_MEM_CLOUD_SYNC_USER_ID: string;
  CLAUDE_MEM_CLOUD_SYNC_HUB_URL: string;
  CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID: string;
  CLAUDE_MEM_CLOUD_SYNC_DEVICE_NAME: string;
  CLAUDE_MEM_CLOUD_SYNC_WS: string;    // advisory WebSocket speed layer (Phase 4) — 'false' = HTTP polling only
  // Content flush knobs. 200-op pages + 30s timeout hit hub projection_busy
  // (#3618). Defaults: 40 ops / 90s (hub projection lease).
  CLAUDE_MEM_CLOUD_SYNC_CONTENT_BATCH_SIZE: string;
  CLAUDE_MEM_CLOUD_SYNC_REQUEST_TIMEOUT_MS: string;
  CLAUDE_MEM_LLM_TIMEOUT_MS: string;
  // Observation TV remote broadcast. EMPTY = OFF: the read-only guard is not
  // mounted and the worker behaves exactly as before. Set (with a non-loopback
  // CLAUDE_MEM_WORKER_HOST) to expose ONLY /tv, /tv.html, /stream and
  // GET /api/observations to holders of this secret. Mint with:
  //   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
  CLAUDE_MEM_TV_TOKEN: string;
  // claude-mem sign-in funnel state, written by the installer's browser-login
  // step (install.ts promptBrowserLogin/completeTrialPairing). Declared here so
  // loadFromFile round-trips them instead of dropping unknown keys.
  CLAUDE_MEM_PRO_TRIAL_EMAIL: string;
  CLAUDE_MEM_PRO_TRIAL_AT: string;
  CLAUDE_MEM_PRO_TRIAL_STATE: string;
  CLAUDE_MEM_PRO_TRIAL_ENDS_AT: string;
  CLAUDE_MEM_PRO_PLAN: string;
  CLAUDE_MEM_PRO_FALLBACK_AT: string;
  // The gateway's own words for the rejection that set CLAUDE_MEM_PRO_FALLBACK_AT,
  // written and cleared with it, so the session-start notice relays them.
  CLAUDE_MEM_PRO_FALLBACK_MESSAGE: string;
  CLAUDE_MEM_PRO_FALLBACK_ACTION: string;
  CLAUDE_MEM_PRO_FALLBACK_URL: string;
  // One-shot memory credentials delivered by browser pairing. These staging
  // fields keep the key recoverable until the user chooses a provider; when
  // claude-mem is selected the installer atomically moves them into the
  // generic OpenRouter fields and clears the staging copy.
  CLAUDE_MEM_PRO_MEMORY_KEY: string;
  CLAUDE_MEM_PRO_MEMORY_BASE_URL: string;
  CLAUDE_MEM_PRO_MEMORY_MODEL: string;
  CLAUDE_MEM_TELEGRAM_ENABLED: string;
  CLAUDE_MEM_TELEGRAM_BOT_TOKEN: string;
  CLAUDE_MEM_TELEGRAM_CHAT_ID: string;
  CLAUDE_MEM_TELEGRAM_WRAPUPS_ENABLED: string;
  CLAUDE_MEM_TELEGRAM_OBSERVATION_ALERTS_ENABLED: string;
  CLAUDE_MEM_TELEGRAM_WRAPUP_ROUTES: string;
  CLAUDE_MEM_TELEGRAM_TRIGGER_TYPES: string;
  CLAUDE_MEM_TELEGRAM_TRIGGER_CONCEPTS: string;
  CLAUDE_MEM_GROK_BOT_AWARENESS_ENABLED: string;
  CLAUDE_MEM_GROK_BOT_AWARENESS_AGENT_IDS: string;
  CLAUDE_MEM_GROK_BOT_AWARENESS_TRIGGER_TYPES: string;
  CLAUDE_MEM_GROK_BOT_AWARENESS_TRIGGER_CONCEPTS: string;
  CLAUDE_MEM_GROK_BOT_INJECT_ENABLED: string;
  CLAUDE_MEM_GROK_BOT_INJECT_AGENT_IDS: string;
  CLAUDE_MEM_GROK_BOT_INJECT_TIER: string;
  CLAUDE_MEM_GROK_BOT_INJECT_WINDOW: string;
  CLAUDE_MEM_GROK_BOT_INJECT_FALLBACK: string;
  CLAUDE_MEM_GROK_BOT_INJECT_PLATFORM_SOURCE: string;
  CLAUDE_MEM_GROK_BOT_INJECT_PROJECTS_BY_AGENT: string;
  CLAUDE_MEM_GROK_BOT_INJECT_MAX_LINE_CHARS: string;
  CLAUDE_MEM_GROK_BOT_INJECT_DEBOUNCE_MS: string;
  CLAUDE_MEM_GROK_BOT_INJECT_STANDING_LINE: string;
  // CCS Align (Worker Watch seat, Phase 0 breathing slice). Seat-owned middle
  // cache under ~/.claude-mem/ccs-align/<viewerId>/; pull-only, never a second
  // writer on LFG/Orifice logs. See plans/2026-09-09-ccs-align.md.
  CLAUDE_MEM_CCS_ALIGN_ENABLED: string;
  CLAUDE_MEM_CCS_ALIGN_VIEWER_IDS: string;
  CLAUDE_MEM_CCS_ALIGN_TRIGGER_TYPES: string;
  CLAUDE_MEM_CCS_ALIGN_PATCH_SHADOWS: string;
  CLAUDE_MEM_QUEUE_ENGINE: string;
  CLAUDE_MEM_REDIS_URL: string;
  CLAUDE_MEM_REDIS_HOST: string;
  CLAUDE_MEM_REDIS_PORT: string;
  CLAUDE_MEM_REDIS_MODE: string;
  CLAUDE_MEM_QUEUE_REDIS_PREFIX: string;
  CLAUDE_MEM_AUTH_MODE: string;
  CLAUDE_MEM_RUNTIME: string;
  // Phase 1a (cmem-sdk rename): canonical server settings keys. Hooks read
  // these first and fall back to the legacy `*_BETA_*` keys below.
  CLAUDE_MEM_SERVER_URL: string;
  CLAUDE_MEM_SERVER_API_KEY: string;
  CLAUDE_MEM_SERVER_PROJECT_ID: string;
  // Legacy keys retained for back-compat with existing settings.json files.
  CLAUDE_MEM_SERVER_BETA_URL: string;
  CLAUDE_MEM_SERVER_BETA_API_KEY: string;
  CLAUDE_MEM_SERVER_BETA_PROJECT_ID: string;
}

export class SettingsDefaultsManager {
  private static readonly DEFAULTS: SettingsDefaults = {
    CLAUDE_MEM_MODEL: 'claude-haiku-4-5-20251001',
    CLAUDE_MEM_CONTEXT_OBSERVATIONS: '50',
    CLAUDE_MEM_SESSION_START_INCLUDE_ALL_SOURCES: 'false',
    CLAUDE_MEM_WORKER_PORT: String(37700 + ((process.getuid?.() ?? 77) % 100)),
    CLAUDE_MEM_WORKER_HOST: '127.0.0.1',
    CLAUDE_MEM_PUBLIC_URL: '',  // Browser-reachable base for the live-view URL when the
                                // worker runs behind a port-forward (e.g.
                                // https://37700.host.<user>.<domain>). Empty => localhost.
    CLAUDE_MEM_API_TIMEOUT_MS: String(getTimeout(HOOK_TIMEOUTS.API_REQUEST)),
    CLAUDE_MEM_SKIP_TOOLS: 'ListMcpResourcesTool,SlashCommand,Skill,TodoWrite,AskUserQuestion',
    CLAUDE_MEM_SKIP_BASH_PATTERNS: '',  // Regex matched against a shell command (Bash; Codex exec_command); when it matches, the observation is skipped. Empty = capture every command. Use alternation for several patterns, e.g. ^(ls|cat|pwd)\b
    CLAUDE_MEM_SKIP_SUBAGENT_OBSERVATIONS: 'false',  // #2736 — default off preserves current behavior; set 'true' to skip every subagent observation (recommended for heavy Dynamic Workflows users)
    CLAUDE_MEM_SKIP_AGENT_TYPES: '',                 // #2736 — default empty preserves current behavior; recommended value 'workflow-subagent' to drop Dynamic Workflows fan-out noise
    // Deliberate divergence from the installer prompt: the interactive
    // provider prompt defaults to 'cmem' (the hosted observer), but headless
    // installs land here — no delivered key exists headlessly, so the settings
    // default stays 'claude'.
    CLAUDE_MEM_PROVIDER: 'claude',
    CLAUDE_MEM_CLAUDE_AUTH_METHOD: 'subscription',  // Default to logged-in Claude SDK auth (not API key)
    CLAUDE_MEM_GEMINI_API_KEY: '',  // Empty by default, can be set via UI or env
    CLAUDE_MEM_GEMINI_MODEL: 'gemini-flash-latest',  // Google-maintained alias → current GA Flash model (stays valid for new API keys)
    CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED: 'true',  // Rate limiting ON by default for free tier users
    CLAUDE_MEM_OPENROUTER_API_KEY: '',  // Empty by default, can be set via UI or env
    // Default OpenRouter model (free tier). The same id is hard-coded in
    // src/ui/viewer/constants/settings.ts (DEFAULT_SETTINGS) and three times in
    // openclaw/install.sh (settings defaults, openrouter override, completion
    // summary); tests/shared/settings-defaults-manager.test.ts keeps them equal.
    // Changing it strands installs that were seeded with the old id: add that
    // id to RETIRED_OPENROUTER_DEFAULT_MODELS.
    CLAUDE_MEM_OPENROUTER_MODEL: 'cohere/north-mini-code:free',
    CLAUDE_MEM_OPENROUTER_BASE_URL: '',  // #2382/#2590/#2622/#2393 — optional OpenAI-compatible base URL (e.g. https://api.deepseek.com, http://localhost:1234/v1). Empty = default OpenRouter endpoint.
    CLAUDE_MEM_OPENROUTER_SITE_URL: '',  // Optional: for OpenRouter analytics
    CLAUDE_MEM_OPENROUTER_APP_NAME: 'claude-mem',  // App name for OpenRouter analytics
    CLAUDE_MEM_DATA_DIR: join(homedir(), '.claude-mem'),
    CLAUDE_MEM_LOG_LEVEL: 'INFO',
    CLAUDE_MEM_PYTHON_VERSION: '3.13',
    CLAUDE_CODE_PATH: '', // Empty means auto-detect via 'which claude'
    CLAUDE_MEM_CLAUDE_CONFIG_DIR: '', // #2753 — override CLAUDE_CONFIG_DIR for the keychain lookup + SDK subprocess only; empty = fall through to process.env.CLAUDE_CONFIG_DIR/default
    CLAUDE_MEM_MODE: 'code', // Default mode profile
    CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS: 'false',
    CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS: 'false',
    CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT: 'false',
    CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT: 'true',
    CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES: '',  // Comma-separated observation types to inject. Empty = every type in the active mode
    CLAUDE_MEM_CONTEXT_OBSERVATION_CONCEPTS: '',  // Comma-separated observation concepts to inject. Empty = every concept in the active mode
    CLAUDE_MEM_CONTEXT_FULL_COUNT: '0',
    CLAUDE_MEM_CONTEXT_FULL_FIELD: 'narrative',
    CLAUDE_MEM_CONTEXT_SESSION_COUNT: '10',
    CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY: 'true',
    CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE: 'false',
    CLAUDE_MEM_CONTEXT_MAIN_AGENT_ONLY: 'true',
    CLAUDE_MEM_CONTEXT_SHOW_TERMINAL_OUTPUT: 'true',
    CLAUDE_MEM_WELCOME_HINT_ENABLED: 'true',
    CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED: 'false',
    CLAUDE_MEM_FOLDER_USE_LOCAL_MD: 'false',  // When true, writes to CLAUDE.local.md instead of CLAUDE.md
    CLAUDE_MEM_TRANSCRIPTS_ENABLED: 'true',
    CLAUDE_MEM_TRANSCRIPTS_CONFIG_PATH: join(homedir(), '.claude-mem', 'transcript-watch.json'),
    CLAUDE_MEM_CODEX_TRANSCRIPT_INGESTION: 'false',
    CLAUDE_MEM_MAX_CONCURRENT_AGENTS: '2',  // Max concurrent Claude SDK agent subprocesses
    CLAUDE_MEM_OBSERVER_MAX_CONVERSATION_CHARS: '400000',  // Retire an observer conversation past this size and start a fresh generation (#3800)
    CLAUDE_MEM_HOOK_FAIL_LOUD_THRESHOLD: '3',  // After N consecutive worker-unreachable hook invocations, show the worker-outage notice once per session (never blocks; plan-17)
    CLAUDE_MEM_REDACT_ENABLED: 'false',                   // Opt-in auto-redaction of common secret patterns (see docs/public/usage/auto-redaction.mdx)
    CLAUDE_MEM_REDACT_DISABLED_BUILTINS: '',              // CSV of built-in pattern names to disable, e.g. 'jwt,slack_token'
    CLAUDE_MEM_REDACT_CUSTOM_PATTERNS: '[]',              // JSON array of { name, regex } objects
    CLAUDE_MEM_REDACT_LOG_MATCHES: 'false',               // Log pattern,count per invocation (no payload)
    CLAUDE_MEM_EXCLUDED_PROJECTS: '',  // Comma-separated glob patterns for excluded project paths
    CLAUDE_MEM_FOLDER_MD_EXCLUDE: '[]',  // JSON array of folder paths to exclude from CLAUDE.md generation
    CLAUDE_MEM_FOLDER_MD_SKELETON_DENYLIST: '[]',  // #2400 — JSON array of glob patterns; when a folder matches AND its generated CLAUDE.md would be empty/skeleton, skip injection (avoids polluting non-content dirs with empty skeletons). Default [] preserves existing behavior.
    CLAUDE_MEM_SEMANTIC_INJECT: 'false',             // Inject relevant past observations on every UserPromptSubmit (experimental, disabled by default)
    CLAUDE_MEM_SEMANTIC_INJECT_LIMIT: '5',           // Top-N most relevant observations to inject per prompt
    CLAUDE_MEM_TIER_ROUTING_ENABLED: 'true',         // Route observations to models by complexity
    CLAUDE_MEM_TIER_SIMPLE_MODEL: 'haiku', // Portable tier alias — works across Direct API, Bedrock, Vertex, Azure (see #1463)
    CLAUDE_MEM_TIER_SUMMARY_MODEL: '',                // Empty = use default model for summaries
    CLAUDE_MEM_TIER_FAST_MODEL: 'haiku',              // #2289 — $TIER:fast resolves here (portable alias)
    CLAUDE_MEM_TIER_SMART_MODEL: 'sonnet',            // #2289 — $TIER:smart resolves here (portable alias)
    CLAUDE_MEM_CHROMA_ENABLED: 'true',         // Set to 'false' to disable Chroma and use SQLite-only search
    CLAUDE_MEM_CHROMA_MODE: 'local',           // 'local' uses persistent chroma-mcp via uvx, 'remote' connects to existing server
    CLAUDE_MEM_CHROMA_HOST: '127.0.0.1',
    CLAUDE_MEM_CHROMA_PORT: '8000',
    CLAUDE_MEM_CHROMA_SSL: 'false',
    CLAUDE_MEM_CHROMA_API_KEY: '',
    CLAUDE_MEM_CHROMA_TENANT: 'default_tenant',
    CLAUDE_MEM_CHROMA_DATABASE: 'default_database',
    CLAUDE_MEM_CHROMA_PREWARM_TIMEOUT_MS: '120000',
    CLAUDE_MEM_CHROMA_MUTATION_TIMEOUT_MS: '600000', // Chroma embedding/index writes can exceed the MCP SDK's 60s default
    CLAUDE_MEM_CHROMA_MAX_PENDING_MUTATIONS: '5000', // Bound burst imports without changing normal live indexing
    // Embedding function used when creating the Chroma collection. 'default' is
    // the local all-MiniLM-L6-v2 (English-tuned). The pinned chroma-mcp also
    // accepts 'openai', 'cohere', 'jina', 'voyageai' and 'roboflow'; those are
    // API-backed, need the vendor's API key in the environment, and send your
    // memory text to that vendor. Any other value is rejected. Applies to new
    // collections only — changing it requires re-indexing.
    CLAUDE_MEM_CHROMA_EMBEDDING_FUNCTION: 'default',
    // Worker-native cloud sync: credentials come from cmem.ai → Connect.
    CLAUDE_MEM_CLOUD_SYNC_TOKEN: '',
    CLAUDE_MEM_CLOUD_SYNC_USER_ID: '',
    CLAUDE_MEM_CLOUD_SYNC_HUB_URL: '',  // sync-hub base URL (e.g. https://sync.cmem.ai). Empty = sync OFF
    CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID: '',      // Minted at first CloudSync start, then persisted back here
    CLAUDE_MEM_CLOUD_SYNC_DEVICE_NAME: hostname(),  // Human-readable label for the cmem.ai Devices panel
    CLAUDE_MEM_CLOUD_SYNC_WS: 'true',  // Advisory WebSocket speed layer (plan Phase 4). 'false' = HTTP polling only — sync stays fully correct, just poll-latency (prime directive #2)
    CLAUDE_MEM_CLOUD_SYNC_CONTENT_BATCH_SIZE: '40',  // Drain page size; 200-op content pushes timed out under hub projection_busy
    CLAUDE_MEM_CLOUD_SYNC_REQUEST_TIMEOUT_MS: '90000',  // Content-push AbortSignal; matches hub PROJECTION_LEASE_MS (90s)
    CLAUDE_MEM_LLM_TIMEOUT_MS: '30000',                  // Per-attempt observer LLM deadline (retry.ts); raise for slow/local backends
    // Observation TV remote broadcast. EMPTY = OFF: the read-only guard is not
    // mounted and the worker behaves exactly as before. Set (with a non-loopback
    // CLAUDE_MEM_WORKER_HOST) to expose ONLY /tv, /tv.html, /stream and
    // GET /api/observations to holders of this secret. Mint with:
    //   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
    CLAUDE_MEM_TV_TOKEN: '',
    // claude-mem sign-in funnel state: all empty until the installer's
    // browser-login step writes them.
    CLAUDE_MEM_PRO_TRIAL_EMAIL: '',     // Email the sign-in link was sent to (don't-re-nag marker)
    CLAUDE_MEM_PRO_TRIAL_AT: '',        // ISO timestamp of the last sign-in link send
    CLAUDE_MEM_PRO_TRIAL_STATE: '',     // 'link_sent' (started, credentials never picked up) | 'active' (done)
    CLAUDE_MEM_PRO_TRIAL_ENDS_AT: '',   // ISO date the free trial ends (from poll trial.ends_at); '' when absent
    CLAUDE_MEM_PRO_PLAN: '',            // 'trial' | 'pro' | 'none' — plan reported by the poll on ready
    CLAUDE_MEM_PRO_FALLBACK_AT: '',     // ISO timestamp when the cmem gateway terminally rejected the delivered key and memory fell back to the Anthropic plan; '' = no fallback. Event-driven only (never set from trial dates); cleared by a successful gateway response or fresh installer key material.
    CLAUDE_MEM_PRO_FALLBACK_MESSAGE: '', // The gateway's message for that rejection ('' = plan-neutral notice copy)
    CLAUDE_MEM_PRO_FALLBACK_ACTION: '',  // The gateway's "what to do" for that rejection
    CLAUDE_MEM_PRO_FALLBACK_URL: '',     // The gateway's link for that rejection ('' = the cmem.ai/pro renewal link)
    CLAUDE_MEM_PRO_MEMORY_KEY: '',       // One-shot browser-pairing memory key, staged until provider selection (settings.json is chmod 0600 by the installer)
    CLAUDE_MEM_PRO_MEMORY_BASE_URL: '',  // Backend-supplied endpoint paired with CLAUDE_MEM_PRO_MEMORY_KEY
    CLAUDE_MEM_PRO_MEMORY_MODEL: '',     // Backend-supplied model paired with CLAUDE_MEM_PRO_MEMORY_KEY
    CLAUDE_MEM_TELEGRAM_ENABLED: 'true',
    CLAUDE_MEM_TELEGRAM_BOT_TOKEN: '',
    CLAUDE_MEM_TELEGRAM_CHAT_ID: '',
    CLAUDE_MEM_TELEGRAM_WRAPUPS_ENABLED: 'true', // Session-end wrap-ups require an explicit project route before sending.
    CLAUDE_MEM_TELEGRAM_OBSERVATION_ALERTS_ENABLED: 'false', // Existing per-observation Telegram alerts are opt-in.
    CLAUDE_MEM_TELEGRAM_WRAPUP_ROUTES: '{}', // JSON project-to-Telegram-route map; entries may carry bot-token overrides.
    CLAUDE_MEM_TELEGRAM_TRIGGER_TYPES: 'security_alert,sensitive',
    CLAUDE_MEM_TELEGRAM_TRIGGER_CONCEPTS: '',
    CLAUDE_MEM_GROK_BOT_AWARENESS_ENABLED: 'true',
    // Pilot agents: LFG + Orifice. Empty list = no writes.
    CLAUDE_MEM_GROK_BOT_AWARENESS_AGENT_IDS: '521e962d-2ec3-4488-bfbc-54d5209ce118,95601360-61f7-4fd9-bb3a-2c976b2b85c0',
    CLAUDE_MEM_GROK_BOT_AWARENESS_TRIGGER_TYPES: 'decision,bugfix,security_alert,sensitive',
    CLAUDE_MEM_GROK_BOT_AWARENESS_TRIGGER_CONCEPTS: '',
    // Live Grok Bot Memory INDEX. Worker writes zz-claude-mem-inject.md as
    // observations land. Default on; no-op when no Grok Bot seats exist.
    CLAUDE_MEM_GROK_BOT_INJECT_ENABLED: 'true',
    CLAUDE_MEM_GROK_BOT_INJECT_AGENT_IDS: '*',
    CLAUDE_MEM_GROK_BOT_INJECT_TIER: 'episode',
    CLAUDE_MEM_GROK_BOT_INJECT_WINDOW: '80',
    CLAUDE_MEM_GROK_BOT_INJECT_FALLBACK: 'house',
    CLAUDE_MEM_GROK_BOT_INJECT_PLATFORM_SOURCE: '',
    CLAUDE_MEM_GROK_BOT_INJECT_PROJECTS_BY_AGENT: '',
    CLAUDE_MEM_GROK_BOT_INJECT_MAX_LINE_CHARS: '160',
    CLAUDE_MEM_GROK_BOT_INJECT_DEBOUNCE_MS: '1500',
    CLAUDE_MEM_GROK_BOT_INJECT_STANDING_LINE: '',
    CLAUDE_MEM_CCS_ALIGN_ENABLED: 'true',
    CLAUDE_MEM_CCS_ALIGN_VIEWER_IDS: 'ccs-align',
    // Copy of the Grok needle list (D6). Same episodic needles, seat-owned cache.
    CLAUDE_MEM_CCS_ALIGN_TRIGGER_TYPES: 'decision,bugfix,security_alert,sensitive',
    // Phase 2 rules-shadow patch stays a Prioritizer flag, not a silent /do (D8).
    CLAUDE_MEM_CCS_ALIGN_PATCH_SHADOWS: 'false',
    CLAUDE_MEM_QUEUE_ENGINE: 'sqlite',
    CLAUDE_MEM_REDIS_URL: '',
    CLAUDE_MEM_REDIS_HOST: '127.0.0.1',
    CLAUDE_MEM_REDIS_PORT: '6379',
    CLAUDE_MEM_REDIS_MODE: 'external',
    CLAUDE_MEM_QUEUE_REDIS_PREFIX: `claude_mem_${process.env.CLAUDE_MEM_WORKER_PORT ?? String(37700 + ((process.getuid?.() ?? 77) % 100))}`,
    CLAUDE_MEM_AUTH_MODE: 'api-key',
    CLAUDE_MEM_RUNTIME: 'worker',
    // Phase 1a (cmem-sdk rename): canonical server settings keys. Hooks read
    // these first; the legacy `*_BETA_*` defaults below remain so existing
    // settings.json files still resolve correctly.
    CLAUDE_MEM_SERVER_URL: `http://127.0.0.1:${process.env.CLAUDE_MEM_SERVER_PORT ?? String(37877 + ((process.getuid?.() ?? 77) % 100))}`,  // Default server runtime URL — UID-derived for multi-account isolation
    CLAUDE_MEM_SERVER_API_KEY: '',                          // Local hook API key, populated by installer when runtime=server
    CLAUDE_MEM_SERVER_PROJECT_ID: '',                       // Default Postgres project_id used by hooks when runtime=server
    CLAUDE_MEM_SERVER_BETA_URL: `http://127.0.0.1:${process.env.CLAUDE_MEM_SERVER_PORT ?? String(37877 + ((process.getuid?.() ?? 77) % 100))}`,  // Legacy server-beta runtime URL — UID-derived for multi-account isolation
    CLAUDE_MEM_SERVER_BETA_API_KEY: '',                     // Legacy local hook API key (read as fallback when CLAUDE_MEM_SERVER_API_KEY unset)
    CLAUDE_MEM_SERVER_BETA_PROJECT_ID: '',                  // Legacy Postgres project_id (read as fallback when CLAUDE_MEM_SERVER_PROJECT_ID unset)
  };

  static getAllDefaults(): SettingsDefaults {
    return { ...this.DEFAULTS };
  }

  static get(key: keyof SettingsDefaults): string {
    const value = process.env[key] ?? this.DEFAULTS[key];
    if (key === 'CLAUDE_MEM_WORKER_HOST') {
      return this.normalizeWorkerHost(value);
    }
    return value;
  }

  // 'localhost' resolves IPv6-first on modern Windows resolvers while
  // server.listen(port, 'localhost') binds ::1 only, so the hook client and
  // the worker can land on different loopback families (#2992). Pin the
  // documented IPv4 loopback so every consumer of the setting agrees.
  private static normalizeWorkerHost(host: string): string {
    return host === 'localhost' ? '127.0.0.1' : host;
  }

  private static finalizeSettings(settings: SettingsDefaults, applyEnvOverrides: boolean): SettingsDefaults {
    const result = applyEnvOverrides ? this.applyEnvOverrides(settings) : settings;
    result.CLAUDE_MEM_WORKER_HOST = this.normalizeWorkerHost(result.CLAUDE_MEM_WORKER_HOST);
    return result;
  }

  static getInt(key: keyof SettingsDefaults): number {
    const value = this.get(key);
    return parseInt(value, 10);
  }

  private static applyEnvOverrides(settings: SettingsDefaults): SettingsDefaults {
    const result = { ...settings };
    for (const key of Object.keys(this.DEFAULTS) as Array<keyof SettingsDefaults>) {
      if (process.env[key] !== undefined) {
        result[key] = process.env[key]!;
      }
    }
    return result;
  }

  static loadFromFile(settingsPath: string, applyEnvOverrides = true): SettingsDefaults {
    try {
      if (!existsSync(settingsPath)) {
        const defaults = this.getAllDefaults();
        try {
          writeJsonFileAtomic(settingsPath, defaults);
          // stderr, never stdout: this fires on the first boot in a fresh data
          // dir, and CLI commands like `start` promise machine-readable JSON
          // on stdout to the hook framework.
          console.warn('[SETTINGS] Created settings file with defaults:', settingsPath);
        } catch (error: unknown) {
          console.warn('[SETTINGS] Failed to create settings file, using in-memory defaults:', settingsPath, error instanceof Error ? error.message : String(error));
        }
        return this.finalizeSettings(defaults, applyEnvOverrides);
      }

      const settingsData = readFileSync(settingsPath, 'utf-8');
      const settings = parseJsonWithBom<Record<string, any>>(settingsData);

      let flatSettings = settings;
      const hasNestedEnv = settings.env && typeof settings.env === 'object' && !Array.isArray(settings.env);
      const hasPeerRootKeys = hasNestedEnv && Object.keys(settings).some((key) => key !== 'env');
      if (hasNestedEnv) {
        flatSettings = settings.env;

        // A legacy file containing only `{ env: {...} }` can be flattened
        // safely. If it also contains peer root keys (hooks, permissions,
        // theme, etc.), retain the wrapper: flattening would destroy user data.
        if (!hasPeerRootKeys) {
          try {
            writeJsonFileAtomic(settingsPath, flatSettings);
            // stderr, never stdout — same JSON-on-stdout contract as above.
            console.warn('[SETTINGS] Migrated settings file from nested to flat schema:', settingsPath);
          } catch (error: unknown) {
            console.warn('[SETTINGS] Failed to auto-migrate settings file:', settingsPath, error instanceof Error ? error.message : String(error));
            // Continue with in-memory migration even if write fails
          }
        }
      }

      if (flatSettings.CLAUDE_MEM_TELEGRAM_TRIGGER_TYPES === LEGACY_TELEGRAM_TRIGGER_TYPES) {
        flatSettings = {
          ...flatSettings,
          CLAUDE_MEM_TELEGRAM_TRIGGER_TYPES: this.DEFAULTS.CLAUDE_MEM_TELEGRAM_TRIGGER_TYPES,
        };

        try {
          writeJsonFileAtomic(
            settingsPath,
            hasPeerRootKeys ? { ...settings, env: flatSettings } : flatSettings,
          );
          // stderr, never stdout — same JSON-on-stdout contract as above.
          console.warn('[SETTINGS] Migrated Telegram trigger types off the legacy default:', settingsPath);
        } catch (error: unknown) {
          console.warn('[SETTINGS] Failed to migrate Telegram trigger types:', settingsPath, error instanceof Error ? error.message : String(error));
          // Continue with the in-memory migration even if the write fails
        }
      }

      if (hasRetiredOpenRouterDefault(flatSettings)) {
        const retiredModel = String(flatSettings.CLAUDE_MEM_OPENROUTER_MODEL).trim();
        flatSettings = {
          ...flatSettings,
          CLAUDE_MEM_OPENROUTER_MODEL: this.DEFAULTS.CLAUDE_MEM_OPENROUTER_MODEL,
        };

        try {
          writeJsonFileAtomic(
            settingsPath,
            hasPeerRootKeys ? { ...settings, env: flatSettings } : flatSettings,
          );
          // stderr, never stdout — same JSON-on-stdout contract as above.
          console.warn(
            `[SETTINGS] Migrated OpenRouter model off the retired default ${retiredModel} to ${this.DEFAULTS.CLAUDE_MEM_OPENROUTER_MODEL}:`,
            settingsPath,
          );
        } catch (error: unknown) {
          console.warn('[SETTINGS] Failed to migrate the retired OpenRouter model:', settingsPath, error instanceof Error ? error.message : String(error));
          // Continue with the in-memory migration even if the write fails
        }
      }

      const rewrittenHubUrl = migratedCloudSyncHubUrl(flatSettings.CLAUDE_MEM_CLOUD_SYNC_HUB_URL);
      if (rewrittenHubUrl !== null) {
        flatSettings = {
          ...flatSettings,
          CLAUDE_MEM_CLOUD_SYNC_HUB_URL: rewrittenHubUrl,
        };

        try {
          writeJsonFileAtomic(
            settingsPath,
            hasPeerRootKeys ? { ...settings, env: flatSettings } : flatSettings,
          );
          console.warn('[SETTINGS] Migrated cloud sync hub URL off the legacy workers.dev host:', settingsPath);
        } catch (error: unknown) {
          console.warn('[SETTINGS] Failed to migrate cloud sync hub URL:', settingsPath, error instanceof Error ? error.message : String(error));
        }
      }

      const result: SettingsDefaults = { ...this.DEFAULTS };
      for (const key of Object.keys(this.DEFAULTS) as Array<keyof SettingsDefaults>) {
        if (flatSettings[key] !== undefined) {
          result[key] = flatSettings[key];
        }
      }

      return this.finalizeSettings(result, applyEnvOverrides);
    } catch (error: unknown) {
      console.warn('[SETTINGS] Failed to load settings, using defaults:', settingsPath, error instanceof Error ? error.message : String(error));
      const defaults = this.getAllDefaults();
      return this.finalizeSettings(defaults, applyEnvOverrides);
    }
  }
}
