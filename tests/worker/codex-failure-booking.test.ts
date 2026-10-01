import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import codeMode from '../../plugin/modes/code.json';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { ModeManager } from '../../src/services/domain/ModeManager.js';
import { SessionRoutes } from '../../src/services/worker/http/routes/SessionRoutes.js';
import { telemetryBuffer } from '../../src/services/telemetry/buffer.js';
import { classifyCodexError } from '../../src/services/worker/CodexProvider.js';
import { OpenAICompatibleProvider, type ProviderQueryResult } from '../../src/services/worker/OpenAICompatibleProvider.js';
import { ClassifiedProviderError, CODEX_COOLDOWN_REFUSAL_CODE } from '../../src/services/worker/provider-errors.js';
import {
  OBSERVER_HEALTH_FILENAME,
  isObserverUnhealthy,
  readObserverHealth,
} from '../../src/shared/observer-health.js';
import {
  getQuotaCooldown,
  recordAuthCooldown,
  recordQuotaExhausted,
  resetQuotaCooldownsForTesting,
} from '../../src/shared/quota-cooldown.js';
import {
  clearDependencyStatus,
  getDependencyStatus,
  recordCodexCliSetupRequired,
} from '../../src/shared/dependency-health.js';
import { paths } from '../../src/shared/paths.js';
import type { ActiveSession } from '../../src/services/worker-types.js';
import type { DatabaseManager } from '../../src/services/worker/DatabaseManager.js';
import type { SessionManager } from '../../src/services/worker/SessionManager.js';
import type { SessionCompletionHandler } from '../../src/services/worker/session/SessionCompletionHandler.js';

// R4-3 / R4-12: how the session runner books a Codex failure.
//  - A setup failure (missing CLI or login, a model or effort Codex does not
//    serve, a CLI too old for the protocol) only reached dependency health,
//    which SessionStart never shows: memory stopped with no warning.
//  - A request the armed breaker or setup gate withheld was booked again as a
//    fresh failure, which re-armed the breaker (dropping the probe that would
//    have cleared it) and counted one outage many times.

const mockMode = {
  name: 'code',
  prompts: codeMode.prompts,
  observation_types: [{ id: 'discovery' }],
  observation_concepts: [],
};

function makeSession(): ActiveSession {
  return {
    sessionDbId: 4385,
    contentSessionId: 'codex-booking',
    memorySessionId: 'mem-codex-booking',
    project: 'repo',
    platformSource: 'codex',
    userPrompt: 'test prompt',
    abortController: new AbortController(),
    generatorPromise: null,
    lastPromptNumber: 1,
    startTime: Date.now(),
    cumulativeInputTokens: 0,
    cumulativeOutputTokens: 0,
    earliestPendingTimestamp: null,
    claimedMessageIds: [],
    conversationHistory: [],
    currentProvider: null,
    consecutiveRestarts: 0,
    consecutiveInvalidOutputs: 0,
    lastGeneratorActivity: Date.now(),
  } as unknown as ActiveSession;
}

/** Stands in for CodexProvider: its first request fails with `toThrow`. */
class FailingCodex extends OpenAICompatibleProvider<{ apiKey: string; model: string }> {
  protected readonly providerName = 'Codex';
  protected readonly syntheticIdPrefix = 'codex';
  protected readonly forwardEmptyMessageResponse = true;

  constructor(private readonly toThrow: unknown) {
    super({} as DatabaseManager, {
      getMessageIterator: async function* () { yield* []; },
    } as unknown as SessionManager);
  }

  protected getConfig() {
    return { apiKey: 'codex-subscription', model: '' };
  }

  protected missingApiKeyError(): Error {
    return new Error('missing');
  }

  protected async query(): Promise<ProviderQueryResult> {
    throw this.toThrow;
  }

  protected estimateTokens(): number {
    return 0;
  }

  protected buildLastUsage(): ActiveSession['lastUsage'] {
    return null;
  }
}

const healthPath = join(paths.dataDir(), OBSERVER_HEALTH_FILENAME);
let ledgerBefore: string | null;
let modeSpy: ReturnType<typeof spyOn>;
let telemetrySpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  ledgerBefore = existsSync(healthPath) ? readFileSync(healthPath, 'utf-8') : null;
  rmSync(healthPath, { force: true });
  resetQuotaCooldownsForTesting();
  clearDependencyStatus('codex_cli');
  modeSpy = spyOn(ModeManager, 'getInstance').mockReturnValue({
    getActiveMode: () => mockMode,
    loadMode: () => {},
  } as unknown as ModeManager);
  telemetrySpy = spyOn(telemetryBuffer, 'record').mockImplementation(() => {});
});

