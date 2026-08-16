import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  readObserverHealth,
  recordObserverFailure,
  recordObserverSuccess,
  isObserverUnhealthy,
  renderObserverHealthWarning,
  describeDuration,
  scrubErrorMessage,
  OBSERVER_UNHEALTHY_FAILURE_THRESHOLD,
  type ObserverHealthState,
} from '../src/shared/observer-health.ts';

const repoRoot = process.cwd();

let dataDir: string;
let healthPath: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'claude-mem-observer-health-'));
  healthPath = join(dataDir, 'observer-health.json');
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function unhealthyState(overrides: Partial<ObserverHealthState> = {}): ObserverHealthState {
  return {
    consecutiveFailures: OBSERVER_UNHEALTHY_FAILURE_THRESHOLD,
    failingSinceAt: 1_754_700_000_000,
    lastErrorAt: 1_754_700_100_000,
    lastErrorMessage: 'Key limit exceeded (monthly limit). Manage it using https://openrouter.ai/keys/abc',
    lastErrorProvider: 'openrouter',
    lastSuccessAt: 1_754_600_000_000,
    ...overrides,
  };
}

describe('observer-health ledger', () => {
  it('returns null when no health file exists', () => {
    expect(readObserverHealth(healthPath)).toBeNull();
  });

  it('records a failure streak: increments count, pins failingSinceAt to the first failure', () => {
    recordObserverFailure('openrouter', 'boom one', healthPath);
    const first = readObserverHealth(healthPath)!;
    expect(first.consecutiveFailures).toBe(1);
    expect(first.failingSinceAt).toBe(first.lastErrorAt);
    expect(first.lastErrorProvider).toBe('openrouter');

    recordObserverFailure('openrouter', 'boom two', healthPath);
    const second = readObserverHealth(healthPath)!;
    expect(second.consecutiveFailures).toBe(2);
    expect(second.failingSinceAt).toBe(first.failingSinceAt);
    expect(second.lastErrorMessage).toBe('boom two');
  });

  it('success resets the streak but keeps last error details for diagnostics', () => {
    recordObserverFailure('openrouter', 'boom', healthPath);
    recordObserverSuccess(healthPath);
    const state = readObserverHealth(healthPath)!;
    expect(state.consecutiveFailures).toBe(0);
    expect(state.failingSinceAt).toBeNull();
    expect(state.lastSuccessAt).toBeGreaterThan(0);
    expect(state.lastErrorMessage).toBe('boom');
  });

  it('tolerates a corrupt health file by returning null', () => {
    writeFileSync(healthPath, 'not json{{{');
    expect(readObserverHealth(healthPath)).toBeNull();
  });

  it('scrubs credential-shaped content but keeps remedy URLs, and truncates', () => {
    const scrubbed = scrubErrorMessage(
      'auth sk-or-v1-3b5aaaaaaaaaaaaaaaa failed, Bearer abc.def.ghi rejected; manage at https://openrouter.ai/keys/2101b95e'
    );
    expect(scrubbed).not.toContain('sk-or-v1-3b5');
    expect(scrubbed).not.toContain('abc.def.ghi');
    expect(scrubbed).toContain('https://openrouter.ai/keys/2101b95e');
    expect(scrubErrorMessage('x'.repeat(10_000)).length).toBeLessThanOrEqual(600);
  });

  it('scrubs key/value, JSON, authorization, and query-string credential shapes', () => {
    const scrubbed = scrubErrorMessage(
      'POST https://api.example.com/v1/chat?api_key=SUPERSECRETONE&token=SUPERSECRETTWO failed: '
      + '{"apiKey": "SUPERSECRETTHREE", "client_secret":"SUPERSECRETFOUR"} '
      + 'Authorization: Basic SUPERSECRETFIVE; password=SUPERSECRETSIX'
    );
    for (const secret of ['SUPERSECRETONE', 'SUPERSECRETTWO', 'SUPERSECRETTHREE', 'SUPERSECRETFOUR', 'SUPERSECRETFIVE', 'SUPERSECRETSIX']) {
      expect(scrubbed).not.toContain(secret);
    }
  });

  it('keeps numeric diagnostics and remedy URLs that merely look credential-adjacent', () => {
    const scrubbed = scrubErrorMessage(
      'max_tokens: 200000 exceeded; Key limit exceeded (monthly limit). Manage it using https://openrouter.ai/keys/2101b95e'
    );
    expect(scrubbed).toContain('200000');
    expect(scrubbed).toContain('Key limit exceeded');
    expect(scrubbed).toContain('https://openrouter.ai/keys/2101b95e');
  });

  it('failure records pass the raw message through the scrubber', () => {
    recordObserverFailure('openrouter', 'key sk-or-v1-deadbeefdeadbeef died', healthPath);
    expect(readObserverHealth(healthPath)!.lastErrorMessage).not.toContain('deadbeef');
    expect(readFileSync(healthPath, 'utf-8')).not.toContain('deadbeef');
  });

  it('serializes concurrent failure writes so the warning threshold is never lost', async () => {
    const gatePath = join(dataDir, 'writers.gate');
    const writers = Array.from({ length: 3 }, () => Bun.spawn(['bun', '-e', `
      import { existsSync } from 'fs';
      import { recordObserverFailure } from ${JSON.stringify(join(repoRoot, 'src/shared/observer-health.ts'))};
      while (!existsSync(${JSON.stringify(gatePath)})) Bun.sleepSync(1);
      recordObserverFailure('openrouter', 'concurrent boom', ${JSON.stringify(healthPath)});
    `], { cwd: repoRoot, stderr: 'pipe' }));

    await Bun.sleep(500);
    writeFileSync(gatePath, 'go');
    const exitCodes = await Promise.all(writers.map((writer) => writer.exited));
    expect(exitCodes).toEqual([0, 0, 0]);

    const state = readObserverHealth(healthPath)!;
    expect(state.consecutiveFailures).toBe(3);
    expect(isObserverUnhealthy(state)).toBe(true);
  }, 30_000);
});

