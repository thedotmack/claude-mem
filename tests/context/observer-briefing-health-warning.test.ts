import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { healthWarningForContext } from '../../src/services/context/ContextBuilder.js';

// The observer-health banner is written for the primary assistant and ends
// with an instruction to it. The context builder appended it to EVERY build,
// including the observer's own session-start briefing, so a model reading that
// briefing obeyed "tell the user about this outage", replied in prose, and the
// parser logged "non-XML prose response - ignoring queued batch" and called
// confirmClaimedMessages() - dropping the batch permanently. Because nothing
// parsed, lastSuccessAt never advanced and the banner stayed up, so the failure
// kept itself going after the original cause cleared (#4221).
const repoRoot = process.cwd();
const BANNER = "can't save memories";

let dataDir: string;
let healthPath: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'claude-mem-observer-briefing-'));
  healthPath = join(dataDir, 'observer-health.json');
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function unhealthyState() {
  return {
    consecutiveFailures: 3,
    failingSinceAt: 1_754_700_000_000,
    lastErrorAt: 1_754_700_100_000,
    lastErrorMessage: 'Key limit exceeded (monthly limit).',
    lastErrorProvider: 'openrouter',
    lastSuccessAt: null,
  };
}

interface ChildRender {
  primary: string;
  briefing: string;
  optedOut: string;
}

function runChild(): ChildRender {
  const result = Bun.spawnSync(['bun', '-e', `
    import { generateContext, healthWarningForContext } from './src/services/context/ContextBuilder.ts';
    import { ModeManager } from './src/services/domain/ModeManager.ts';
    ModeManager.getInstance().loadMode('code');
    const primary = await generateContext({ projects: ['observer-briefing-test'] });
    const briefing = await generateContext({ projects: ['observer-briefing-test'], includeHealthWarning: false });
    console.log(JSON.stringify({
      primary,
      briefing,
      optedOut: healthWarningForContext({ includeHealthWarning: false }, false),
    }));
  `], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CLAUDE_MEM_DATA_DIR: dataDir,
      CLAUDE_CONFIG_DIR: dataDir,
      CLAUDE_MEM_MODES_DIR: join(repoRoot, 'plugin', 'modes'),
    },
  });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
  return JSON.parse(new TextDecoder().decode(result.stdout).trim());
}

describe("observer session-start briefing and the health banner", () => {
  it('still shows the outage banner on the primary session context', () => {
    writeFileSync(healthPath, JSON.stringify(unhealthyState()));
    const { primary } = runChild();
    expect(primary).toContain(BANNER);
    expect(primary).toContain('openrouter');
  });

  it("withholds the banner from the observer's own briefing", () => {
    writeFileSync(healthPath, JSON.stringify(unhealthyState()));
    const { primary, briefing } = runChild();
    // Asserted in the same run: the observer is genuinely unhealthy here, so
    // the empty briefing below is the opt-out working and not a healthy ledger.
    expect(primary).toContain(BANNER);
    expect(briefing).not.toContain(BANNER);
    expect(briefing).not.toContain('tell the user');
    expect(briefing).toBe('');
  });

  it('reports no warning for an opted-out build without consulting the ledger', () => {
    expect(healthWarningForContext({ includeHealthWarning: false }, false)).toBe('');
    expect(healthWarningForContext({ includeHealthWarning: false }, true)).toBe('');
  });
});
