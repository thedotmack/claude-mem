// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';

export const MemoryItemKindSchema = z.enum(['observation', 'summary', 'prompt', 'manual']);
export const MemorySourceTypeSchema = z.enum(['observation', 'session_summary', 'user_prompt', 'manual', 'import']);

export const MemoryItemSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  serverSessionId: z.string().min(1).nullable().default(null),
  legacyObservationId: z.number().int().positive().nullable().default(null),
  kind: MemoryItemKindSchema,
  type: z.string().min(1),
  title: z.string().min(1).nullable().default(null),
  subtitle: z.string().min(1).nullable().default(null),
  text: z.string().nullable().default(null),
  narrative: z.string().nullable().default(null),
  facts: z.array(z.string()).default([]),
  concepts: z.array(z.string()).default([]),
  filesRead: z.array(z.string()).default([]),
  filesModified: z.array(z.string()).default([]),
  metadata: z.record(z.string(), z.unknown()).default({}),
  createdAtEpoch: z.number().int().nonnegative(),
  updatedAtEpoch: z.number().int().nonnegative()
});

export const CreateMemoryItemSchema = MemoryItemSchema.omit({
  id: true,
  createdAtEpoch: true,
  updatedAtEpoch: true
}).partial({
  serverSessionId: true,
  legacyObservationId: true,
  title: true,
  subtitle: true,
  text: true,
  narrative: true,
  facts: true,
  concepts: true,
  filesRead: true,
  filesModified: true,
  metadata: true
});

export const MemorySourceSchema = z.object({
  id: z.string().min(1),
  memoryItemId: z.string().min(1),
  sourceType: MemorySourceTypeSchema,
  legacyTable: z.string().min(1).nullable().default(null),
  legacyId: z.number().int().positive().nullable().default(null),
  sourceUri: z.string().min(1).nullable().default(null),
  metadata: z.record(z.string(), z.unknown()).default({}),
  createdAtEpoch: z.number().int().nonnegative()
});

export const CreateMemorySourceSchema = MemorySourceSchema.omit({
  id: true,
  createdAtEpoch: true
}).partial({
  legacyTable: true,
  legacyId: true,
  sourceUri: true,
  metadata: true
});

export type MemoryItemKind = z.infer<typeof MemoryItemKindSchema>;
export type MemoryItem = z.infer<typeof MemoryItemSchema>;
export type CreateMemoryItem = z.infer<typeof CreateMemoryItemSchema>;
export type MemorySourceType = z.infer<typeof MemorySourceTypeSchema>;
export type MemorySource = z.infer<typeof MemorySourceSchema>;
export type CreateMemorySource = z.infer<typeof CreateMemorySourceSchema>;
