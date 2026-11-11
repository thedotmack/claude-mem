import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { SessionManager } from '../../src/services/worker/SessionManager.js';
import { SessionRoutes } from '../../src/services/worker/http/routes/SessionRoutes.js';
import { OpenRouterProvider } from '../../src/services/worker/OpenRouterProvider.js';
import { paidSendBudgetForClaimedBatch, type PaidSendBudget } from '../../src/services/worker/paid-send-budget.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import { logger } from '../../src/utils/logger.js';

class LocalProvider extends OpenRouterProvider {
  ask(url: string, budget: PaidSendBudget) {
    return this.query([{ role: 'user', content: 'observe this' }], {
      apiKey: 'fixture-key', apiKeys: ['fixture-key'], model: 'fixture-model', fallbackModels: [], apiUrl: url,
    } as never, undefined, 5_000, budget);
  }
}

afterEach(() => { mock.restore(); });

describe('observer disable preserves spent-batch identity', () => {
  for (const boundary of ['route', 'iterator'] as const) {
    it(`does not resend old tool IDs after disable/re-enable at the ${boundary} boundary`, async () => {
      const enabled = SettingsDefaultsManager.getAllDefaults();
      const settings = spyOn(SettingsDefaultsManager, 'loadFromFile').mockReturnValue(enabled);
      for (const level of ['info', 'warn', 'error'] as const) spyOn(logger, level).mockImplementation(() => {});
      const manager = new SessionManager({
        getSessionById: () => ({ content_session_id: 'content-disabled', project: 'project', platform_source: 'claude',
          user_prompt: 'prompt', memory_session_id: null }),
        getSessionStore: () => ({ getPromptNumberFromUserPrompts: () => 1 }),
        getChromaSync: () => undefined,
      } as never);
      const session = manager.initializeSession(71, 'prompt', 1);
      const buffer = manager.getMessageBuffer();
      const enqueue = (toolUseId: string) => manager.queueObservation(71, {
        tool_name: 'Read', tool_input: {}, tool_response: {}, prompt_number: 1, toolUseId,
      });
      let sends = 0;
      const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() {
        sends++;
        return sends <= 2 ? new Response('ambiguous upstream failure', { status: 503 })
          : Response.json({ choices: [{ message: { content: '<observation/>' }, finish_reason: 'stop' }] });
      } });
      const provider = new LocalProvider({} as never, manager);
      try {
        const confirmed = enqueue('confirmed');
        expect(manager.claimNextObservation(71, () => true)?._persistentId).toBe(confirmed);
        await manager.confirmClaimedMessages(71);

        const paid = enqueue('paid');
        expect(manager.claimNextObservation(71, () => true)?._persistentId).toBe(paid);
        const budget = paidSendBudgetForClaimedBatch(session)!;
        await expect(provider.ask(server.url.href, budget)).rejects.toThrow();
        await expect(provider.ask(server.url.href, budget)).rejects.toThrow();
        expect(sends).toBe(2);
        expect(budget.hasRemainingPaidSend()).toBe(false);
        expect(manager.parkBatchOnSpentPaidSendBudget(session)).toEqual([paid]);
        await manager.resetProcessingToPending(71);

        const inflight = boundary === 'route' ? enqueue('inflight') : undefined;
        if (inflight) expect(manager.claimNextObservation(71, () => true)?._persistentId).toBe(inflight);
        enqueue('unsent');
        settings.mockReturnValue({ ...enabled, CLAUDE_MEM_OBSERVER_ENABLED: 'false' });
        if (boundary === 'route') {
          const routes = new SessionRoutes(manager, {} as never, {} as never, {} as never,
            {} as never, {} as never, {} as never, {} as never);
          await routes.ensureGeneratorRunning(71, 'observation');
          expect(buffer.getMessagesByIds(71, [inflight!])).toHaveLength(1);
          await manager.confirmClaimedMessages(71);
        } else {
          const iterator = manager.getMessageIterator(71);
          expect((await iterator.next()).done).toBe(true);
        }

        settings.mockReturnValue(enabled);
        expect(buffer.getPendingCount(71)).toBe(0);
        expect(enqueue('confirmed')).toBe(0);
        expect(enqueue('paid')).toBe(0);
        expect(enqueue('unsent')).toBe(0);
        if (inflight) expect(enqueue('inflight')).toBe(0);
        expect(manager.claimNextObservation(71, () => true)).toBeNull();
        expect(sends).toBe(2);

        const fresh = enqueue('fresh');
        expect(fresh).toBeGreaterThan(0);
        expect(manager.claimNextObservation(71, () => true)?._persistentId).toBe(fresh);
        const freshBudget = paidSendBudgetForClaimedBatch(session)!;
        expect(freshBudget).not.toBe(budget);
        expect((await provider.ask(server.url.href, freshBudget)).content).toBe('<observation/>');
        expect(sends).toBe(3);
      } finally { session.abortController.abort(); buffer.dispose(71); server.stop(true); }
    });
  }
});
