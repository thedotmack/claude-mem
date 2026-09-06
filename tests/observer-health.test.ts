import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  readObserverHealth,
  recordObserverFailure,
  recordObserverSuccess,
  isObserverUnhealthy,
  workerRestartUrl,
  renderObserverHealthWarning,
  describeDuration,
  scrubErrorMessage,
  OBSERVER_UNHEALTHY_FAILURE_THRESHOLD,
  type ObserverHealthState,
} from '../src/shared/observer-health.ts';

const repoRoot = process.cwd();

const RED = '\x1b[31m';
const RESET = '\x1b[0m';

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

  it('object form round-trips code, action, url, and request id through the file', () => {
    recordObserverFailure('openrouter', {
      message: "You've used your $30 monthly allowance.",
      code: 'allowance_exhausted',
      action: 'It resets on the 1st. Upgrade or add credits to keep going now.',
      url: 'https://cmem.ai/dashboard',
      requestId: 'req_abc123',
    }, healthPath);
    const state = readObserverHealth(healthPath)!;
    expect(state.consecutiveFailures).toBe(1);
    expect(state.lastErrorMessage).toBe("You've used your $30 monthly allowance.");
    expect(state.lastErrorCode).toBe('allowance_exhausted');
    expect(state.lastErrorAction).toBe('It resets on the 1st. Upgrade or add credits to keep going now.');
    expect(state.lastErrorUrl).toBe('https://cmem.ai/dashboard');
    expect(state.lastErrorRequestId).toBe('req_abc123');
    // Persisted, not just in-memory: the raw JSON carries the keys.
    const raw = JSON.parse(readFileSync(healthPath, 'utf-8'));
    expect(raw.lastErrorCode).toBe('allowance_exhausted');
    expect(raw.lastErrorRequestId).toBe('req_abc123');
  });

  it('string form leaves the structured fields null, and overwrites stale ones from a prior classified failure', () => {
    recordObserverFailure('openrouter', 'plain boom', healthPath);
    const plain = readObserverHealth(healthPath)!;
    expect(plain.lastErrorMessage).toBe('plain boom');
    expect(plain.lastErrorCode).toBeNull();
    expect(plain.lastErrorAction).toBeNull();
    expect(plain.lastErrorUrl).toBeNull();
    expect(plain.lastErrorRequestId).toBeNull();

    recordObserverFailure('openrouter', {
      message: 'classified', code: 'key_invalid', action: 'Reconnect', url: 'https://cmem.ai/dashboard', requestId: 'r1',
    }, healthPath);
    recordObserverFailure('openrouter', 'plain again', healthPath);
    const after = readObserverHealth(healthPath)!;
    expect(after.consecutiveFailures).toBe(3);
    expect(after.lastErrorMessage).toBe('plain again');
    expect(after.lastErrorCode).toBeNull();
    expect(after.lastErrorAction).toBeNull();
    expect(after.lastErrorUrl).toBeNull();
    expect(after.lastErrorRequestId).toBeNull();
  });

  it('scrubs the object-form message and action but stores url and request id as-is', () => {
    recordObserverFailure('openrouter', {
      message: 'rejected api_key=SUPERSECRETMSG',
      action: 'retry with token=SUPERSECRETACTION',
      url: 'https://cmem.ai/dashboard?ref=key',
      requestId: 'req_keep_me',
    }, healthPath);
    const state = readObserverHealth(healthPath)!;
    expect(state.lastErrorMessage).not.toContain('SUPERSECRETMSG');
    expect(state.lastErrorAction).not.toContain('SUPERSECRETACTION');
    expect(state.lastErrorUrl).toBe('https://cmem.ai/dashboard?ref=key');
    expect(state.lastErrorRequestId).toBe('req_keep_me');
  });

  it('reads an old ledger file lacking the structured keys with them null', () => {
    writeFileSync(healthPath, JSON.stringify({
      consecutiveFailures: 5,
      failingSinceAt: 1_754_700_000_000,
      lastErrorAt: 1_754_700_100_000,
      lastErrorMessage: 'legacy boom',
      lastErrorProvider: 'openrouter',
      lastSuccessAt: null,
    }));
    const state = readObserverHealth(healthPath)!;
    expect(state.consecutiveFailures).toBe(5);
    expect(state.lastErrorMessage).toBe('legacy boom');
    expect(state.lastErrorCode).toBeNull();
    expect(state.lastErrorAction).toBeNull();
    expect(state.lastErrorUrl).toBeNull();
    expect(state.lastErrorRequestId).toBeNull();
  });

  it('scrubs credential-shaped content but keeps remedy URLs, and truncates', () => {
    const scrubbed = scrubErrorMessage(
      'auth sk-or-v1-3b5aaaaaaaaaaaaaaaa failed, Bearer abc.def.ghi rejected; manage at https://openrouter.ai/keys/2101b95e'
    );
    expect(scrubbed).not.toContain('sk-or-v1-3b5');
    expect(scrubbed).not.toContain('abc.def.ghi');
    expect(scrubbed).toContain('https://openrouter.ai/keys/2101b95e');
    expect(scrubErrorMessage('x'.repeat(10_000)).length).toBeLessThanOrEqual(600);
    expect(scrubErrorMessage('Unrecognized key cm_pro_9f8e7d6c5b4a3210')).not.toContain('9f8e7d6c5b4a3210');
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

  it('with an action: shows What to do / Link / Request id and drops the generic settings.json remedy', () => {
    const warning = renderObserverHealthWarning(unhealthyState({
      lastErrorMessage: "You've used your $30 monthly allowance.",
      lastErrorCode: 'allowance_exhausted',
      lastErrorAction: 'It resets on the 1st. Upgrade or add credits to keep going now.',
      lastErrorUrl: 'https://cmem.ai/dashboard',
      lastErrorRequestId: 'req_abc123',
    }));
    expect(warning).toContain("Latest error: You've used your $30 monthly allowance.");
    expect(warning).toContain('What to do: It resets on the 1st. Upgrade or add credits to keep going now.');
    expect(warning).toContain('Link: https://cmem.ai/dashboard');
    expect(warning).toContain('Request id: req_abc123');
    expect(warning).not.toContain('~/.claude-mem/settings.json');
    expect(warning).toContain('tell the user');
  });

  it('without an action: keeps the generic settings.json remedy and omits the structured lines', () => {
    const warning = renderObserverHealthWarning(unhealthyState());
    expect(warning).toContain('~/.claude-mem/settings.json');
    expect(warning).not.toContain('What to do:');
    expect(warning).not.toContain('Link:');
    expect(warning).not.toContain('Request id:');
  });

  it('renders Link and Request id even without an action, keeping the generic remedy', () => {
    const warning = renderObserverHealthWarning(unhealthyState({
      lastErrorUrl: 'https://openrouter.ai/settings/keys',
      lastErrorRequestId: 'req_only',
    }));
    expect(warning).toContain('Link: https://openrouter.ai/settings/keys');
    expect(warning).toContain('Request id: req_only');
    expect(warning).not.toContain('What to do:');
    expect(warning).toContain('~/.claude-mem/settings.json');
  });

  it('offers both a click-to-restart link and the terminal command, then doctor', () => {
    const warning = renderObserverHealthWarning(unhealthyState());
    expect(warning).toContain(workerRestartUrl());
    expect(warning).toContain('npx claude-mem restart');
    expect(warning).toContain('npx claude-mem doctor');
    expect(warning.indexOf(workerRestartUrl())).toBeLessThan(warning.indexOf('npx claude-mem doctor'));
  });

  it('points the restart link at the worker port, not a hardcoded one', () => {
    expect(workerRestartUrl()).toMatch(/^http:\/\/localhost:\d+\/restart$/);
  });

  it('leaves the restart to the user rather than telling the assistant to fire it', () => {
    const instruction = renderObserverHealthWarning(unhealthyState());
    const assistantBlock = instruction.slice(instruction.indexOf('(Assistant:'));
    expect(assistantBlock).toContain('let them press it');
    expect(assistantBlock).not.toContain('npx claude-mem restart');
  });

  it('keeps the remedy steps even when the error is classified', () => {
    const warning = renderObserverHealthWarning(unhealthyState({
      lastErrorAction: 'Add credits to keep going now.',
    }));
    expect(warning).toContain(workerRestartUrl());
    expect(warning).toContain('npx claude-mem doctor');
    expect(warning).toContain('What to do: Add credits to keep going now.');
    expect(warning).not.toContain('~/.claude-mem/settings.json');
  });

  it('re-scrubs the action at render time', () => {
    const warning = renderObserverHealthWarning(unhealthyState({
      lastErrorAction: 'rotate; token=SUPERSECRETACTION',
    }));
    expect(warning).toContain('What to do:');
    expect(warning).not.toContain('SUPERSECRETACTION');
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
  interface ChildRender {
    emptyDbText: string;
    agentText: string;
    humanText: string;
  }

  function runContextChild(childDataDir: string): ChildRender {
    const result = Bun.spawnSync(['bun', '-e', `
      import { generateContext, withObserverHealthWarning } from './src/services/context/ContextBuilder.ts';
      import { ModeManager } from './src/services/domain/ModeManager.ts';
      ModeManager.getInstance().loadMode('code');
      const emptyDbText = await generateContext({ projects: ['observer-health-test'] });
      const agentText = withObserverHealthWarning('TIMELINE_BODY', false);
      const humanText = withObserverHealthWarning('TIMELINE_BODY', true);
      console.log(JSON.stringify({ emptyDbText, agentText, humanText }));
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

  it('shows the outage warning even when there is no database to render', () => {
    writeFileSync(join(dataDir, 'observer-health.json'), JSON.stringify(unhealthyState()));
    const { emptyDbText } = runContextChild(dataDir);
    expect(emptyDbText).toContain("can't save memories");
    expect(emptyDbText).toContain('openrouter');
  });

  it('puts the warning BELOW the context, where a long timeline cannot scroll it away', () => {
    writeFileSync(join(dataDir, 'observer-health.json'), JSON.stringify(unhealthyState()));
    const { agentText, humanText } = runContextChild(dataDir);
    for (const text of [agentText, humanText]) {
      expect(text).toContain('TIMELINE_BODY');
      expect(text).toContain("can't save memories");
      expect(text.indexOf('TIMELINE_BODY')).toBeLessThan(text.indexOf("can't save memories"));
    }
  });

  it('paints the warning red for the terminal and leaves the agent copy clean', () => {
    writeFileSync(join(dataDir, 'observer-health.json'), JSON.stringify(unhealthyState()));
    const { agentText, humanText } = runContextChild(dataDir);

    expect(humanText).toContain(RED);
    expect(humanText).toContain(RESET);
    // Every non-blank warning line is painted, not just the first.
    const warningLines = humanText
      .slice(humanText.indexOf(RED))
      .split('\n')
      .filter((line) => line.trim());
    expect(warningLines.every((line) => line.startsWith(RED) && line.endsWith(RESET))).toBe(true);

    expect(agentText).not.toContain(RED);
    expect(agentText).not.toContain('\x1b[');
  });

  it('leaves the context body itself unpainted', () => {
    writeFileSync(join(dataDir, 'observer-health.json'), JSON.stringify(unhealthyState()));
    const { humanText } = runContextChild(dataDir);
    expect(humanText.slice(0, humanText.indexOf(RED))).toContain('TIMELINE_BODY');
    expect(humanText.slice(0, humanText.indexOf(RED))).not.toContain('\x1b[');
  });

  it('stays silent when the observer is healthy', () => {
    writeFileSync(
      join(dataDir, 'observer-health.json'),
      JSON.stringify(unhealthyState({ consecutiveFailures: 0, lastSuccessAt: Date.now() }))
    );
    const { emptyDbText, humanText } = runContextChild(dataDir);
    expect(emptyDbText).not.toContain("can't save memories");
    expect(humanText).toBe('TIMELINE_BODY');
  });
});
