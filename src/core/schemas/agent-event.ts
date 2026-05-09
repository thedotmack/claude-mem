// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';

export const AgentEventSourceTypeSchema = z.enum(['hook', 'worker', 'provider', 'server', 'api']);

export const AgentEventSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  serverSessionId: z.string().min(1).nullable().default(null),
  sourceType: AgentEventSourceTypeSchema,
  eventType: z.string().min(1),
  payload: z.unknown().default({}),
  contentSessionId: z.string().min(1).nullable().default(null),
  memorySessionId: z.string().min(1).nullable().default(null),
  occurredAtEpoch: z.number().int().nonnegative(),
  createdAtEpoch: z.number().int().nonnegative()
});

export const CreateAgentEventSchema = AgentEventSchema.omit({
  id: true,
  createdAtEpoch: true
}).partial({
  serverSessionId: true,
  payload: true,
  contentSessionId: true,
  memorySessionId: true
});

export type AgentEventSourceType = z.infer<typeof AgentEventSourceTypeSchema>;
export type AgentEvent = z.infer<typeof AgentEventSchema>;
export type CreateAgentEvent = z.infer<typeof CreateAgentEventSchema>;
