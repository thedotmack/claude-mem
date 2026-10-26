import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { OpenRouterProvider } from '../../src/services/worker/OpenRouterProvider.js';
import { ClassifiedProviderError } from '../../src/services/worker/provider-errors.js';
import {
  OBSERVER_UNHEALTHY_FAILURE_THRESHOLD,
  readObserverHealth,
  recordObserverFailure,
  renderObserverHealthWarning,
} from '../../src/shared/observer-health.js';
import type { ConversationMessage } from '../../src/services/worker-types.js';

// Expose the protected query() so a model-unavailable reply can be driven
// without the full session machinery.
class TestOpenRouterProvider extends OpenRouterProvider {
  run(history: ConversationMessage[], config: { apiKey: string; model: string; fallbackModels: string[]; apiUrl: string }) {
    return (this as any).query(history, config);
  }
}

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const RETIRED_MODEL = 'xiaomi/mimo-v2-flash:free';
// The exact reply the #3659 reporter's observer failed on, 184 times in a row.
const RETIRED_MODEL_MESSAGE = 'This model has been deprecated. It is recommended to migrate to xiaomi/mimo-v2.5';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('OpenRouter model unavailable (#3659)', () => {
  const provider = new TestOpenRouterProvider({} as any, {} as any);
  const history: ConversationMessage[] = [{ role: 'user', content: 'observe this' }];
  let fetchSpy: ReturnType<typeof spyOn> | undefined;
  let requestedModels: string[];

  function serve(response: () => Response): void {
    requestedModels = [];
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      requestedModels.push(JSON.parse(String((init as RequestInit).body)).model);
      return response();
    });
  }

  async function queryError(model: string): Promise<ClassifiedProviderError> {
    try {
      await provider.run(history, { apiKey: 'k', model, fallbackModels: [], apiUrl: OPENROUTER_URL });
    } catch (error) {
      expect(error).toBeInstanceOf(ClassifiedProviderError);
      return error as ClassifiedProviderError;
    }
    throw new Error('expected the query to reject');
  }

  afterEach(() => {
    fetchSpy?.mockRestore();
    fetchSpy = undefined;
  });

  it('fails once with a change-the-model remedy instead of retrying or switching models', async () => {
    serve(() => jsonResponse(404, { error: { message: RETIRED_MODEL_MESSAGE, code: 404 } }));

    const error = await queryError(RETIRED_MODEL);

    expect(error.kind).toBe('unrecoverable');
    expect(error.code).toBe('model_unavailable');
    expect(error.message).toContain('model unavailable (status 404)');
    expect(error.message).toContain('It is recommended to migrate to xiaomi/mimo-v2.5');
    expect(error.action).toContain('CLAUDE_MEM_OPENROUTER_MODEL');
    expect(error.url).toBe('https://openrouter.ai/models');
    // One request, for the model the user configured: nothing is retried and
    // no other model is silently substituted.
    expect(requestedModels).toEqual([RETIRED_MODEL]);
  });

  it('treats a deprecation inside a 200 error envelope the same way', async () => {
    serve(() => jsonResponse(200, { error: { message: RETIRED_MODEL_MESSAGE, code: 404 } }));

    const error = await queryError(RETIRED_MODEL);

    expect(error.code).toBe('model_unavailable');
    expect(requestedModels).toEqual([RETIRED_MODEL]);
  });

  it('treats an id that is not in the catalog the same way', async () => {
    serve(() => jsonResponse(400, { error: { message: 'vendor/typo-model is not a valid model ID', code: 400 } }));

    const error = await queryError('vendor/typo-model');

    expect(error.code).toBe('model_unavailable');
    expect(requestedModels).toEqual(['vendor/typo-model']);
  });

  describe('session-start warning', () => {
    let dataDir: string;

    beforeEach(() => {
      dataDir = mkdtempSync(join(tmpdir(), 'claude-mem-model-unavailable-'));
    });

    afterEach(() => {
      rmSync(dataDir, { recursive: true, force: true });
    });

    it('tells the user which setting to change instead of the checklist or a restart', async () => {
      serve(() => jsonResponse(404, { error: { message: RETIRED_MODEL_MESSAGE, code: 404 } }));
      const error = await queryError(RETIRED_MODEL);
      const healthPath = join(dataDir, 'observer-health.json');

      // SessionRoutes records every classified generator failure this way.
      for (let i = 0; i < OBSERVER_UNHEALTHY_FAILURE_THRESHOLD; i++) {
        recordObserverFailure('openrouter', {
          message: error.message,
          kind: error.kind,
          code: error.code,
          action: error.action,
          url: error.url,
          requestId: error.requestId,
        }, healthPath);
      }
      const warning = renderObserverHealthWarning(readObserverHealth(healthPath)!);

      expect(warning).toContain('Latest error: OpenRouter model unavailable (status 404): This model has been deprecated.');
      expect(warning).toContain('What to do: Set CLAUDE_MEM_OPENROUTER_MODEL in ~/.claude-mem/settings.json');
      expect(warning).toContain('Link: https://openrouter.ai/models');
      expect(warning).not.toContain('spend limit');
      // Every restarted generator asks for the same retired model, so the
      // warning must not send the user to the restart link.
      expect(warning).toContain('Restarting will NOT help here');
      expect(warning).not.toContain('Click to restart');
      expect(warning).not.toContain('npx claude-mem restart');
    });
  });
});
