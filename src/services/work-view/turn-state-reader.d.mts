import type { TurnState } from './turn-state.mjs';
export const TRANSCRIPT_TAIL_BYTES: number;
export class TurnStateReader {
  constructor(options?: { claudeProjectsDir?: string; codexHome?: string });
  read(platform: string, sessionId: string, options?: { deadline?: number }): TurnState | null;
  readConversation(conversationKey: string | null | undefined, options?: { deadline?: number }): TurnState | null;
}
