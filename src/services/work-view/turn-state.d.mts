export const TURN_REASONS: readonly ['turn-ended', 'question-pending', 'owner-spoke', 'tool-running'];
export type TurnReason = (typeof TURN_REASONS)[number];
export const TURN_PLATFORMS: readonly ['claude', 'codex'];
export type TurnPlatform = (typeof TURN_PLATFORMS)[number];
/** Who holds the next move, why, and when the deciding record was written (null when it carries no time). */
export type TurnState =
  | { state: 'owner-turn'; reason: Extract<TurnReason, 'turn-ended' | 'question-pending'>; atEpoch: number | null }
  | { state: 'agent-turn'; reason: Extract<TurnReason, 'owner-spoke' | 'tool-running'>; atEpoch: number | null };
export type TurnHolder = TurnState['state'];
export function turnStateFromTail(platform: string, tail: string): TurnState | null;
