/**
 * Single source of truth for the cost-per-observation copy shown in the
 * installer's provider prompt.
 *
 * Derivation — change ONE constant and every string below re-derives:
 *
 *   TOKENS_PER_OBSERVATION = 30_000        // tokens burned per observation
 *   $/1k observations = ratePerM * TOKENS_PER_OBSERVATION / 1000
 *                     = ratePerM * 30      (at 30k tokens/observation)
 *
 * Rates are blended $/M-token figures from the investor deck
 * ("Claude-Mem Numbers"), mixed at claude-mem's real traffic shape
 * (98.7% input / 1.3% output):
 *
 *   Anthropic Haiku 4.5             $0.297/M  ->  $8.91 / 1k observations
 *   Gemini 2.5 Flash Lite           $0.113/M  ->  $3.39 / 1k observations
 *   OpenRouter / DeepSeek V4 Flash  $0.091/M  ->  $2.73 / 1k observations
 *
 * CMEM Pro deliberately has NO $/1k figure. It is a flat subscription that does
 * not bill the user's own tokens, so the honest (and stronger) framing is
 * "$0/1k observations" from your plan plus the flat monthly price. Printing a
 * computed $/1k for CMEM Pro would compare a retail subscription against
 * wholesale token cost and is explicitly not what this prompt does.
 */

/** The one constant to tune. Everything else is derived from it. */
export const TOKENS_PER_OBSERVATION = 30_000;

/** Flat CMEM Pro subscription price, in USD per month. */
export const CMEM_PRO_MONTHLY_USD = 30;

/**
 * Blended $/M-token rates. `geminiFlashLite` is the softest of the three — it is
 * not sourced directly from the deck; verify before leaning on it.
 */
export const RATE_PER_MILLION_USD = {
  anthropicHaiku45: 0.297,
  geminiFlashLite25: 0.113,
  openRouterDeepSeekV4Flash: 0.091,
} as const;

/** Dollars per 1,000 observations for a given $/M-token rate, e.g. 0.297 -> "8.91". */
export function costPer1kObservations(ratePerMillionUsd: number): string {
  return ((ratePerMillionUsd * TOKENS_PER_OBSERVATION) / 1000).toFixed(2);
}

const CLAUDE_PER_1K = costPer1kObservations(RATE_PER_MILLION_USD.anthropicHaiku45);
const GEMINI_PER_1K = costPer1kObservations(RATE_PER_MILLION_USD.geminiFlashLite25);
const OPENROUTER_PER_1K = costPer1kObservations(RATE_PER_MILLION_USD.openRouterDeepSeekV4Flash);

/**
 * Provider prompt labels. The leading text of each is padded so the
 * parenthesised cost column lines up in the terminal.
 */
export const CMEM_PRO_OPTION_LABEL =
  `CMEM Pro — observer model, off your plan  ($0/1k observations · $${CMEM_PRO_MONTHLY_USD}/mo, cloud sync included)`;

export const CMEM_PRO_OPTION_HINT = 'Recommended';

export const OPENROUTER_OPTION_LABEL =
  `OpenRouter / any OpenAI-compatible key    (~$${OPENROUTER_PER_1K}/1k observations, billed to you)`;

export const GEMINI_OPTION_LABEL =
  `Gemini API key                            (~$${GEMINI_PER_1K}/1k observations, billed to you)`;

export const CLAUDE_OPTION_LABEL =
  `Use your Anthropic plan                   (~$${CLAUDE_PER_1K}/1k observations, billed to your Claude plan)`;

/**
 * Origin for the CMEM Pro funnel. Overridable so the whole flow can be walked
 * against a dev server before it ships — same escape hatch the waitlist opt-in
 * already uses (CLAUDE_MEM_SIGNUP_URL, see commands/install.ts). Production
 * needs no env var set.
 *
 *   CMEM_PRO_ORIGIN=http://localhost:3005 node dist/npx-cli/index.js install
 */
const CMEM_PRO_ORIGIN = (process.env.CMEM_PRO_ORIGIN?.trim() || 'https://cmem.ai').replace(/\/+$/, '');

/** Where the installer sends people to buy CMEM Pro. */
export const CMEM_PRO_SIGNUP_URL = `${CMEM_PRO_ORIGIN}/pro?from=installer`;

/**
 * CMEM Pro settings, written as a plain `openrouter` provider config: the
 * worker's OpenRouter client is a generic OpenAI-compatible client whose base
 * URL and model are both settings-driven, so CMEM Pro needs no provider code.
 * The worker only understands 'claude' | 'gemini' | 'openrouter' — 'cmem' is an
 * installer-prompt-only value and must never reach settings.json.
 */
export const CMEM_PRO_BASE_URL = `${CMEM_PRO_ORIGIN}/api/inference/v1`;
export const CMEM_PRO_MODEL = 'cmem-observer';

/**
 * Typo guard for the pasted key. Mirrors the server-side validator at
 * `cmem-pro-mvp/src/lib/pro/mcp-token-format.ts:9`
 * (`/^cm_pro_(?:[0-9a-f]{24}|[0-9a-f]{32})$/` — 24 or 32 hex chars, the two
 * lengths ever issued). This range form is deliberately one notch looser so a
 * future key length does not strand the installer; the server stays the real
 * gate. Keep the two in sync if the issued shape changes.
 */
export const CMEM_PRO_KEY_PATTERN = /^cm_pro_[0-9a-f]{24,32}$/;
