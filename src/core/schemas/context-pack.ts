// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';
import { MemoryItemSchema } from './memory-item.js';

export const ContextPackSchema = z.object({
  projectId: z.string().min(1),
  serverSessionId: z.string().min(1).nullable().default(null),
  generatedAtEpoch: z.number().int().nonnegative(),
  tokenBudget: z.number().int().positive().nullable().default(null),
  items: z.array(MemoryItemSchema).default([]),
  metadata: z.record(z.string(), z.unknown()).default({})
});

export type ContextPack = z.infer<typeof ContextPackSchema>;
