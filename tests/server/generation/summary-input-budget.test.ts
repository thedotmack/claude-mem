// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'bun:test';
import { capSummaryInput } from '../../../src/server/generation/ProviderObservationGenerator.js';

// listUnprocessedEvents caps the event COUNT, not the payload volume. Sessions
// whose events are large still overflow the provider window, which surfaces as
// an `unrecoverable` job and no summary at all. capSummaryInput bounds the
// input by size, keeping the head (goal) and the tail (outcome).

const budget = () =>
  Number.parseInt(process.env.CLAUDE_MEM_SUMMARY_INPUT_BUDGET_BYTES ?? '', 10) || 600_000;

const eventOf = (id: number, bytes: number) => ({ id, blob: 'x'.repeat(bytes) });
const sizeOf = (list: unknown[]) =>
  list.reduce<number>((acc, e) => acc + JSON.stringify(e).length, 0);

describe('capSummaryInput', () => {
  it('returns every event when the batch fits the budget', () => {
    const events = [eventOf(1, 10), eventOf(2, 10), eventOf(3, 10)];
    expect(capSummaryInput(events)).toEqual(events);
  });

  it('bounds an oversized batch to the byte budget', () => {
    const events = Array.from({ length: 400 }, (_, i) => eventOf(i, 5_000));
    expect(sizeOf(events)).toBeGreaterThan(budget());

    const capped = capSummaryInput(events);

    expect(capped.length).toBeLessThan(events.length);
    expect(sizeOf(capped)).toBeLessThanOrEqual(budget());
  });

  it('keeps both ends of the session, not just one', () => {
    const events = Array.from({ length: 400 }, (_, i) => eventOf(i, 5_000));
    const capped = capSummaryInput(events);

    // the opening carries the goal, the close carries the outcome
    expect(capped[0]?.id).toBe(0);
    expect(capped[capped.length - 1]?.id).toBe(399);
  });

  it('preserves chronological order', () => {
    const events = Array.from({ length: 400 }, (_, i) => eventOf(i, 5_000));
    const ids = capSummaryInput(events).map((e) => e.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
  });
});
