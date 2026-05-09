// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';

export const TeamRoleSchema = z.enum(['owner', 'admin', 'member', 'viewer']);

export const TeamSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  slug: z.string().min(1).nullable().default(null),
  metadata: z.record(z.string(), z.unknown()).default({}),
  createdAtEpoch: z.number().int().nonnegative(),
  updatedAtEpoch: z.number().int().nonnegative()
});

export const CreateTeamSchema = TeamSchema.omit({
  id: true,
  createdAtEpoch: true,
  updatedAtEpoch: true
}).partial({
  slug: true,
  metadata: true
});

export const TeamMemberSchema = z.object({
  id: z.string().min(1),
  teamId: z.string().min(1),
  userId: z.string().min(1),
  role: TeamRoleSchema,
  metadata: z.record(z.string(), z.unknown()).default({}),
  createdAtEpoch: z.number().int().nonnegative()
});

export const CreateTeamMemberSchema = TeamMemberSchema.omit({
  id: true,
  createdAtEpoch: true
}).partial({
  metadata: true
});

export type TeamRole = z.infer<typeof TeamRoleSchema>;
export type Team = z.infer<typeof TeamSchema>;
export type CreateTeam = z.infer<typeof CreateTeamSchema>;
export type TeamMember = z.infer<typeof TeamMemberSchema>;
export type CreateTeamMember = z.infer<typeof CreateTeamMemberSchema>;
