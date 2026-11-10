import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createCore } from '../../src/integrations/opencode-plugin/core.js';
import { createV1Hooks } from '../../src/integrations/opencode-plugin/v1.js';

const originalFetch = globalThis.fetch;
const requestedDirectories: string[] = [];

beforeEach(() => {
  requestedDirectories.length = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const directory = new URL(String(input)).searchParams.get('cwd')!;
    requestedDirectories.push(directory);
    return new Response(`Memory for ${directory}`);
  }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = originalFetch; });

describe('OpenCode memory context checkout ownership', () => {
  it('keeps optional-session V1 system prompts in their own checkout', async () => {
    const alpha = createV1Hooks({ directory: '/projects/context-alpha' });
    const beta = createV1Hooks({ directory: '/projects/context-beta' });
    const alphaOutput = { system: [] as string[] };
    const betaOutput = { system: [] as string[] };

    // OpenCode V1 explicitly permits a system-transform call without a session ID.
    await alpha['experimental.chat.system.transform']({}, alphaOutput);
    await beta['experimental.chat.system.transform']({}, betaOutput);

    expect(alphaOutput.system).toEqual(['Memory for /projects/context-alpha']);
    expect(betaOutput.system).toEqual(['Memory for /projects/context-beta']);
    expect(requestedDirectories).toEqual(['/projects/context-alpha', '/projects/context-beta']);
  });

  it('shares in-flight context only within the same checkout and session', async () => {
    const alpha = createCore({ directory: '/projects/context-flight-alpha' });
    const beta = createCore({ directory: '/projects/context-flight-beta' });
    const results = await Promise.all([
      alpha.memoryContext('ses_shared_flight'),
      beta.memoryContext('ses_shared_flight'),
      alpha.memoryContext('ses_shared_flight'),
    ]);

    expect(results).toEqual([
      'Memory for /projects/context-flight-alpha',
      'Memory for /projects/context-flight-beta',
      'Memory for /projects/context-flight-alpha',
    ]);
    expect(requestedDirectories).toEqual(['/projects/context-flight-alpha', '/projects/context-flight-beta']);
  });

  for (const forget of ['forgetMemoryContext', 'forgetSession'] as const) {
    it(`${forget} refreshes only the calling checkout`, async () => {
      const directory = `/projects/context-forget-${forget}`;
      const alpha = createCore({ directory: `${directory}/alpha` });
      const beta = createCore({ directory: `${directory}/beta` });
      const sessionId = `ses_${forget}`;
      await alpha.memoryContext(sessionId);
      await beta.memoryContext(sessionId);

      alpha[forget](sessionId);
      await beta.memoryContext(sessionId);
      await alpha.memoryContext(sessionId);

      expect(requestedDirectories).toEqual([
        `${directory}/alpha`, `${directory}/beta`, `${directory}/alpha`,
      ]);
    });
  }
});
