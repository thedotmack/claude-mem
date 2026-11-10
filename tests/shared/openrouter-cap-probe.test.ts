import { expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { clearKeyCooldown } from '../../src/shared/api-key-pool.js';
import { __setCmemCapProbePathForTests, cmemCapProbeAllowed } from '../../src/shared/cmem-cap-probe.js';
import { OpenRouterProvider } from '../../src/services/worker/OpenRouterProvider.js';

it('withholds the next gateway send after an allowance-exhausted response', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'openrouter-cap-probe-'));
  const originalFetch = globalThis.fetch;
  const apiKey = 'cm_pro_cap_probe_test';
  const apiUrl = 'https://cmem.ai/api/inference/v1/chat/completions';
  let sends = 0;
  __setCmemCapProbePathForTests(join(directory, 'cmem-cap-probe.json'));
  globalThis.fetch = (async (url) => {
    expect(url).toBe(apiUrl);
    sends += 1;
    return new Response(JSON.stringify({ error: { code: 'allowance_exhausted', message: 'Allowance spent' } }), {
      status: 402,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const provider = new OpenRouterProvider({} as never, {} as never);
    const query = () => (provider as any).query([{ role: 'user', content: 'remember this' }], {
      apiKey, model: 'test-model', fallbackModels: [], apiUrl,
    });
    expect(cmemCapProbeAllowed()).toBe(true);
    await expect(query()).rejects.toMatchObject({ kind: 'quota_exhausted', code: 'allowance_exhausted' });
    expect(sends).toBe(1);
    expect(cmemCapProbeAllowed()).toBe(false);

    await expect(query()).rejects.toMatchObject({ kind: 'quota_exhausted', code: 'allowance_exhausted' });
    expect(sends).toBe(1);
  } finally {
    globalThis.fetch = originalFetch;
    clearKeyCooldown('openrouter', apiKey);
    __setCmemCapProbePathForTests(null);
    rmSync(directory, { recursive: true, force: true });
  }
});
