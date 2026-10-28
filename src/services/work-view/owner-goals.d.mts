export const OWNER_GOALS_LIST: 'owner-goals';
export type GoalKind = 'focus-area' | 'ask';
export const GOAL_KINDS: GoalKind[];
export function isOwnerGoalsList(name: unknown): boolean;
export function goalKindOf(fields: Record<string, unknown>): { kind: GoalKind; legacy: boolean };
