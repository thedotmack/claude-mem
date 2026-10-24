// SPDX-License-Identifier: Apache-2.0
//
// Subscription sign-ins are refused (plan D4). An agent signed in with a
// subscription stays on its native claude-mem integration; the gateway never
// forwards such a credential. magpie never forwards a Claude sign-in either
// (internal/gateway/claude_signin.go:12-38 `claudeSignIn`, MIT, Copyright (c)
// 2026 yetone).

import type { ErrorEnvelopeFamily } from './protocols.js';

export interface SubscriptionSignInMatch {
  /** Whose error envelope the refusal uses when the suffix names no protocol. */
  vendorFamily: ErrorEnvelopeFamily;
  /** What gave it away, for the log and the message. Never the credential itself. */
  marker: string;
}

function bearerTokenOf(headers: Headers): string {
  const authorization = (headers.get('authorization') ?? '').trim();
  return /^bearer\s+/i.test(authorization) ? authorization.replace(/^bearer\s+/i, '').trim() : '';
}

/**
 * The D4 markers:
 * - Anthropic: `sk-ant-oat…` in authorization/x-api-key, or an `oauth-` value in anthropic-beta
 * - OpenAI/Codex: a JWT bearer (`eyJ…`), a chatgpt-account-id header, or upstream host chatgpt.com
 * - Google: `Bearer ya29.`, or upstream host cloudcode-pa.googleapis.com
 */
export function detectSubscriptionSignIn(headers: Headers, upstreamUrl: URL): SubscriptionSignInMatch | null {
  const bearerToken = bearerTokenOf(headers);
  const apiKeyHeader = (headers.get('x-api-key') ?? '').trim();
  const upstreamHost = upstreamUrl.hostname.toLowerCase();

  if (bearerToken.startsWith('sk-ant-oat') || apiKeyHeader.startsWith('sk-ant-oat')) {
    return { vendorFamily: 'anthropic', marker: 'a Claude subscription sign-in token (sk-ant-oat…)' };
  }
  // anthropic-beta may be comma-separated or repeated; Headers joins repeats with ", ".
  const betaValues = (headers.get('anthropic-beta') ?? '').split(',').map(value => value.trim().toLowerCase());
  if (betaValues.some(value => value.startsWith('oauth-'))) {
    return { vendorFamily: 'anthropic', marker: 'an oauth- value in anthropic-beta' };
  }

  if (bearerToken.startsWith('eyJ')) {
    return { vendorFamily: 'openai', marker: 'a ChatGPT sign-in token (a JWT bearer)' };
  }
  if (headers.has('chatgpt-account-id')) {
    return { vendorFamily: 'openai', marker: 'a chatgpt-account-id header' };
  }
  if (upstreamHost === 'chatgpt.com' || upstreamHost.endsWith('.chatgpt.com')) {
    return { vendorFamily: 'openai', marker: 'an upstream at chatgpt.com (ChatGPT sign-in)' };
  }

  if (bearerToken.startsWith('ya29.')) {
    return { vendorFamily: 'gemini', marker: 'a Google account sign-in token (ya29.)' };
  }
  if (upstreamHost === 'cloudcode-pa.googleapis.com') {
    return { vendorFamily: 'gemini', marker: 'an upstream at cloudcode-pa.googleapis.com (Google sign-in)' };
  }
  return null;
}

/** The refusal text: what was refused, and the fix (`claude-mem wire disconnect <agent>`). */
export function subscriptionRefusalMessage(match: SubscriptionSignInMatch, agentId: string): string {
  return `claude-mem wire gateway refuses to forward subscription sign-ins (it saw ${match.marker}). `
    + `An agent signed in with a subscription stays on its native claude-mem integration: run \`claude-mem wire disconnect ${agentId}\`, `
    + 'or sign the agent in with an API key.';
}
