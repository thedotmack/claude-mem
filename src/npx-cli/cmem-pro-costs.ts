/**
 * OAuth, provider-choice, and CMEM Pro copy shared by the installer and its
 * contract tests. Keep this file static: the provider screen must render even
 * before the worker is running and must not depend on a pricing API.
 */

import { cmemProOrigin } from '../shared/cmem-gateway.js';

export const PROVIDER_PROMPT_MESSAGE =
  'Select Provider:\nClaude-Mem uses tokens to take notes of what your agent is working on in real-time.';

export const CMEM_TRIAL_ACKNOWLEDGEMENT =
  "Free Trial includes a week's worth of allowance and auto-charges if you reach the limit.";

export const CMEM_PRO_BENEFITS = [
  'Access what every agent is working on from everywhere — ChatGPT, Claude, Gemini, and more.',
  'Up to 100% more use out of your existing Anthropic plan.',
  "Writes memories so you don't use expensive AI for something that our more specialized AI handles better, faster, less expensive.",
  'Cloud sync keeps every device and agent on the same memory.',
  'One private, searchable memory you can reach through MCP.',
] as const;

export const ANTHROPIC_MAX_BENEFITS = [
  'Uses your existing Anthropic Max Plan for note-taking.',
  'Keeps memories and the observations database in ~/.claude-mem on this machine.',
  'Includes local semantic search and automatic memory recall.',
  'Open-source local storage with no separate CMEM Pro subscription.',
] as const;

export interface ProviderLabels {
  cmem: string;
  cmemHint: string;
  claude: string;
  claudeHint: string;
}

export function buildProviderLabels(): ProviderLabels {
  return {
    cmem: 'CMEM Pro',
    cmemHint: 'Shared cloud memory across agents, apps, and devices',
    claude: 'Use your Anthropic Max Plan',
    claudeHint: 'Local memory using the plan you already have',
  };
}

export function buildProviderBenefitsNote(): string {
  const section = (title: string, benefits: readonly string[]) => [
    title,
    ...benefits.map((benefit) => `  ✓ ${benefit}`),
  ].join('\n');

  return [
    section('CMEM Pro', CMEM_PRO_BENEFITS),
    '',
    section('Use your Anthropic Max Plan', ANTHROPIC_MAX_BENEFITS),
  ].join('\n');
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
