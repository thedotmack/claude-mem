// SPDX-License-Identifier: Apache-2.0
//
// The parent measures the deep-search budget with performance.now() and hands
// the child a wall-clock deadline taken from the remaining budget at dispatch.
// The child reads the wall clock once, on receipt, and measures the rest with
// the monotonic clock.

import { describe, expect, it } from 'bun:test';
import { childDeadline } from '../../src/services/deep-search/DeepSearchClient.js';
import { childExpired } from '../../src/services/deep-search/protocol.js';

describe('childDeadline', () => {
  it('hands the child the remaining budget from the dispatch moment', () => {
    expect(childDeadline(5_000, 1_000, 1_000_000)).toBe(1_004_000);
  });

  it('never hands the child a dead or negative window', () => {
    expect(childDeadline(5_000, 9_000, 1_000_000)).toBe(1_000_001);
  });
});
describe('childExpired', () => {
  const deadline = 1_004_000; // 4 s after the request arrived at wall 1_000_000
  const receivedWallMs = 1_000_000;
  const receivedMonoMs = 50;

  it('ignores a forward wall-clock jump after receipt', () => {
    // The wall clock jumped 60 s, but only 100 ms really passed.
    const wallNowAfterJump = receivedWallMs + 60_000 + 100;
    expect(wallNowAfterJump >= deadline).toBe(true); // what a Date.now() check would report
    expect(childExpired(deadline, receivedWallMs, receivedMonoMs, receivedMonoMs + 100)).toBe(false);
  });

  it('expires once the remaining budget has really passed', () => {
    expect(childExpired(deadline, receivedWallMs, receivedMonoMs, receivedMonoMs + 3_999)).toBe(false);
    expect(childExpired(deadline, receivedWallMs, receivedMonoMs, receivedMonoMs + 4_000)).toBe(true);
  });

  it('treats a request that arrived past its deadline as expired', () => {
    expect(childExpired(deadline, deadline + 10, receivedMonoMs, receivedMonoMs)).toBe(true);
  });
});
