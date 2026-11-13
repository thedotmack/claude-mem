export const WAITING_FOR: readonly ['answer', 'review', 'approval', 'nothing'];
export type WaitingFor = (typeof WAITING_FOR)[number];
export function parseWaitingFor(text: unknown): WaitingFor | null;
