// Every reader that decides whether requests wait must ask the same question:
// does this cooldown withhold requests from the Claude account selected now?
// Only admission asked it (#4272). After CLAUDE_MEM_CLAUDE_CONFIG_DIR moved from
// an exhausted account A to account B, the resume sweep (#4110) held B's
// backlog behind A's breaker for up to 30 minutes, and SessionStart told B that
// capture was paused. The first two cases are the Wave 1+2 gate reviewer's repro.
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { rmSync } from 'fs';
import { join } from 'path';
import { SessionManager } from '../../../../src/services/worker/SessionManager.js';
import { SessionRoutes } from '../../../../src/services/worker/http/routes/SessionRoutes.js';
import * as providerDispatch from '../../../../src/services/worker/provider-dispatch.js';
import { observerHealthWarning } from '../../../../src/services/context/ContextBuilder.js';
import { OBSERVER_HEALTH_FILENAME } from '../../../../src/shared/observer-health.js';
import { resetDependencyStatusesForTesting } from '../../../../src/shared/dependency-health.js';
import { paths } from '../../../../src/shared/paths.js';
import {
  recordAuthCooldown,
  recordQuotaExhausted,
  resetQuotaCooldownsForTesting,
  setClaudeProfileResolverForTesting,
  tryAdmitQuotaProbe,
} from '../../../../src/shared/quota-cooldown.js';
import { guardSharedQuotaCooldownSingleton } from '../../../shared/quota-cooldown-singleton-guard.js';
import { logger } from '../../../../src/utils/logger.js';

guardSharedQuotaCooldownSingleton('session-routes-account-switch.test.ts');

const PAUSE_NOTICE = 'paused while a provider quota cooldown is active';
const healthPath = () => join(paths.dataDir(), OBSERVER_HEALTH_FILENAME);

function fixture() {
  const db = {
    getSessionById: mock((id: number) => ({ content_session_id: `c-${id}`, project: 'p', user_prompt: 'u' })),
    getSessionStore: mock(() => { throw new Error('no db'); }),
  };
  const manager = new SessionManager(db as any);
  manager.initializeSession(1, 'u', 1);
  manager.getMessageBuffer().enqueue(1, { type: 'observation', tool_name: 'Read', tool_input: { path: 'f' } });
  manager.getSession(1)!.pausedReason = 'quota';
  const agent = { startSession: mock(() => new Promise<void>(() => {})) };
  const routes = new SessionRoutes(manager, db as any, agent as any, agent as any, agent as any, {} as any, {} as any, {} as any);
  spyOn(routes as any, 'applyTierRouting').mockResolvedValue(undefined);
  return { routes, agent };
}

async function flushStarts() {
  await new Promise<void>(resolve => setImmediate(resolve));
}

describe('cooldown reads after a Claude account switch', () => {
  let profile = 'A';

  beforeEach(() => {
    for (const level of ['info', 'debug', 'warn', 'error'] as const) spyOn(logger, level).mockImplementation(() => {});
    resetQuotaCooldownsForTesting();
    // A Claude start passes the setup gate first; another file's leftover
    // setup status would turn these starts away for a reason under no test.
    resetDependencyStatusesForTesting();
    rmSync(healthPath(), { force: true });
    profile = 'A';
    setClaudeProfileResolverForTesting(() => profile);
    spyOn(providerDispatch, 'selectProviderForGenerator').mockReturnValue({ provider: 'claude', gatewayProbeClaimId: null });
    spyOn(providerDispatch, 'getSelectedProvider').mockReturnValue('claude');
  });

  afterEach(() => {
    resetQuotaCooldownsForTesting();
    rmSync(healthPath(), { force: true });
    mock.restore();
  });

  it('admission treats account B as unblocked (#4272)', () => {
    recordQuotaExhausted('claude', 'Weekly limit reached', 'seven_day'); // armed under A
    profile = 'B';
    expect(tryAdmitQuotaProbe('claude').admitted).toBe(true);
  });

  it("the periodic sweep resumes B's paused work at once, not behind A's breaker", async () => {
    const { routes, agent } = fixture();
    recordQuotaExhausted('claude', 'Weekly limit reached', 'seven_day'); // armed under A
    profile = 'B';
    const scheduled = routes.resumePendingSessions('periodic-resume');
    await flushStarts();
    expect(scheduled).toBe(1);
    expect(agent.startSession).toHaveBeenCalledTimes(1);
  });

  it("does the same behind A's refused credential (#4276's auth cooldown)", async () => {
    const { routes, agent } = fixture();
    recordAuthCooldown('claude', 'Invalid API key'); // armed under A
    profile = 'B';
    expect(routes.resumePendingSessions('periodic-resume')).toBe(1);
    await flushStarts();
    expect(agent.startSession).toHaveBeenCalledTimes(1);
  });

  it('still holds the account that armed the breaker', async () => {
    const { routes, agent } = fixture();
    recordQuotaExhausted('claude', 'Weekly limit reached', 'seven_day');
    expect(routes.resumePendingSessions('periodic-resume')).toBe(0);
    await flushStarts();
    expect(agent.startSession).not.toHaveBeenCalled();
  });

  it('tells only the paused account at SessionStart that capture is paused', () => {
    recordQuotaExhausted('claude', 'Weekly limit reached', 'seven_day'); // armed under A
    expect(observerHealthWarning()).toContain(PAUSE_NOTICE);

    profile = 'B';
    expect(observerHealthWarning()).not.toContain(PAUSE_NOTICE);

    profile = 'A';
    expect(observerHealthWarning()).toContain(PAUSE_NOTICE);
  });
});