describe('isObserverUnhealthy', () => {
  it('requires the failure threshold AND failures newer than the last success', () => {
    expect(isObserverUnhealthy(null)).toBe(false);
    expect(isObserverUnhealthy(unhealthyState())).toBe(true);
    expect(isObserverUnhealthy(unhealthyState({ consecutiveFailures: OBSERVER_UNHEALTHY_FAILURE_THRESHOLD - 1 }))).toBe(false);
    expect(isObserverUnhealthy(unhealthyState({ lastSuccessAt: Date.now() + 60_000 }))).toBe(false);
    expect(isObserverUnhealthy(unhealthyState({ lastSuccessAt: null }))).toBe(true);
  });
});

describe('renderObserverHealthWarning', () => {
  it('includes count, provider, since-time, last error, and the tell-the-user instruction', () => {
    const nowMs = 1_754_700_000_000 + 2 * 60 * 60_000;
    const warning = renderObserverHealthWarning(unhealthyState({ consecutiveFailures: 4245 }), nowMs);
    expect(warning).toContain("can't save memories");
    expect(warning).toContain('4245 times in a row');
    expect(warning).toContain('for about 2 hours');
    expect(warning).toContain('openrouter');
    expect(warning).toContain(new Date(1_754_700_000_000).toISOString());
    expect(warning).toContain('https://openrouter.ai/keys/abc');
    expect(warning).toContain('tell the user');
  });

  it('re-scrubs the stored error, so a ledger written by an older build cannot leak a secret', () => {
    const warning = renderObserverHealthWarning(
      unhealthyState({ lastErrorMessage: 'rejected: api_key=SUPERSECRETLEDGER' })
    );
    expect(warning).not.toContain('SUPERSECRETLEDGER');
  });
});

describe('describeDuration', () => {
  it('renders minutes, hours, and days at human granularity', () => {
    expect(describeDuration(30_000)).toBe('1 minute');
    expect(describeDuration(57 * 60_000)).toBe('57 minutes');
    expect(describeDuration(3 * 60 * 60_000)).toBe('about 3 hours');
    expect(describeDuration(72 * 60 * 60_000)).toBe('about 3 days');
  });
});

describe('ContextBuilder observer-health injection', () => {
  function runContextChild(childDataDir: string): { emptyDbText: string } {
    const result = Bun.spawnSync(['bun', '-e', `
      import { generateContext } from './src/services/context/ContextBuilder.ts';
      import { ModeManager } from './src/services/domain/ModeManager.ts';
      ModeManager.getInstance().loadMode('code');
      const emptyDbText = await generateContext({ projects: ['observer-health-test'] });
      console.log(JSON.stringify({ emptyDbText }));
    `], {
      cwd: repoRoot,
      env: {
        ...process.env,
        CLAUDE_MEM_DATA_DIR: childDataDir,
        CLAUDE_CONFIG_DIR: childDataDir,
        CLAUDE_MEM_MODES_DIR: join(repoRoot, 'plugin', 'modes'),
      },
    });
    if (result.exitCode !== 0) {
      throw new Error(new TextDecoder().decode(result.stderr));
    }
    return JSON.parse(new TextDecoder().decode(result.stdout).trim());
  }

  it('prepends the outage warning even when there is no database to render', () => {
    writeFileSync(join(dataDir, 'observer-health.json'), JSON.stringify(unhealthyState()));
    const { emptyDbText } = runContextChild(dataDir);
    expect(emptyDbText).toContain("can't save memories");
    expect(emptyDbText).toContain('openrouter');
  });

  it('stays silent when the observer is healthy', () => {
    writeFileSync(
      join(dataDir, 'observer-health.json'),
      JSON.stringify(unhealthyState({ consecutiveFailures: 0, lastSuccessAt: Date.now() }))
    );
    const { emptyDbText } = runContextChild(dataDir);
    expect(emptyDbText).not.toContain("can't save memories");
  });
});
