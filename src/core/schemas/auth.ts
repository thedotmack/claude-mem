// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';

export const ApiKeyStatusSchema = z.enum(['active', 'revoked']);
export const AuditActorTypeSchema = z.enum(['user', 'api_key', 'system']);

export const ApiKeySchema = z.object({
  id: z.string().min(1),
  teamId: z.string().min(1).nullable().default(null),
  projectId: z.string().min(1).nullable().default(null),
  name: z.string().min(1),
  keyHash: z.string().min(1),
  prefix: z.string().min(1).nullable().default(null),
  scopes: z.array(z.string()).default([]),
  status: ApiKeyStatusSchema.default('active'),
  lastUsedAtEpoch: z.number().int().nonnegative().nullable().default(null),
  expiresAtEpoch: z.number().int().nonnegative().nullable().default(null),
  metadata: z.record(z.string(), z.unknown()).default({}),
  createdAtEpoch: z.number().int().nonnegative(),
  updatedAtEpoch: z.number().int().nonnegative()
});

export const CreateApiKeySchema = ApiKeySchema.omit({
  id: true,
  status: true,
  lastUsedAtEpoch: true,
  createdAtEpoch: true,
  updatedAtEpoch: true
}).partial({
  teamId: true,
  projectId: true,
  prefix: true,
  scopes: true,
  expiresAtEpoch: true,
  metadata: true
});

export const AuditLogSchema = z.object({
  id: z.string().min(1),
  teamId: z.string().min(1).nullable().default(null),
  projectId: z.string().min(1).nullable().default(null),
  actorType: AuditActorTypeSchema,
  actorId: z.string().min(1).nullable().default(null),
  action: z.string().min(1),
  targetType: z.string().min(1).nullable().default(null),
  targetId: z.string().min(1).nullable().default(null),
  metadata: z.record(z.string(), z.unknown()).default({}),
  createdAtEpoch: z.number().int().nonnegative()
});

export const CreateAuditLogSchema = AuditLogSchema.omit({
  id: true,
  createdAtEpoch: true
}).partial({
  teamId: true,
  projectId: true,
  actorId: true,
  targetType: true,
  targetId: true,
  metadata: true
});

export type ApiKeyStatus = z.infer<typeof ApiKeyStatusSchema>;
export type ApiKey = z.infer<typeof ApiKeySchema>;
export type CreateApiKey = z.infer<typeof CreateApiKeySchema>;
export type AuditActorType = z.infer<typeof AuditActorTypeSchema>;
export type AuditLog = z.infer<typeof AuditLogSchema>;
export type CreateAuditLog = z.infer<typeof CreateAuditLogSchema>;
