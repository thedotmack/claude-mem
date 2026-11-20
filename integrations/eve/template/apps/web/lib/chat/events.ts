import { endsTurn, type SessionStreamEvent } from "eve/client";

/**
 * Whether a read of the session's stream stops at `event`: the turn settled, the session ended,
 * or the turn paused for a person, such as a sign-in.
 */
export function isChatTurnSettledEvent(event: SessionStreamEvent) {
  return endsTurn(event);
}
