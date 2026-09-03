/**
 * OAuth, provider-choice, and CMEM Pro copy shared by the installer and its
 * contract tests. Keep this file static: the provider screen must render even
 * before the worker is running and must not depend on a pricing API.
 */

import { cmemProOrigin } from '../shared/cmem-gateway.js';

export const PROVIDER_PROMPT_MESSAGE =
  'Select Provider:\n================';

export const CMEM_TRIAL_ACKNOWLEDGEMENT =
  "Free Trial includes a week's worth of allowance and auto-charges if you reach the limit.";

export interface ProviderLabels {
  cmem: string;
  cmemHint: string;
  claude: string;
  claudeHint: string;
}

/**
 * The description rides in the LABEL, not in clack's `hint`.
 *
 * clack's multiselect renders a hint only for the focused, selected, or
 * disabled row — a plain unselected row renders label only. Since this prompt
 * opens with nothing selected, hints would reveal one description at a time as
 * the user arrows around, instead of showing both choices side by side. The
 * parentheses are ours for the same reason: clack adds its own `(...)` around a
 * hint, but never around a label.
 */
export function buildProviderLabels(): ProviderLabels {
  return {
    cmem: 'CMEM Pro (30 Day Free Trial: Tokens for Observations + Real-Time Cloud Sync '
      + 'for Claude.ai, ChatGPT.com, anything that accepts an MCP Connector)',
    cmemHint: '',
    claude: 'Use your Anthropic Max Plan (no cloud sync, uses tokens for observations)',
    claudeHint: '',
  };
}

/** Overridable so the OAuth pairing flow can be tested against a dev server. */
const CMEM_PRO_ORIGIN = cmemProOrigin();

/** Starts a terminal/browser pairing without accepting an email address. */
export const CMEM_INSTALLER_OAUTH_START_URL = `${CMEM_PRO_ORIGIN}/api/installer/oauth/start`;

/** Reads authentication and, after Pro selection, enrollment progress. */
export const CMEM_INSTALLER_OAUTH_POLL_URL = `${CMEM_PRO_ORIGIN}/api/pro/trial/poll`;

/** Generic OpenAI-compatible settings used by the CMEM observer. */
export const CMEM_PRO_BASE_URL = `${CMEM_PRO_ORIGIN}/api/inference/v1`;
export const CMEM_PRO_MODEL = 'cmem-observer';
