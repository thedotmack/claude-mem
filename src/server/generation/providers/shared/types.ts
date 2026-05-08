// SPDX-License-Identifier: Apache-2.0

import type { PostgresAgentEvent } from '../../../../storage/postgres/agent-events.js';
import type { PostgresObservationGenerationJob } from '../../../../storage/postgres/generation-jobs.js';

// ServerGenerationContext is the input handed to a server provider adapter.
// It is reloaded from Postgres on every retry; BullMQ payload is advisory.
// Anti-pattern guard: this MUST NOT carry worker session state.
export interface ServerGenerationContext {
  readonly job: PostgresObservationGenerationJob;
  readonly events: readonly PostgresAgentEvent[];
  readonly project: {
    readonly projectId: string;
    readonly teamId: string;
    readonly serverSessionId: string | null;
    readonly projectName?: string | null;
  };
}

// ServerGenerationResult is the raw provider response (XML accepted by
// parseAgentXml). Empty string means provider returned nothing — handled
// upstream as a "skip with no observation" outcome by processGeneratedResponse.
export interface ServerGenerationResult {
  readonly rawText: string;
  readonly tokensUsed?: number;
  readonly providerLabel: string;
  readonly modelId?: string;
}

export interface ServerGenerationProvider {
  readonly providerLabel: 'claude' | 'gemini' | 'openrouter';
  generate(context: ServerGenerationContext, signal?: AbortSignal): Promise<ServerGenerationResult>;
}
