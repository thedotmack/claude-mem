import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { scanTokenUsage, summarizeTokenUsage } from '../../../src/services/prompt-import/token-usage.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-01T00:00:00Z');
const SINCE = NOW - 30 * DAY;
const OBSERVER_CWD = '/home/test/.claude-mem/observer-sessions';
const OBSERVER_PROJECT = '-home-test--claude-mem-observer-sessions';
let home: string;

function transcript(relativePath: string, id: string, at: number, mtime = NOW): void {
  const path = join(home, '.claude/projects', relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({
    type: 'assistant', timestamp: new Date(at).toISOString(),
    message: { id, usage: { input_tokens: 90, output_tokens: 10 } },
  }) + '\n');
  utimesSync(path, mtime / 1000, mtime / 1000);
}

function setup(): void {
  home = mkdtempSync(join(tmpdir(), 'cm-usage-coverage-'));
  transcript('-home-test-app/current.jsonl', 'personal-current', NOW - DAY);
}

async function scan(excludedClaudeCwds = [OBSERVER_CWD]) {
  return scanTokenUsage({ homeDirectory: home, agents: ['claude-code'], sinceEpochMs: SINCE, excludedClaudeCwds });
}

afterEach(() => { if (home) rmSync(home, { recursive: true, force: true }); });

describe('token coverage uses the same source exclusions as token counts', () => {
  for (const file of ['old.jsonl', 'old/subagents/agent-old.jsonl']) {
    it(`does not use an excluded old observer transcript to complete the window: ${file}`, async () => {
      setup();
      transcript(`${OBSERVER_PROJECT}/${file}`, 'observer-old', SINCE - DAY, SINCE - DAY);
      const usage = await scan();
      expect(usage.agents[0]).toMatchObject({
        tokens: 100, historyStartsBeforeWindow: false, firstRecordAt: new Date(NOW - DAY).toISOString(),
      });
      expect(summarizeTokenUsage(usage, null)).toMatchObject({ coverage: 'partial', persona: null });
    });
  }

  it('keeps excluded history out when its file was modified inside the window', async () => {
    setup();
    transcript(`${OBSERVER_PROJECT}/rewritten.jsonl`, 'observer-rewritten', SINCE - DAY);
    const usage = await scan();
    expect(usage.agents[0]).toMatchObject({ tokens: 100, historyStartsBeforeWindow: false });
    expect(summarizeTokenUsage(usage, null)).toMatchObject({ coverage: 'partial', persona: null });
  });

  it('still recognizes old personal transcripts as evidence of a complete window', async () => {
    setup();
    transcript('-home-test-app/old.jsonl', 'personal-old', SINCE - DAY, SINCE - DAY);
    const usage = await scan();
    expect(usage.agents[0]).toMatchObject({ tokens: 100, historyStartsBeforeWindow: true });
    expect(summarizeTokenUsage(usage, null)).toMatchObject({ coverage: 'complete', persona: 'Light AI User' });
  });

  it('honors an explicitly empty exclusion list for old history', async () => {
    setup();
    transcript(`${OBSERVER_PROJECT}/old.jsonl`, 'included-old', SINCE - DAY, SINCE - DAY);
    const usage = await scan([]);
    expect(usage.agents[0]).toMatchObject({ tokens: 100, historyStartsBeforeWindow: true });
    expect(summarizeTokenUsage(usage, null).coverage).toBe('complete');
  });
});
