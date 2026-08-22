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

  it('clears the injection marker for kimi sessions (PreCompact/Stop)', async () => {
    markInjected('sess-kimi');
    const result = await summarizeHandler.execute({
      sessionId: 'sess-kimi',
      platform: 'kimi',
    });
    expect(result.continue).toBe(true);
    expect(hasInjected('sess-kimi')).toBe(false);
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
