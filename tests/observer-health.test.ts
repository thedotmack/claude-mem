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

  it('failure records pass the raw message through the scrubber', () => {
    recordObserverFailure('openrouter', 'key sk-or-v1-deadbeefdeadbeef died', healthPath);
    expect(readObserverHealth(healthPath)!.lastErrorMessage).not.toContain('deadbeef');
    expect(readFileSync(healthPath, 'utf-8')).not.toContain('deadbeef');
  });
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
    const warning = renderObserverHealthWarning(unhealthyState({ consecutiveFailures: 4245 }));
    expect(warning).toContain('NOT BEING RECORDED');
    expect(warning).toContain('4245 consecutive times');
    expect(warning).toContain('openrouter');
    expect(warning).toContain(new Date(1_754_700_000_000).toISOString());
    expect(warning).toContain('https://openrouter.ai/keys/abc');
    expect(warning).toContain('Tell the user');
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
    expect(emptyDbText).toContain('NOT BEING RECORDED');
    expect(emptyDbText).toContain('openrouter');
  });

  it('stays silent when the observer is healthy', () => {
    writeFileSync(
      join(dataDir, 'observer-health.json'),
      JSON.stringify(unhealthyState({ consecutiveFailures: 0, lastSuccessAt: Date.now() }))
    );
    const { emptyDbText } = runContextChild(dataDir);
    expect(emptyDbText).not.toContain('NOT BEING RECORDED');
  });
});
