/**
 * Classifies the post-kill port/process state observed by the ghost-listener
 * recovery gate into exactly one outcome.
 *
 * The gate may SKIP only for one state: the port is free AND the (pre-kill
 * verified) sidecar chain is still alive — the measured bun >= 1.4 signature,
 * where spawned children no longer inherit the listening socket. Every other
 * non-ghost state is malformed — the chain died with the worker, the port is
 * held by processes that are not the dead worker, a ghost shares the port, or
 * the fixture pid was recycled — and must FAIL the gate: skipping any of those
 * would pass without ever exercising the recovery the gate exists to test.
 *
 * Pure so the full state table is unit-testable; the environmental states are
 * not constructible on demand (they are exactly the anomalies being named).
 */

export type PostKillState =
  | { kind: 'ghost' }
  | { kind: 'runtime-capability-skip' }
  | {
      kind: 'malformed';
      reason: 'chain-died' | 'fixture-pid-recycled' | 'ghost-shared-port' | 'foreign-owner';
    };

export interface PostKillObservation {
  /** PID the fixture reported at spawn; dead by the time this is called. */
  fixturePid: number;
  /** Result of a fresh liveness probe of fixturePid (guards PID recycling). */
  fixtureAlive: boolean;
  /** PIDs currently holding the fixture port LISTENING, from the final sample. */
  portOwners: number[];
  /** Whether any pre-kill-snapshotted sidecar descendant is still alive. */
  chainSurvived: boolean;
}

export function classifyPostKillState(obs: PostKillObservation): PostKillState {
  const { fixturePid, fixtureAlive, portOwners, chainSurvived } = obs;

  // The ghost: the port is bound ONLY under the dead worker's pid.
  if (!fixtureAlive && portOwners.length > 0 && portOwners.every(pid => pid === fixturePid)) {
    return { kind: 'ghost' };
  }

  // The only skippable non-ghost state: no ghost can form because the runtime
  // no longer hands the socket to children — but the chain must have SURVIVED
  // the kill, which is what proves the release came from socket semantics and
  // not from the chain dying for its own reasons.
  if (portOwners.length === 0 && chainSurvived) {
    return { kind: 'runtime-capability-skip' };
  }

  if (portOwners.length === 0) {
    return { kind: 'malformed', reason: 'chain-died' };
  }
  if (portOwners.every(pid => pid === fixturePid)) {
    // Only reachable when fixtureAlive: the ghost condition above already
    // handled the dead-pid case, so this pid belongs to someone else now.
    return { kind: 'malformed', reason: 'fixture-pid-recycled' };
  }
  return portOwners.some(pid => pid === fixturePid)
    ? { kind: 'malformed', reason: 'ghost-shared-port' }
    : { kind: 'malformed', reason: 'foreign-owner' };
}
