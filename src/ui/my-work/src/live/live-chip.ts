// The header's Live chip (c-bits-live-indicator): one chip that says "Live" when all is well and otherwise names the
// one problem that most needs the person. Its popover shows all three facts (this computer, the cloud copy, sharing).
import type { ConnectionState, ConnectionStatus } from './connection-status.ts'

/** What the chip reads from presentSharedState (live/shared-state-presentation.ts). */
interface SharingPresentation { attention: boolean }

/**
 * The problems the chip can name, most important first: it names the first one that applies, and says "Live" when
 * none does. The page's own feed comes first, because without it nothing on screen is current; then shared changes
 * that were refused, which the person has to fix; then the cloud copy falling behind. A first connection counts too,
 * so the chip never says "Live" before the feed is. States the person need not act on (cloud freshness not reported
 * yet, cloud sync off) are not problems; the popover still shows them.
 *
 * Moves: the chip has no writer of its own. Each render reads the connection and sharing state again, so whichever
 * problem applies at that moment is the one shown.
 */
export const LIVE_CHIP_PROBLEMS = ['feed-unavailable', 'feed-stale', 'feed-reconnecting', 'feed-connecting', 'sharing-refused', 'cloud-behind'] as const
export type LiveChipProblem = (typeof LIVE_CHIP_PROBLEMS)[number]

/**
 * The problem each feed state that is not live names. Keyed by every such state of connection-status.ts, so a new
 * state fails the typecheck here until it names one, and the chip never says "Live" for a feed that is not.
 */
const FEED_PROBLEM: Record<Exclude<ConnectionState, 'live'>, LiveChipProblem> = {
  unavailable: 'feed-unavailable',
  stale: 'feed-stale',
  reconnecting: 'feed-reconnecting',
  connecting: 'feed-connecting',
}
const feedProblem = (connection: ConnectionStatus): LiveChipProblem | null => connection.state === 'live' ? null : FEED_PROBLEM[connection.state]

const APPLIES: Record<LiveChipProblem, (connection: ConnectionStatus, sharing: SharingPresentation | null) => boolean> = {
  'feed-unavailable': (connection) => feedProblem(connection) === 'feed-unavailable',
  'feed-stale': (connection) => feedProblem(connection) === 'feed-stale',
  'feed-reconnecting': (connection) => feedProblem(connection) === 'feed-reconnecting',
  'feed-connecting': (connection) => feedProblem(connection) === 'feed-connecting',
  'sharing-refused': (_connection, sharing) => sharing?.attention === true,
  'cloud-behind': (connection) => connection.sync?.tone === 'warning',
}

/** The one problem the chip names right now, or null when it can say "Live". */
export function liveChipProblem(connection: ConnectionStatus, sharing: SharingPresentation | null): LiveChipProblem | null {
  return LIVE_CHIP_PROBLEMS.find((problem) => APPLIES[problem](connection, sharing)) ?? null
}

/** Where a problem comes from: the page's feed, or the cloud and sharing state beside a feed that is live. */
export const LIVE_CHIP_PROBLEM_SOURCE: Record<LiveChipProblem, 'feed' | 'sharing' | 'cloud'> = {
  'feed-unavailable': 'feed',
  'feed-stale': 'feed',
  'feed-reconnecting': 'feed',
  'feed-connecting': 'feed',
  'sharing-refused': 'sharing',
  'cloud-behind': 'cloud',
}
