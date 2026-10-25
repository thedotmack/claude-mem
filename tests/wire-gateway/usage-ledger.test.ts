import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { join } from 'path';
import { WIRE_GATEWAY_DIR } from '../../src/shared/paths.js';
import {
  WireUsageLedger,
  WireUsageLedgerReader,
  parseUsageLedgerLine,
  retainedUsageLedgerDays,
  type WireUsageLedgerRecord,
} from '../../src/services/wire-gateway/metrics/usage-ledger.js';

// Phase 10 task 6: the usage ledger keeps whole UTC days as long as
// recordings, so it never grows without bound.

const usageDirectory = join(WIRE_GATEWAY_DIR, 'usage-ledger-test');
const DAY_MS = 24 * 60 * 60 * 1000;
const now = Date.parse('2026-10-15T12:00:00.000Z');

function recordAt(t: string): WireUsageLedgerRecord {
  return {
    t, agent: 'claude-code', session: 's', routeId: 'r', model: 'm', status: 200,
    in: 1, out: 1, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, reasoning: 0,
    ms: 5, ttftMs: 1, kind: 'turn', stages: [], injectedTokensEst: 0, culledTokensEst: 0,
  };
}

beforeEach(() => rmSync(usageDirectory, { recursive: true, force: true }));
afterEach(() => rmSync(usageDirectory, { recursive: true, force: true }));

describe('usage ledger retention', () => {
  it('deletes day files wholly past the retention and keeps the rest', () => {
    mkdirSync(usageDirectory, { recursive: true });
    for (const day of ['2026-10-07', '2026-10-08', '2026-10-15', 'notes']) writeFileSync(join(usageDirectory, `${day}.jsonl`), '');
    const ledger = new WireUsageLedger({ directory: usageDirectory, retentionDays: 7, now: () => now });
    expect(ledger.pruneExpired()).toBe(1);
    expect(readdirSync(usageDirectory).sort()).toEqual(['2026-10-08.jsonl', '2026-10-15.jsonl', 'notes.jsonl']);
  });

  it('prunes when a new UTC day is begun, and still writes the line', () => {
    let clock = now;
    const ledger = new WireUsageLedger({ directory: usageDirectory, retentionDays: 1, now: () => clock });
    ledger.append(recordAt(new Date(clock).toISOString()));
    clock += 3 * DAY_MS;
    ledger.append(recordAt(new Date(clock).toISOString()));
    expect(existsSync(join(usageDirectory, '2026-10-15.jsonl'))).toBe(false);
    expect(ledger.read().map(record => record.t)).toEqual([new Date(clock).toISOString()]);
  });
});

describe('usage ledger lines', () => {
  it('takes a line only when it is a record: valid JSON of another shape is not one', () => {
    const line = JSON.stringify(recordAt('2026-10-15T10:00:00.000Z'));
    expect(parseUsageLedgerLine(line)).toEqual(recordAt('2026-10-15T10:00:00.000Z'));
    for (const wrong of ['null', '7', '"text"', '[]', '{}', JSON.stringify({ ...recordAt('2026-10-15T10:00:00.000Z'), in: 'many' }), '{"t":', 'not json']) {
      expect(parseUsageLedgerLine(wrong)).toBeNull();
    }
  });

  it('still reads a line written before Endless Mode v2, with its replayed swappedTokensEst read as 0 culled tokens', () => {
    const { culledTokensEst: _culledTokensEst, ...withoutCulled } = recordAt('2026-10-15T10:00:00.000Z');
    expect(parseUsageLedgerLine(JSON.stringify({ ...withoutCulled, swappedTokensEst: 5000 }))).toEqual(recordAt('2026-10-15T10:00:00.000Z'));
  });

  it('read() skips lines that are not records instead of returning them', () => {
    mkdirSync(usageDirectory, { recursive: true });
    writeFileSync(join(usageDirectory, '2026-10-15.jsonl'), `null\n${JSON.stringify(recordAt('2026-10-15T10:00:00.000Z'))}\n{"agent":1}\n`);
    const ledger = new WireUsageLedger({ directory: usageDirectory, retentionDays: 7, now: () => now });
    expect(ledger.read()).toEqual([recordAt('2026-10-15T10:00:00.000Z')]);
  });
});

