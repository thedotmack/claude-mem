import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { summarizeHandler } from '../../../src/cli/handlers/summarize.js';
import { hasInjected, markInjected } from '../../../src/shared/kimi-context-gate.js';

// Marker clearing must happen before any transcript/worker work: PreCompact
// means the next prompt re-injects even when there is nothing to summarize.
// Inputs below intentionally omit cwd/transcriptPath so the handler exits at
// its early guards — no worker traffic, no settings mocks needed.

describe('summarizeHandler — kimi context-gate clearing', () => {
  let dataDir: string;
  const origEnv = process.env.CLAUDE_MEM_DATA_DIR;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'kimi-gate-summarize-'));
    process.env.CLAUDE_MEM_DATA_DIR = dataDir;
  });

  afterEach(() => {
    if (origEnv === undefined) delete process.env.CLAUDE_MEM_DATA_DIR;
    else process.env.CLAUDE_MEM_DATA_DIR = origEnv;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('clears the injection marker on kimi PreCompact', async () => {
    markInjected('sess-kimi');
    const result = await summarizeHandler.execute({
      sessionId: 'sess-kimi',
      platform: 'kimi',
      hookEventName: 'PreCompact',
    });
    expect(result.continue).toBe(true);
    expect(hasInjected('sess-kimi')).toBe(false);
  });

  it('keeps the marker on kimi Stop (fires at the end of EVERY turn)', async () => {
    markInjected('sess-kimi-stop');
    const result = await summarizeHandler.execute({
      sessionId: 'sess-kimi-stop',
      platform: 'kimi',
      hookEventName: 'Stop',
    });
    expect(result.continue).toBe(true);
    expect(hasInjected('sess-kimi-stop')).toBe(true);
  });

  it('keeps the marker when the kimi payload carries no event name', async () => {
    markInjected('sess-kimi-legacy');
    const result = await summarizeHandler.execute({
      sessionId: 'sess-kimi-legacy',
      platform: 'kimi',
    });
    expect(result.continue).toBe(true);
    expect(hasInjected('sess-kimi-legacy')).toBe(true);
  });

  it('does not touch markers for non-kimi platforms', async () => {
    markInjected('sess-claude');
    const result = await summarizeHandler.execute({
      sessionId: 'sess-claude',
      platform: 'claude-code',
    });
    expect(result.continue).toBe(true);
    expect(hasInjected('sess-claude')).toBe(true);
  });
});
