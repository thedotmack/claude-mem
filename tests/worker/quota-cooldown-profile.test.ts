import { describe, it, expect, beforeEach, afterAll, mock, spyOn } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { ActiveSession } from '../../src/services/worker-types.js';
import * as providerDispatch from '../../src/services/worker/provider-dispatch.js';
import { configDirProfileKey } from '../../src/shared/EnvManager.js';
import {
  tryAdmitQuotaProbe,
  recordQuotaExhausted,
  getQuotaCooldown,
  resetQuotaCooldownsForTesting,
  setClaudeProfileResolverForTesting,
  QUOTA_COOLDOWN_FILENAME,
} from '../../src/shared/quota-cooldown.js';
import {
  isObserverQuotaCooldownActive,
  OBSERVER_HEALTH_FILENAME,
  readObserverHealth,
} from '../../src/shared/observer-health.js';
import { paths, DEFAULT_CLAUDE_CONFIG_DIR } from '../../src/shared/paths.js';

// Quota is per Claude account, and CLAUDE_MEM_CLAUDE_CONFIG_DIR can move the
// observer to another account between spawns. A 'claude' breaker armed while
// billing one profile must not pause capture for a different one.
describe('quota cooldown breaker — per-account claude profile', () => {
  let currentProfile = 'work';
  const ledgerPath = () => join(paths.dataDir(), QUOTA_COOLDOWN_FILENAME);

  beforeEach(() => {
    resetQuotaCooldownsForTesting();
    currentProfile = 'work';
    setClaudeProfileResolverForTesting(() => currentProfile);
  });

  afterAll(() => {
    resetQuotaCooldownsForTesting();
  });

  it('records the profile that armed a claude breaker', () => {
    recordQuotaExhausted('claude', 'Weekly limit reached', 'seven_day');
    expect(getQuotaCooldown('claude')?.profile).toBe('work');
  });

  it('keeps withholding requests while the same profile is selected', () => {
    recordQuotaExhausted('claude', 'Weekly limit reached', 'seven_day');
    expect(tryAdmitQuotaProbe('claude')).toEqual({ admitted: false, claimId: null });
  });

  it('drops a breaker armed under another profile and admits the new one', () => {
    recordQuotaExhausted('claude', 'Weekly limit reached', 'seven_day');
    currentProfile = 'personal';

    expect(tryAdmitQuotaProbe('claude')).toEqual({ admitted: true, claimId: null });
    expect(getQuotaCooldown('claude')).toBeNull();
    expect(isObserverQuotaCooldownActive(readObserverHealth(join(paths.dataDir(), OBSERVER_HEALTH_FILENAME)))).toBe(false);
  });

  it('re-arms for the new profile if it is exhausted too', () => {
    recordQuotaExhausted('claude', 'Weekly limit reached');
    currentProfile = 'personal';
    expect(tryAdmitQuotaProbe('claude').admitted).toBe(true);

    recordQuotaExhausted('claude', 'Weekly limit reached');
    expect(getQuotaCooldown('claude')?.profile).toBe('personal');
    expect(tryAdmitQuotaProbe('claude').admitted).toBe(false);
  });

  it('does not scope non-claude providers by profile', () => {
    recordQuotaExhausted('gemini', 'Daily limit reached');
    currentProfile = 'personal';

    expect(getQuotaCooldown('gemini')?.profile).toBeUndefined();
    expect(tryAdmitQuotaProbe('gemini').admitted).toBe(false);
  });

  it('persists the profile across a restart', () => {
    recordQuotaExhausted('claude', 'Weekly limit reached', 'seven_day');
    const ledger = readFileSync(ledgerPath(), 'utf-8');
    expect(JSON.parse(ledger)[0].profile).toBe('work');

    // Simulate a fresh process reading the ledger the previous one wrote.
    resetQuotaCooldownsForTesting();
    setClaudeProfileResolverForTesting(() => currentProfile);
    writeFileSync(ledgerPath(), ledger, 'utf-8');

    expect(getQuotaCooldown('claude')?.profile).toBe('work');
    expect(tryAdmitQuotaProbe('claude').admitted).toBe(false);
  });

  it('treats a persisted claude breaker without a profile as another account\'s', () => {
    mkdirSync(paths.dataDir(), { recursive: true });
    writeFileSync(ledgerPath(), JSON.stringify([
      { provider: 'claude', message: 'Weekly limit reached', window: 'seven_day', armedAtMs: Date.now() },
    ]), 'utf-8');

    expect(getQuotaCooldown('claude')?.profile).toBeUndefined();
    expect(tryAdmitQuotaProbe('claude')).toEqual({ admitted: true, claimId: null });
    expect(getQuotaCooldown('claude')).toBeNull();
  });

  it('arms a late refusal under the account its generator was spawned on', () => {
    // Spawned on 'work', refused after the user switched to 'personal'.
    currentProfile = 'personal';
    recordQuotaExhausted('claude', 'Weekly limit reached', 'seven_day', undefined, 'work');

    expect(getQuotaCooldown('claude')?.profile).toBe('work');
    expect(tryAdmitQuotaProbe('claude')).toEqual({ admitted: true, claimId: null });
  });

  it('carries the spawn-time account from the session to the breaker', async () => {
    const { SessionRoutes } = await import('../../src/services/worker/http/routes/SessionRoutes.js');
    const session = {
      sessionDbId: 91, contentSessionId: 'content-91', memorySessionId: 'memory-91', project: 'project',
      platformSource: 'claude', userPrompt: 'prompt', abortController: new AbortController(),
      generatorPromise: null, lastPromptNumber: 1, startTime: Date.now(), cumulativeInputTokens: 0,
      cumulativeOutputTokens: 0, earliestPendingTimestamp: null, claimedMessageIds: [],
      conversationHistory: [], currentProvider: null, consecutiveRestarts: 0,
      consecutiveInvalidOutputs: 0, consecutiveContextOverflows: 0, lastGeneratorActivity: Date.now(),
    } as ActiveSession;
    const sessionManager = {
      getSession: () => session,
      getMessageBuffer: () => ({ getPendingCount: () => 1, peekTypes: () => [] }),
      removeSessionImmediate: () => {},
    };
    const claude = {
      startSession: async () => {
        // What ClaudeProvider records at spawn, before the account switch.
        session.observerProfile = 'work';
        currentProfile = 'personal';
        session.abortReason = 'quota:seven_day';
      },
    };
    const idle = { startSession: async () => {} };
    const routes = new SessionRoutes(sessionManager as any, {} as any, claude as any, idle as any, idle as any,
      {} as any, {} as any, { finalizeSession: async () => {} } as any);
    spyOn(providerDispatch, 'selectProviderForGenerator')
      .mockReturnValue({ provider: 'claude', gatewayProbeClaimId: null });

    try {
      await routes.ensureGeneratorRunning(session.sessionDbId, 'observation');
      await session.generatorPromise;
    } finally {
      mock.restore();
    }

    expect(getQuotaCooldown('claude')?.profile).toBe('work');
    expect(tryAdmitQuotaProbe('claude').admitted).toBe(true);
  });
});

// Two config dirs with the same basename are two accounts; the key must not
// merge them, and must not write the path (and the username) anywhere.
describe('configDirProfileKey', () => {
  it('keeps config dirs that share a basename apart', () => {
    const first = configDirProfileKey('/home/alice/accounts/work');
    const second = configDirProfileKey('/home/alice/clients/work');
    expect(first).not.toBe(second);
    expect(first.startsWith('work#')).toBe(true);
    expect(first).not.toContain('alice');
  });

  it('is stable for one directory', () => {
    expect(configDirProfileKey('/home/alice/work')).toBe(configDirProfileKey('/home/alice/work'));
  });

  it('names the default config dir "default"', () => {
    expect(configDirProfileKey(DEFAULT_CLAUDE_CONFIG_DIR)).toBe('default');
  });
});