describe('the viewer\'s ledger reader', () => {
  const line = (t: string) => `${JSON.stringify(recordAt(t))}\n`;

  it('keeps the days pruneExpired keeps, and no others', () => {
    expect([...retainedUsageLedgerDays(1, now)].sort()).toEqual(['2026-10-14', '2026-10-15']);
    expect(retainedUsageLedgerDays(7, now).has('2026-10-08')).toBe(true);
    expect(retainedUsageLedgerDays(7, now).has('2026-10-07')).toBe(false);
    // Same rule as pruneExpired: 2026-10-07 is deleted there with 7 days kept.
    mkdirSync(usageDirectory, { recursive: true });
    for (const day of ['2026-10-07', '2026-10-08']) writeFileSync(join(usageDirectory, `${day}.jsonl`), '');
    new WireUsageLedger({ directory: usageDirectory, retentionDays: 7, now: () => now }).pruneExpired();
    expect(readdirSync(usageDirectory)).toEqual(['2026-10-08.jsonl']);
  });

  it('counts only the retained days (a gateway that is down has pruned nothing) and counts lines that are not records', async () => {
    mkdirSync(usageDirectory, { recursive: true });
    writeFileSync(join(usageDirectory, '2026-09-01.jsonl'), line('2026-09-01T10:00:00.000Z'));
    writeFileSync(join(usageDirectory, '2026-10-15.jsonl'), `${line('2026-10-15T10:00:00.000Z')}null\nnot json\n`);
    const result = await new WireUsageLedgerReader({ directory: usageDirectory, now: () => now }).readRetained(7);
    expect(result.records.map(record => record.t)).toEqual(['2026-10-15T10:00:00.000Z']);
    expect(result.unreadableLines).toBe(2);
  });

  it('does not read an unchanged file again, reads only what was appended, and waits for a line still being written', async () => {
    mkdirSync(usageDirectory, { recursive: true });
    const filePath = join(usageDirectory, '2026-10-15.jsonl');
    // A whole-second mtime, so it can be set back exactly (a Date or float seconds drops sub-millisecond precision).
    const wholeSecondMtime = 1_760_000_000;
    writeFileSync(filePath, line('2026-10-15T10:00:00.000Z'));
    utimesSync(filePath, wholeSecondMtime, wholeSecondMtime);
    const reader = new WireUsageLedgerReader({ directory: usageDirectory, now: () => now });
    expect((await reader.readRetained(7)).records).toHaveLength(1);

    // Same size and mtime, other bytes: the cached day stands (it was not read again).
    writeFileSync(filePath, line('2026-10-15T10:00:01.000Z'));
    utimesSync(filePath, wholeSecondMtime, wholeSecondMtime);
    expect((await reader.readRetained(7)).records.map(record => record.t)).toEqual(['2026-10-15T10:00:00.000Z']);

    // Appended: the new line joins the cached ones; half a line is not counted, not even as unreadable.
    const half = line('2026-10-15T10:00:03.000Z');
    appendFileSync(filePath, line('2026-10-15T10:00:02.000Z') + half.slice(0, 20));
    const appended = await reader.readRetained(7);
    expect(appended.records.map(record => record.t)).toEqual(['2026-10-15T10:00:00.000Z', '2026-10-15T10:00:02.000Z']);
    expect(appended.unreadableLines).toBe(0);
    appendFileSync(filePath, half.slice(20));
    expect((await reader.readRetained(7)).records.map(record => record.t)).toEqual(['2026-10-15T10:00:00.000Z', '2026-10-15T10:00:02.000Z', '2026-10-15T10:00:03.000Z']);

    // Rewritten shorter: read whole again.
    writeFileSync(filePath, line('2026-10-15T11:00:00.000Z').slice(0, -1) + '\n');
    expect((await reader.readRetained(7)).records.map(record => record.t)).toEqual(['2026-10-15T11:00:00.000Z']);
  });
});
