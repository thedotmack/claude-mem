/**
 * Cost-per-observation copy for the installer's provider prompt.
 *
 * Rates are fetched LIVE from OpenRouter and never hardcoded. Model pricing
 * changes constantly and old models tend to get more expensive, so a constant
 * baked into source is wrong the moment it is written. The first version of this
 * file learned that the hard way: within weeks of shipping, its figures had
 * drifted +56% for DeepSeek and +254% for Anthropic Haiku, which made the prompt
 * understate every option that bills the user — i.e. it argued against CMEM Pro
 * using CMEM Pro's own numbers.
 *
 * Derivation:
 *
 *   $/1k observations = blendedRatePerM × TOKENS_PER_OBSERVATION × 1000 / 1e6
 *                     = blendedRatePerM × 56          (at 56k tokens/observation)
 *
 *   blendedRatePerM   = input$/M × 0.987 + output$/M × 0.013
 *
 * The 98.7 / 1.3 split is claude-mem's real traffic shape: observation prompts
 * are enormous and their summaries are small.
 */

/** OpenRouter's public model catalogue. No auth required. */
const MODELS_URL = 'https://openrouter.ai/api/v1/models';

/**
 * The prompt is interactive, so pricing must never be what makes it feel slow.
 * Three seconds is generous for a single GET; past that we fall back and move on.
 */
const FETCH_TIMEOUT_MS = 3_000;

/**
 * Tokens burned per observation — measured, not assumed.
 *
 * 55,960 across 201 real observations on 2026-08-08. The previous value of
 * 30,000 was an estimate and was low by 1.87x, which understated every figure
 * below on top of the pricing drift. Cost per observation climbs with context
 * inside a session and resets between sessions, so this is a mean over a mixed
 * workload rather than a per-call constant.
 */
export const TOKENS_PER_OBSERVATION = 56_000;

/** Flat CMEM Pro subscription price, in USD per month. */
export const CMEM_PRO_MONTHLY_USD = 30;

/** claude-mem's measured input/output mix. */
const INPUT_SHARE = 0.987;
const OUTPUT_SHARE = 0.013;

/** The models each prompt option actually runs on. */
const MODEL_IDS = {
  openrouter: 'deepseek/deepseek-v4-flash',
  gemini: 'google/gemini-2.5-flash-lite',
  claude: 'anthropic/claude-haiku-4.5',
} as const;

type OptionKey = keyof typeof MODEL_IDS;
type Rates = Record<OptionKey, number>;

/**
 * Last-resort rates, in blended $/M.
 *
 * Only used when OpenRouter is unreachable. Captured live on 2026-08-08 — they
 * are a floor for graceful degradation, NOT a source of truth, and they will
 * drift exactly like their predecessors did. If you are tempted to "just update
 * these," fix the fetch instead.
 */
const FALLBACK_BLENDED_PER_M: Rates = {
  openrouter: 0.1418,
  gemini: 0.1039,
  claude: 1.052,
};

function blend(promptPerToken: string, completionPerToken: string): number {
  const input = Number(promptPerToken) * 1e6;
  const output = Number(completionPerToken) * 1e6;
  if (!Number.isFinite(input) || !Number.isFinite(output)) return NaN;
  return input * INPUT_SHARE + output * OUTPUT_SHARE;
}

/**
 * Pull live blended rates. Returns the fallback for any model the catalogue does
 * not describe, so one renamed or retired model id cannot blank the whole prompt.
 */
