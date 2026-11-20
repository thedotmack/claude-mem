// What the "Just changed" ticker shows (components/live-motion.tsx ChangeTicker), from the feed's connection and the
// changes the screen saw. Pure, with .ts imports, so `node --test` loads it.
import type { ConnectionState, ConnectionStatus } from './connection-status.ts'

/**
 * The ticker's states (c-live-motion-change-ticker): connecting before the feed is first live; quiet or showing its
 * changes while live; the stream down or silent; or messages arriving while the saved work they report is not
 * current. The one definition; ChangeTicker words and marks each in a Record. Its one writer is tickerState. Moves:
 *
 *   connecting ──the feed goes live──▶ quiet | changes
 *   quiet ──a change arrives──▶ changes
 *   quiet | changes ──the stream drops, or no message arrives in time──▶ stream-down ──live again──▶ quiet | changes
 *   quiet | changes ──messages arrive, the saved work is not current──▶ source-behind ──live again──▶ quiet | changes
 */
export const TICKER_STATES = ['connecting', 'quiet', 'changes', 'stream-down', 'source-behind'] as const
export type TickerState = (typeof TICKER_STATES)[number]

/**
 * Whether Reconnect, which reads the page again over a new stream, can help: only when the stream itself is down or
 * silent. While a first connection is under way, or while messages arrive and the saved work behind them is not
 * current, a reload changes nothing (the Live chip names that problem).
 */
export const TICKER_OFFERS_RECONNECT: Record<TickerState, boolean> = {
  connecting: false,
  quiet: false,
  changes: false,
  'stream-down': true,
  'source-behind': false,
}

/**
 * How long each change stays in the ticker before the next one slides in: a change line holds a verb, a title of up to
 * about a dozen words and its age, some 16 words, which read in 4 s at the 238 words a minute adults read silently
 * (Brysbaert 2019, Journal of Memory and Language 109); the other half second covers the 0.4 s slide.
 */
export const TICKER_STEP_MS = 4500

type TickerConnection = Pick<ConnectionStatus, 'state' | 'eventAgeMs' | 'staleAfterMs'>

/**
 * The ticker's state for each feed state that is not live (connection-status.ts). Keyed by every such state, so a new
 * one fails the typecheck here until the ticker knows what it means. A stale feed with no message in time is the
 * stream's silence; a stale or unavailable one whose messages still arrive is the saved work falling behind.
 */
const NOT_LIVE: Record<Exclude<ConnectionState, 'live'>, (connection: TickerConnection) => TickerState> = {
  connecting: () => 'connecting',
  reconnecting: () => 'stream-down',
  stale: (connection) => connection.eventAgeMs === null || connection.eventAgeMs > connection.staleAfterMs ? 'stream-down' : 'source-behind',
  unavailable: () => 'source-behind',
}

/** What the ticker shows. The sample is always live (its changes are a demonstration). */
export function tickerState(connection: TickerConnection | null, sample: boolean, changesSeen: number): TickerState {
  const live: TickerState = changesSeen > 0 ? 'changes' : 'quiet'
  if (sample) return live
  if (!connection) return 'connecting'
  const state = connection.state
  return state === 'live' ? live : NOT_LIVE[state](connection)
}
