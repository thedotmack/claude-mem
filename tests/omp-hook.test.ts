import { afterEach, describe, expect, it } from 'bun:test';
import registerClaudeMemHook from '../omp/hooks/claude-mem.ts';

type HookHandler = (...args: unknown[]) => unknown;

type CapturedRequest = {
  path: string;
  body: Record<string, unknown>;
};

function installFetchCapture(requests: CapturedRequest[]): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({
      path: new URL(String(input)).pathname,
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    });
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
}

// Flush every pending microtask. The compact/shutdown summaries are detached
// chains (void pendingInit.then(...) -> fetch -> .then), so counting individual
// `await Promise.resolve()` calls is fragile; this suite uses no wall-clock
// sleeps.
async function drainMicrotasks(): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    await Promise.resolve();
  }
}

// Same capture as installFetchCapture, except /api/sessions/init hangs until
// releaseInit() is called, so a test can observe exactly what the hook sends
// while session init is still in flight.
function installDeferredInitCapture(requests: CapturedRequest[]): { releaseInit: () => void } {
  let releaseInit = (): void => {};
  const initGate = new Promise<void>(resolve => {
    releaseInit = resolve;
  });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path === '/api/sessions/init') await initGate;
    requests.push({
      path,
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    });
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  return { releaseInit };
}

function registerHook(): Record<string, HookHandler> {
  const handlers: Record<string, HookHandler> = {};
  registerClaudeMemHook({
    on(event, handler) {
      handlers[event] = handler as HookHandler;
    },
  } as unknown as Parameters<typeof registerClaudeMemHook>[0]);
  return handlers;
}

describe('OMP Claude Mem hook', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('includes omp platformSource in the session shutdown summarize request', async () => {
    const requests: CapturedRequest[] = [];
    installFetchCapture(requests);
    const handlers = registerHook();

    await handlers.session_start?.();
    await handlers.before_agent_start?.(
      { prompt: 'test OMP shutdown summary' },
      { cwd: '/tmp/omp-hook-test' },
    );
    await handlers.session_shutdown?.();
    await drainMicrotasks();

    const summarize = requests.find(request => request.path === '/api/sessions/summarize');
    expect(summarize?.body).toMatchObject({
      contentSessionId: expect.stringMatching(/^omp-/),
      platformSource: 'omp',
    });
  });

  it('summarizes the previous session before rotating on compaction', async () => {
    const requests: CapturedRequest[] = [];
    installFetchCapture(requests);
    const handlers = registerHook();

    await handlers.session_start?.();
    await handlers.before_agent_start?.(
      { prompt: 'before compaction' },
      { cwd: '/tmp/omp-hook-compaction-test' },
    );
    await handlers.agent_end?.({
      messages: [{ role: 'assistant', content: 'precompact answer' }],
    });
    await handlers.session_compact?.();
    await handlers.before_agent_start?.(
      { prompt: 'after compaction' },
      { cwd: '/tmp/omp-hook-compaction-test' },
    );
    await handlers.session_shutdown?.();
    await drainMicrotasks();

    const initSessions = requests
      .filter(request => request.path === '/api/sessions/init')
      .map(request => String(request.body.contentSessionId))
      .sort();
    const summaries = requests.filter(request => request.path === '/api/sessions/summarize');
    const summarySessions = summaries
      .map(request => String(request.body.contentSessionId))
      .sort();

    expect(initSessions).toHaveLength(2);
    expect(summarySessions).toEqual(initSessions);
    expect(summaries.find(request => request.body.contentSessionId === initSessions[0])?.body).toMatchObject({
      last_assistant_message: 'precompact answer',
      platformSource: 'omp',
    });
  });

  it('finalizes only the pre-compaction session when compaction is followed directly by shutdown', async () => {
    const requests: CapturedRequest[] = [];
    installFetchCapture(requests);
    const handlers = registerHook();

    await handlers.session_start?.();
    await handlers.before_agent_start?.(
      { prompt: 'before compaction' },
      { cwd: '/tmp/omp-hook-compaction-shutdown-test' },
    );
    await handlers.agent_end?.({
      messages: [{ role: 'assistant', content: 'precompact answer' }],
    });
    await handlers.session_compact?.();
    await handlers.session_shutdown?.();
    await drainMicrotasks();

    const initSession = String(
      requests.find(request => request.path === '/api/sessions/init')?.body.contentSessionId,
    );
    const summaries = requests.filter(request => request.path === '/api/sessions/summarize');

    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.body).toMatchObject({
      contentSessionId: initSession,
      last_assistant_message: 'precompact answer',
      platformSource: 'omp',
    });
  });

  it('defers the shutdown summarize until session init has completed', async () => {
    const requests: CapturedRequest[] = [];
    const { releaseInit } = installDeferredInitCapture(requests);
    const handlers = registerHook();

    await handlers.session_start?.();
    await handlers.before_agent_start?.(
      { prompt: 'prompt that must reach the worker first' },
      { cwd: '/tmp/omp-hook-shutdown-init-race' },
    );
    await handlers.agent_end?.({
      messages: [{ role: 'assistant', content: 'shutdown answer' }],
    });
    await handlers.session_shutdown?.();
    await drainMicrotasks();

    // Init is still in flight, so nothing may have been sent to the worker yet:
    // a summarize arriving first makes the worker INSERT the sdk_sessions row
    // with an empty user_prompt.
    expect(requests.map(request => request.path)).toEqual([]);

    releaseInit();
    await drainMicrotasks();

    expect(requests.map(request => request.path)).toEqual([
      '/api/sessions/init',
      '/api/sessions/summarize',
    ]);
    expect(requests[1]?.body).toMatchObject({
      contentSessionId: String(requests[0]?.body.contentSessionId),
      last_assistant_message: 'shutdown answer',
      platformSource: 'omp',
    });
  });
});