export async function fetchBlendedRates(): Promise<{ rates: Rates; live: boolean }> {
  try {
    const response = await fetch(MODELS_URL, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return { rates: FALLBACK_BLENDED_PER_M, live: false };

    const payload = (await response.json()) as {
      data?: Array<{ id?: string; pricing?: { prompt?: string; completion?: string } }>;
    };
    const byId = new Map(
      (payload.data ?? []).filter((m) => m?.id).map((m) => [m.id as string, m])
    );

    const rates = { ...FALLBACK_BLENDED_PER_M };
    let matched = 0;
    for (const key of Object.keys(MODEL_IDS) as OptionKey[]) {
      const pricing = byId.get(MODEL_IDS[key])?.pricing;
      if (!pricing?.prompt || !pricing?.completion) continue;
      const value = blend(pricing.prompt, pricing.completion);
      if (Number.isFinite(value) && value > 0) {
        rates[key] = value;
        matched++;
      }
    }
    // "live" only if the catalogue actually priced everything we ask about;
    // a partial answer is a fallback wearing a live badge.
    return { rates, live: matched === Object.keys(MODEL_IDS).length };
  } catch {
    // Offline installs are normal and must not be blocked by a pricing lookup.
    return { rates: FALLBACK_BLENDED_PER_M, live: false };
  }
}

/** Dollars per 1,000 observations for a blended $/M rate, e.g. 0.1418 -> "7.94". */
export function costPer1kObservations(blendedPerM: number): string {
  return ((blendedPerM * TOKENS_PER_OBSERVATION) / 1000).toFixed(2);
}

export interface ProviderLabels {
  cmem: string;
  cmemHint: string;
  openrouter: string;
  gemini: string;
  claude: string;
  /** False when any rate came from the fallback table. */
  live: boolean;
}

/**
 * Build the four option labels.
 *
 * CMEM Pro deliberately carries no computed $/1k figure. It is a flat
 * subscription that does not bill the user's own tokens, so the honest framing
 * is "$0/1k from your plan" plus the monthly price. Printing a derived $/1k for
 * it would compare a retail subscription against wholesale token cost.
 *
 * The leading text of each label is padded so the parenthesised cost column
 * lines up in the terminal.
 */
export async function buildProviderLabels(): Promise<ProviderLabels> {
  const { rates, live } = await fetchBlendedRates();

  return {
    cmem:
      `CMEM Pro — observer model, off your plan  ($0/1k observations · $${CMEM_PRO_MONTHLY_USD}/mo, cloud sync included)`,
    cmemHint: `${CMEM_PRO_TRIAL_DAYS} days free, then $${CMEM_PRO_MONTHLY_USD}/mo`,
    openrouter:
      `OpenRouter / any OpenAI-compatible key    (~$${costPer1kObservations(rates.openrouter)}/1k observations, billed to you)`,
    gemini:
      `Gemini API key                            (~$${costPer1kObservations(rates.gemini)}/1k observations, billed to you)`,
    claude:
      `Use your Anthropic plan                   (~$${costPer1kObservations(rates.claude)}/1k observations, from your Claude plan)`,
    live,
  };
}

/**
 * Origin for the CMEM Pro funnel. Overridable so the whole flow can be walked
 * against a dev server before it ships.
 *
 *   CMEM_PRO_ORIGIN=http://localhost:3005 node dist/npx-cli/index.js install
 */
const CMEM_PRO_ORIGIN = (process.env.CMEM_PRO_ORIGIN?.trim() || 'https://cmem.ai').replace(/\/+$/, '');

/** Where the installer sends people to buy CMEM Pro. */
export const CMEM_PRO_SIGNUP_URL = `${CMEM_PRO_ORIGIN}/pro?from=installer`;

/**
 * The 30-day card-upfront trial funnel (plan 2026-08-08-seven-day-trial-npx-funnel).
 *
 * `start` creates the cmem.ai account + emails a sign-in link and answers with
 * a pairing id/secret plus a device-authorization `user_code` the human types
 * into the browser to approve this device; `poll` is the credential handoff
 * the installer loops on while the human clicks the link, enters a card
 * ($0 today), and approves the device. Both are unauthenticated cmem.ai
 * endpoints — the CLI never holds a session-granting link, only the pairing
 * pair, and the credential delivered on `ready` is the existing setup_token
 * (delivered exactly once, and only after device approval).
 */
export const CMEM_PRO_TRIAL_START_URL = `${CMEM_PRO_ORIGIN}/api/pro/trial/start`;
export const CMEM_PRO_TRIAL_POLL_URL = `${CMEM_PRO_ORIGIN}/api/pro/trial/poll`;
export const CMEM_PRO_TRIAL_DAYS = 30;

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
 * (`/^cm_pro_(?:[0-9a-f]{24}|[0-9a-f]{32})$/`). This range form is deliberately
 * one notch looser so a future key length does not strand the installer; the
 * server stays the real gate.
 */
export const CMEM_PRO_KEY_PATTERN = /^cm_pro_[0-9a-f]{24,32}$/;
