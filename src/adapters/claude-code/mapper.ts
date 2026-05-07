// SPDX-License-Identifier: Apache-2.0

import type { CreateAgentEvent } from '../../core/schemas/agent-event.js';
import { normalizePlatformSource } from '../../shared/platform-source.js';

export interface ClaudeCodeBasePayload {
  contentSessionId: string;
  memorySessionId?: string | null;
  platformSource?: string | null;
  cwd?: string;
  agentId?: string;
  agentType?: string;
  [key: string]: unknown;
}

export interface ClaudeCodeObservationPayload extends ClaudeCodeBasePayload {
  tool_name: string;
  tool_input?: unknown;
  tool_response?: unknown;
  tool_use_id?: string;
  toolUseId?: string;
}

export function mapClaudeCodeSessionInitToAgentEvent(
  projectId: string,
  payload: ClaudeCodeBasePayload,
  occurredAtEpoch = Date.now(),
): CreateAgentEvent {
  return mapClaudeCodePayload(projectId, payload, 'session.init', occurredAtEpoch);
}

export function mapClaudeCodeObservationToAgentEvent(
  projectId: string,
  payload: ClaudeCodeObservationPayload,
  occurredAtEpoch = Date.now(),
): CreateAgentEvent {
  return mapClaudeCodePayload(projectId, payload, 'observation.created', occurredAtEpoch);
}

export function mapClaudeCodeSummaryToAgentEvent(
  projectId: string,
  payload: ClaudeCodeBasePayload,
  occurredAtEpoch = Date.now(),
): CreateAgentEvent {
  return mapClaudeCodePayload(projectId, payload, 'session.summary', occurredAtEpoch);
}

function mapClaudeCodePayload(
  projectId: string,
  payload: ClaudeCodeBasePayload,
  eventType: string,
  occurredAtEpoch: number,
): CreateAgentEvent {
  const platformSource = normalizePlatformSource(payload.platformSource);
  return {
    projectId,
    sourceType: 'hook',
    eventType,
    payload: {
      ...payload,
      platformSource,
      toolUseId: payload.toolUseId ?? payload.tool_use_id ?? null,
    },
    contentSessionId: payload.contentSessionId,
    memorySessionId: payload.memorySessionId ?? null,
    occurredAtEpoch,
  };
}
