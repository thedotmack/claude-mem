/**
 * Provider-prompt copy and CMEM Pro constants for the installer.
 *
 * This file used to compute live $/1k-observation figures from OpenRouter's
 * pricing catalogue. That engine is gone: every option is now framed by where
 * memory runs — on your plan or off it ("get % more usage from your plan") —
 * which cannot drift the way dollar figures did. The only dollar amount that
 * survives is CMEM_PRO_MONTHLY_USD, kept for the single price-disclosure line
 * shown at the sign-in moment.
 */

import { PLAN_USAGE_GAIN_PERCENT } from '../shared/pro-promo.js';

/** Flat CMEM Pro subscription price, in USD per month. */
export const CMEM_PRO_MONTHLY_USD = 30;

export interface ProviderLabels {
  cmem: string;
  cmemHint: string;
  openrouter: string;
  gemini: string;
  claude: string;
}

/**
 * The four option labels — static copy, no network, no dollar figures.
 *
 * Each label says where memory generation runs (on- or off-plan) instead of
 * quoting a price; the one price disclosure lives in the sign-in note, not
 * here.
 */
export function buildProviderLabels(): ProviderLabels {
  return {
    cmem: `claude-mem (recommended) — memory runs off-plan: up to ${PLAN_USAGE_GAIN_PERCENT}% more usage from your plan`,
    cmemHint: `Free for ${CMEM_PRO_TRIAL_DAYS} days, then falls back to your Anthropic plan unless you subscribe`,
    openrouter: 'Your OpenRouter key — memory runs off-plan on your OpenRouter credit',
    gemini: 'Gemini API key — memory runs off-plan on your Gemini key',
    claude: 'Anthropic plan — memory shares your Claude plan usage',
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
 * The 7-day card-upfront trial funnel (plan 2026-08-08-seven-day-trial-npx-funnel).
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
export const CMEM_PRO_TRIAL_DAYS = 7;

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
