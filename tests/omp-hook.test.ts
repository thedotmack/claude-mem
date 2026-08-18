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
    await Promise.resolve();

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
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

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
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

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
});
