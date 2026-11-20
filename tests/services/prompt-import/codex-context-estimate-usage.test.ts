import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { scanTokenUsage } from '../../../src/services/prompt-import/token-usage.js';

const NOW = Date.now();
const SINCE = NOW - 30 * 86_400_000;
let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'codex-context-usage-')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

// Native TokenUsageInfo shapes from Codex rust-v0.167.1 (0a94398fa60c4fac0e7659e4213a0a36e613dd46):
// protocol.rs::fill_to_context_window clears the usage fields and fills only
// total_tokens; session/mod.rs::recompute_token_usage sets the same shape on
// last_token_usage. Neither reports an API call's input/output usage.
const usage = (input: number, output: number, total = input + output, cached = 0, reasoning = 0) => ({
  input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0,
  output_tokens: output, reasoning_output_tokens: reasoning, total_tokens: total,
});
const count = (total: unknown, last: unknown, at = NOW) => ({
  timestamp: new Date(at).toISOString(), type: 'event_msg', payload: {
    type: 'token_count', info: { total_token_usage: total, last_token_usage: last, model_context_window: 262144 },
    rate_limits: null,
  },
});

async function scan(records: unknown[]) {
  const file = join(home, '.codex/sessions/2026/11/11/rollout.jsonl');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, records.map(record => JSON.stringify(record)).join('\n') + '\n');
  return (await scanTokenUsage({ homeDirectory: home, sinceEpochMs: SINCE, agents: ['codex'] })).agents[0];
}

describe('Codex setup usage excludes synthetic context totals', () => {
  it('does not charge a context-window error and still counts the next real response', async () => {
    const initial = usage(900, 100);
    const full = usage(0, 0, 262144);
    const fillDelta = usage(0, 0, 262144 - 1000);
    const afterFill = usage(50, 10, 262144 + 60);
    expect(await scan([
      count(initial, initial),
      count(full, fillDelta),
      count(full, fillDelta), // repeated rate-limit notification
      count(afterFill, usage(50, 10)),
      count(afterFill, usage(50, 10)),
    ])).toMatchObject({ tokens: 1060, skippedSources: 0 });
  });

  it('does not charge a first recomputed history estimate before real usage', async () => {
    expect(await scan([
      count(usage(0, 0), usage(0, 0, 32000)),
      count(usage(80, 20), usage(80, 20)),
    ])).toMatchObject({ tokens: 100, skippedSources: 0 });
  });

  it('reports zero spent tokens for a file containing only full-window or history estimates', async () => {
    expect(await scan([
      count(usage(0, 0), usage(0, 0, 32000)),
      count(usage(0, 0, 262144), usage(0, 0, 262144)),
    ])).toMatchObject({ tokens: 0, skippedSources: 0 });
  });

  it('retains the scan-window boundary across a synthetic counter reset', async () => {
    expect(await scan([
      count(usage(900, 100), usage(900, 100), SINCE - 1),
      count(usage(0, 0, 262144), usage(0, 0, 261144)),
      count(usage(50, 10, 262204), usage(50, 10)),
    ])).toMatchObject({ tokens: 60, skippedSources: 0 });
  });

  it('keeps real usage when a later context window is smaller than the previous counter', async () => {
    expect(await scan([
      count(usage(19000, 1000), usage(19000, 1000)),
      count(usage(0, 0, 10000), usage(0, 0)),
      count(usage(150, 50, 10200), usage(150, 50)),
    ])).toMatchObject({ tokens: 20200, skippedSources: 0 });
  });

  it('counts cached input and reasoning output once as subsets of input/output', async () => {
    expect(await scan([
      count(usage(100, 20, 120, 90, 10), usage(100, 20, 120, 90, 10)),
      count(usage(150, 30, 180, 120, 15), usage(50, 10, 60, 30, 5)),
    ])).toMatchObject({ tokens: 180, skippedSources: 0 });
  });

  it('retains the existing interpretation of legacy records with only totals', async () => {
    expect(await scan([
      count({ total_tokens: 300 }, { total_tokens: 200 }),
      count({ total_tokens: 300 }, { total_tokens: 200 }),
      count({ total_tokens: 350 }, { total_tokens: 50 }),
    ])).toMatchObject({ tokens: 250, skippedSources: 0 });
  });
});
