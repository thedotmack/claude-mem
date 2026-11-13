export const HUMAN_NEEDS: readonly ['answer', 'review', 'approval'];
export type HumanNeed = (typeof HUMAN_NEEDS)[number];
export const WAITING_FOR: readonly [...typeof HUMAN_NEEDS, 'nothing'];
export type WaitingFor = (typeof WAITING_FOR)[number];
export function parseWaitingFor(text: unknown): WaitingFor | null;
export function waitingForTurn(input: {
  turnEndedAtEpoch: number | null;
  lastOwnerPromptEpoch: number | null;
  summary: { waitingFor: unknown; createdAtEpoch: number | null } | null;
}): WaitingFor | null;
