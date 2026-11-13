import type { WaitingFor } from './waiting-for.mjs';

export const TURN_REASONS: readonly ['turn-ended', 'question-pending', 'owner-spoke', 'tool-running', 'archived'];
export type TurnReason = (typeof TURN_REASONS)[number];
export const TURN_PLATFORMS: readonly ['claude', 'codex'];
export type TurnPlatform = (typeof TURN_PLATFORMS)[number];
/** Who holds the next move, why, and when the deciding record was written (null when it carries no time). The
 * transcript never says what an ended turn waits for: the snapshot adds `waitingFor` when the session summary written
 * for that turn recorded it (data-source.mjs). A chat its tool archived is `closed`: nobody holds a move in it. */
export type TurnState =
  | { state: 'owner-turn'; reason: 'turn-ended'; atEpoch: number | null; waitingFor?: WaitingFor }
  | { state: 'owner-turn'; reason: 'question-pending'; atEpoch: number | null }
  | { state: 'agent-turn'; reason: Extract<TurnReason, 'owner-spoke' | 'tool-running'>; atEpoch: number | null }
  | { state: 'closed'; reason: 'archived'; atEpoch: number | null };
export type TurnHolder = TurnState['state'];
export function turnStateFromTail(platform: string, tail: string): TurnState | null;
export function closedTurn(last: TurnState | null): Extract<TurnState, { state: 'closed' }>;