afterEach(() => {
  modeSpy.mockRestore();
  telemetrySpy.mockRestore();
  resetQuotaCooldownsForTesting();
  clearDependencyStatus('codex_cli');
  if (ledgerBefore === null) rmSync(healthPath, { force: true });
  else writeFileSync(healthPath, ledgerBefore);
});

function readLedgerText(): string | null {
  return existsSync(healthPath) ? readFileSync(healthPath, 'utf-8') : null;
}

async function runCodex(error: unknown) {
  const session = makeSession();
  const finalizeSession = mock(() => Promise.resolve());
  const routes = new SessionRoutes(
    {
      getSession: () => session,
      getMessageBuffer: () => ({ getPendingCount: () => 1 }),
      removeSessionImmediate: mock(() => {}),
      clearTransportResume: mock(() => {}),
      scheduleTransportResume: mock(() => {}),
    } as unknown as SessionManager,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { finalizeSession } as unknown as SessionCompletionHandler,
    new FailingCodex(error) as never,
  );
  await (routes as unknown as {
    startGeneratorWithProvider(s: ActiveSession, p: string, src: string, q: null, g: null): Promise<void>;
  }).startGeneratorWithProvider(session, 'codex', 'observation', null, null);
  await session.generatorPromise;
  return { session, finalizeSession };
}

describe('a Codex setup failure reaches observer-health', () => {
  it('books it at once with its remedy, and keeps the buffered work', async () => {
    const error = classifyCodexError(new Error('Codex app-server RPC error -32602: Invalid request: unknown variant `max`'));

    const { session, finalizeSession } = await runCodex(error);

    const health = readObserverHealth(healthPath);
    expect(health?.lastErrorProvider).toBe('codex');
    expect(health?.lastErrorKind).toBe('setup_required');
    expect(health?.lastErrorAction).toContain('CLAUDE_MEM_CODEX_REASONING_EFFORT');
    // Not a blip: the codex_cli gate allows one recheck per five minutes, so
    // waiting for the failure threshold would hide the remedy for a quarter hour.
    expect(isObserverUnhealthy(health)).toBe(true);
    expect(getDependencyStatus('codex_cli')?.remediation).toContain('CLAUDE_MEM_CODEX_REASONING_EFFORT');
    expect(session.pausedReason).toBe('setup_required');
    expect(finalizeSession).not.toHaveBeenCalled();
  });

  it('names the install remedy for a missing CLI', async () => {
    await runCodex(classifyCodexError(Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' })));

    expect(readObserverHealth(healthPath)?.lastErrorAction).toContain('codex login');
  });
});

describe('a request the armed gate withheld is not booked again', () => {
  it('leaves the setup gate and the ledger as the failure that armed it left them', async () => {
    const armed = recordCodexCliSetupRequired('Codex CLI or login is not set up');
    const ledger = readLedgerText();

    const { session, finalizeSession } = await runCodex(new ClassifiedProviderError(armed.message, {
      kind: 'setup_required', cause: null, code: CODEX_COOLDOWN_REFUSAL_CODE,
    }));

    expect(getDependencyStatus('codex_cli')).toBe(armed);
    expect(readLedgerText()).toBe(ledger);
    expect(session.pausedReason).toBe('setup_required');
    expect(finalizeSession).not.toHaveBeenCalled();
  });

  for (const [label, arm, kind] of [
    ['quota', () => recordQuotaExhausted('codex', 'Codex: usage limit reached'), 'quota_exhausted'],
    ['auth', () => recordAuthCooldown('codex', 'Codex: unauthorized'), 'auth_invalid'],
  ] as const) {
    it(`does not re-arm the ${label} breaker or count the withheld request as a failure`, async () => {
      const armed = arm();
      const ledger = readLedgerText();

      const { finalizeSession } = await runCodex(new ClassifiedProviderError(armed.message, {
        kind, cause: null, code: CODEX_COOLDOWN_REFUSAL_CODE,
      }));

      // Same breaker object: a re-arm installs a new one, which ends the
      // in-flight probe and means its success can no longer clear it.
      expect(getQuotaCooldown('codex')).toBe(armed);
      expect(readLedgerText()).toBe(ledger);
      expect(finalizeSession).not.toHaveBeenCalled();
    });
  }
});
