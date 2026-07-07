// SPDX-License-Identifier: Apache-2.0

import { stringifyAdvice } from './advisor-advice.js';

/**
 * Shared shape for the server runtimes' /v1/advisor-calls responses. Both the
 * SQLite and Postgres v1 routes reshape a raw `tool_use` agent_event (whose
 * payload carries whatever the Stop hook sent — see cli/handlers/summarize.ts)
 * through this one function so the two backends cannot drift apart.
 */
export interface AdvisorCallViewMeta {
  id: string;
  project: string;
  occurredAtEpoch: number;
  /** Used when the payload itself doesn't carry a platformSource. */
  platformSourceFallback?: string | null;
  contentSessionId?: string | null;
  serverSessionId?: string | null;
}

export function buildAdvisorCallView(payloadRaw: unknown, meta: AdvisorCallViewMeta): Record<string, unknown> {
  const payload = (payloadRaw && typeof payloadRaw === 'object') ? payloadRaw as Record<string, unknown> : {};
  return {
    id: meta.id,
    project: meta.project,
    ...(meta.contentSessionId !== undefined ? { contentSessionId: meta.contentSessionId } : {}),
    ...(meta.serverSessionId !== undefined ? { serverSessionId: meta.serverSessionId } : {}),
    platformSource: typeof payload.platformSource === 'string' ? payload.platformSource : (meta.platformSourceFallback ?? null),
    advisorModel: typeof payload.advisorModel === 'string' ? payload.advisorModel : null,
    toolUseId: typeof payload.toolUseId === 'string' ? payload.toolUseId : null,
    cwd: typeof payload.cwd === 'string' ? payload.cwd : null,
    lastUserMessage: typeof payload.lastUserMessage === 'string' ? payload.lastUserMessage : null,
    transcriptPath: typeof payload.transcriptPath === 'string' ? payload.transcriptPath : null,
    transcriptLineNumber: typeof payload.transcriptLineNumber === 'number' ? payload.transcriptLineNumber : null,
    advice: stringifyAdvice(payload.tool_response),
    occurredAtEpoch: meta.occurredAtEpoch,
  };
}
