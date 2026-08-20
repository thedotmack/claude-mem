// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'bun:test';
import { capSummaryInput } from '../../../src/server/generation/ProviderObservationGenerator.js';
import { eventBlockBytes } from '../../../src/server/generation/providers/shared/prompt-builder.js';
import type { PostgresAgentEvent } from '../../../src/storage/postgres/agent-events.js';

// listUnprocessedEvents caps the event COUNT, not the payload volume. Sessions
// whose events are large still overflow the provider window, which surfaces as
// an `unrecoverable` job and no summary at all. capSummaryInput bounds the
// input by size, keeping the head (goal) and the tail (outcome).
//
// The budget is measured with eventBlockBytes — the same function the prompt
// builder feeds — so these tests fail if the two ever disagree again.

const budget = () =>
  Number.parseInt(process.env.CLAUDE_MEM_SUMMARY_INPUT_BUDGET_BYTES ?? '', 10) || 600_000;

const eventOf = (id: number, payload: string): PostgresAgentEvent => ({
  id: `evt-${id}`,
  projectId: 'p',
  teamId: 't',
  serverSessionId: 's',
  sourceAdapter: 'hook',
  sourceEventId: null,
  idempotencyKey: `k-${id}`,
  eventType: 'tool_use',
  platformSource: 'claude',
  payload,
  metadata: {},
  occurredAtEpoch: 1_700_000_000_000 + id,
  receivedAtEpoch: 1_700_000_000_000 + id,
  createdAtEpoch: 1_700_000_000_000 + id,
});

const filler = (id: number, bytes: number) => eventOf(id, 'x'.repeat(bytes));
const sizeOf = (list: PostgresAgentEvent[]) =>
  list.reduce<number>((acc, e) => acc + eventBlockBytes(e), 0);

describe('capSummaryInput', () => {
  it('returns every event when the batch fits the budget', () => {
    const events = [filler(1, 10), filler(2, 10), filler(3, 10)];
    expect(capSummaryInput(events)).toEqual(events);
  });

  it('bounds an oversized batch to the byte budget', () => {
    const events = Array.from({ length: 400 }, (_, i) => filler(i, 5_000));
    expect(sizeOf(events)).toBeGreaterThan(budget());

    const capped = capSummaryInput(events);

    expect(capped.length).toBeLessThan(events.length);
    expect(sizeOf(capped)).toBeLessThanOrEqual(budget());
  });

  it('keeps both ends of the session, not just one', () => {
    const events = Array.from({ length: 400 }, (_, i) => filler(i, 5_000));
    const capped = capSummaryInput(events);

    // the opening carries the goal, the close carries the outcome
    expect(capped[0]?.id).toBe('evt-0');
    expect(capped[capped.length - 1]?.id).toBe('evt-399');
  });

  it('keeps an oversized single event instead of returning nothing', () => {
    // A 700 KB event exceeds both the head and the tail allowance. Measuring the
    // raw row would drop it and hand the provider an empty session, even though
    // the prompt truncates the payload to 16 KiB and it fits comfortably.
    const capped = capSummaryInput([filler(1, 700_000)]);
    expect(capped.length).toBe(1);
    expect(sizeOf(capped)).toBeLessThanOrEqual(budget());
  });

  it('measures UTF-8 bytes, not UTF-16 code units', () => {
    // 'é' is 1 UTF-16 unit but 2 UTF-8 bytes; a budget checked in .length would
    // let the real request exceed the limit and fail as context overflow.
    const capped = capSummaryInput([eventOf(1, 'é'.repeat(400_000))]);
    expect(sizeOf(capped)).toBeLessThanOrEqual(budget());
  });

  it('counts XML escaping and block overhead, not just the raw payload', () => {
    // Regression for the estimate this replaced: it measured the compact raw
    // payload, while the builder pretty-prints, escapes and wraps it. 100 events
    // of 3 KB of '<' weigh ~300 KB raw (under budget, so nothing was dropped)
    // and render past 1 MB once every '<' becomes '&lt;'.
    const events = Array.from({ length: 100 }, (_, i) => eventOf(i, '<'.repeat(3_000)));
    const rawBytes = events.reduce((acc, e) => acc + Buffer.byteLength(e.payload as string), 0);

    expect(rawBytes).toBeLessThan(budget());
    expect(sizeOf(events)).toBeGreaterThan(budget());

    expect(sizeOf(capSummaryInput(events))).toBeLessThanOrEqual(budget());
  });

  it('charges nothing for an event the builder drops', () => {
    // A payload that strips to blank produces no block at all, so it must not
    // consume budget the way the raw-row estimate made it.
    expect(eventBlockBytes(eventOf(1, '   '))).toBe(0);
  });

  it('preserves chronological order', () => {
    const events = Array.from({ length: 400 }, (_, i) => filler(i, 5_000));
    const stamps = capSummaryInput(events).map((e) => e.occurredAtEpoch);
    expect(stamps).toEqual([...stamps].sort((a, b) => a - b));
  });
});
