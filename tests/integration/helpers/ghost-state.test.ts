/**
 * Truth table for classifyPostKillState (the ghost gate's skip guard).
 *
 * The environmental states it classifies cannot be produced on demand — they
 * are precisely the anomalies (a dead sidecar chain, a foreign port owner) the
 * gate must fail on instead of skipping — so the classification itself is pure
 * and its full table is asserted here.
 */

import { describe, expect, it } from 'bun:test';
import { classifyPostKillState } from './ghost-state.js';

// fixturePid=100, worker dead unless a case says otherwise.
const base = { fixturePid: 100, fixtureAlive: false, portOwners: [] as number[], chainSurvived: true };

describe('classifyPostKillState', () => {
  it('returns ghost when the port is bound only under the dead fixture pid', () => {
    // Scenario: the normal bun <= 1.3 shape. The chain's fate is irrelevant
    // here — the full recovery path asserts it separately.
    // Expected: ghost, with or without surviving sidecars.
    expect(classifyPostKillState({ ...base, portOwners: [100], chainSurvived: true })).toEqual({ kind: 'ghost' });
    expect(classifyPostKillState({ ...base, portOwners: [100], chainSurvived: false })).toEqual({ kind: 'ghost' });
  });

  it('skips only when the port is free AND the sidecar chain survived', () => {
    // Scenario: the measured bun >= 1.4 signature — the socket is released
    // with the worker while the chain lives on.
    // Expected: the one and only skippable state.
    expect(classifyPostKillState(base)).toEqual({ kind: 'runtime-capability-skip' });
  });

  it('fails on a free port when the sidecar chain died with the worker', () => {
    // Scenario: the chain is gone too, so a free port proves nothing about
    // socket inheritance — the scenario failed to form for unknown reasons.
    // Expected: malformed (chain-died), never a skip.
    expect(classifyPostKillState({ ...base, portOwners: [], chainSurvived: false })).toEqual({
      kind: 'malformed',
      reason: 'chain-died',
    });
  });

  it('fails when the dead fixture pid shares the port with other owners', () => {
    // Scenario: a ghost forms but something else also holds the port.
    // Expected: malformed (ghost-shared-port).
    expect(classifyPostKillState({ ...base, portOwners: [100, 200] })).toEqual({
      kind: 'malformed',
      reason: 'ghost-shared-port',
    });
  });

  it('fails when the port is held only by processes that are not the fixture', () => {
    // Scenario: an unrelated process (or another ghost) owns the port.
    // Expected: malformed (foreign-owner), for one or several foreign pids.
    expect(classifyPostKillState({ ...base, portOwners: [200] })).toEqual({
      kind: 'malformed',
      reason: 'foreign-owner',
    });
    expect(classifyPostKillState({ ...base, portOwners: [200, 300] })).toEqual({
      kind: 'malformed',
      reason: 'foreign-owner',
    });
  });

  it('fails when the port is under the fixture pid but that pid is alive', () => {
    // Scenario: the fixture pid was recycled by a new process after the kill.
    // Expected: malformed (fixture-pid-recycled), not a ghost.
    expect(classifyPostKillState({ ...base, fixtureAlive: true, portOwners: [100] })).toEqual({
      kind: 'malformed',
      reason: 'fixture-pid-recycled',
    });
  });
});
