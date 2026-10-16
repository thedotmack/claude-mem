import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { WIRE_GATEWAY_DIR } from '../../src/shared/paths.js';
import { WireUsageLedger, type WireUsageLedgerRecord } from '../../src/services/wire-gateway/metrics/usage-ledger.js';

// Phase 10 task 6: the usage ledger keeps whole UTC days as long as
// recordings, so it never grows without bound.

const usageDirectory = join(WIRE_GATEWAY_DIR, 'usage-ledger-test');
const DAY_MS = 24 * 60 * 60 * 1000;
const now = Date.parse('2026-10-15T12:00:00.000Z');

function recordAt(t: string): WireUsageLedgerRecord {
  return {
    t, agent: 'claude-code', session: 's', routeId: 'r', model: 'm', status: 200,
    in: 1, out: 1, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, reasoning: 0,
    ms: 5, ttftMs: 1, kind: 'turn', stages: [], injectedTokensEst: 0, swappedTokensEst: 0,
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
