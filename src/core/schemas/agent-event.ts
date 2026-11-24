// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';

export const AgentEventSourceTypeSchema = z.enum(['hook', 'worker', 'provider', 'server', 'api']);

// Largest epoch a JS Date can hold; past it the insert fails with a 500 the
// hook spool would replay for its whole retry window.
const MAX_DATE_EPOCH_MS = 8_640_000_000_000_000;

export const AgentEventSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  serverSessionId: z.string().min(1).nullable().default(null),
  sourceType: AgentEventSourceTypeSchema,
  eventType: z.string().min(1),
  // #2560 — which platform produced the event (claude-code, opencode, cursor,
  // ...). Persisted on the Postgres agent_events row for plan-09 scoping; the
  // SQLite repo ignores it. Optional and nullable so existing clients are
  // unaffected.
  platformSource: z.string().min(1).nullable().default(null),
  payload: z.unknown().default({}),
  contentSessionId: z.string().min(1).nullable().default(null),
  memorySessionId: z.string().min(1).nullable().default(null),
  occurredAtEpoch: z.number().int().nonnegative().max(MAX_DATE_EPOCH_MS),
  createdAtEpoch: z.number().int().nonnegative().max(MAX_DATE_EPOCH_MS)
});

export const CreateAgentEventSchema = AgentEventSchema.omit({
  id: true,
  createdAtEpoch: true
}).partial({
  serverSessionId: true,
  platformSource: true,
  payload: true,
  contentSessionId: true,
  memorySessionId: true
});

export type AgentEventSourceType = z.infer<typeof AgentEventSourceTypeSchema>;
export type AgentEvent = z.infer<typeof AgentEventSchema>;
export type CreateAgentEvent = z.infer<typeof CreateAgentEventSchema>;
