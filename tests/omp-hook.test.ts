import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import registerClaudeMemHook from '../omp/hooks/claude-mem.ts';

type HookHandler = (...args: unknown[]) => unknown;

type CapturedRequest = {
  url: URL;
  path: string;
  body: Record<string, unknown>;
};

type Reply = { status?: number; body?: Record<string, unknown> };

// Records every request; `replyFor` decides the response per path (default 200 {}).
function installFetchCapture(
  requests: CapturedRequest[],
  replyFor: (path: string) => Reply = () => ({}),
): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push({
      url,
      path: url.pathname,
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    });
    const reply = replyFor(url.pathname);
    return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status ?? 200 });
  }) as typeof fetch;
}

// Flush every pending microtask. The compact/shutdown summaries are detached
// chains (void pendingInit.then(...) -> fetch -> .then), so counting individual
// `await Promise.resolve()` calls is fragile; this suite uses no wall-clock
// sleeps.
async function drainMicrotasks(): Promise<void> {
  for (let index = 0; index < 40; index += 1) {
    await Promise.resolve();
  }
}

// Same capture as installFetchCapture, except /api/sessions/init hangs until
// releaseInit() is called (then answers `initReply`), so a test can observe
// exactly what the hook sends while session init is still in flight.
function installDeferredInitCapture(
  requests: CapturedRequest[],
  initReply: Record<string, unknown> = {},
): { releaseInit: () => void } {
  let releaseInit = (): void => {};
  const initGate = new Promise<void>(resolve => {
    releaseInit = resolve;
  });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const isInit = url.pathname === '/api/sessions/init';
    if (isInit) await initGate;
    requests.push({
      url,
      path: url.pathname,
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    });
    return new Response(JSON.stringify(isInit ? initReply : {}), { status: 200 });
  }) as typeof fetch;
  return { releaseInit };
}

// Records each request as it is sent; each init reply is held until
// releaseNextInit() answers the oldest one still waiting.
function installHeldInitCapture(requests: CapturedRequest[]): { releaseNextInit: () => void } {
  const heldInits: Array<() => void> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push({
      url,
      path: url.pathname,
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    });
    if (url.pathname === '/api/sessions/init') await new Promise<void>(resolve => heldInits.push(resolve));
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  return { releaseNextInit: () => heldInits.shift()?.() };
}

// The breaker is module state: once its 30 s window has passed, one
// successful request closes it again for the tests that follow.
async function closeBreaker(handlers: Record<string, HookHandler>): Promise<void> {
  const afterTheBreakerWindow = Date.now() + 31_000;
  const nowSpy = spyOn(Date, 'now').mockReturnValue(afterTheBreakerWindow);
  globalThis.fetch = (async () => new Response('', { status: 200 })) as typeof fetch;
  await handlers.context?.({ messages: [] }, { cwd: '/tmp/omp-close-breaker' });
  nowSpy.mockRestore();
  await handlers.session_shutdown?.();
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

const ENV_KEYS = ['CLAUDE_MEM_DATA_DIR', 'CLAUDE_MEM_WORKER_PORT', 'CLAUDE_MEM_WORKER_HOST'] as const;

describe('OMP Claude Mem hook', () => {
  const originalFetch = globalThis.fetch;
  const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};
  let dataDir: string;

  beforeEach(() => {
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    // Each test reads settings.json from its own data dir.
    dataDir = mkdtempSync(join(tmpdir(), 'omp-hook-data-'));
    process.env.CLAUDE_MEM_DATA_DIR = dataDir;
    delete process.env.CLAUDE_MEM_WORKER_PORT;
    delete process.env.CLAUDE_MEM_WORKER_HOST;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    rmSync(dataDir, { recursive: true, force: true });
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

  it('sends the session cwd on init and leaves naming the project to the worker', async () => {
    const requests: CapturedRequest[] = [];
    installFetchCapture(requests);
    const handlers = registerHook();

    await handlers.session_start?.();
    await handlers.before_agent_start?.({ prompt: 'name my project' }, { cwd: 'C:\\work\\acme' });
    await drainMicrotasks();

    const init = requests.find(request => request.path === '/api/sessions/init');
    expect(init?.body).toMatchObject({ prompt: 'name my project', platformSource: 'omp', cwd: 'C:\\work\\acme' });
    expect(init?.body.project).toBeUndefined();
  });

  it('reads the worker port and host from settings.json', async () => {
    writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({
      CLAUDE_MEM_WORKER_PORT: '45678',
      CLAUDE_MEM_WORKER_HOST: '127.0.0.2',
    }));
    const requests: CapturedRequest[] = [];
    installFetchCapture(requests);
    const handlers = registerHook();

    await handlers.session_start?.();
    await handlers.before_agent_start?.({ prompt: 'p' }, { cwd: '/tmp/omp-port' });
    await drainMicrotasks();

    expect(requests[0]?.url.host).toBe('127.0.0.2:45678');
  });

  it('reads settings nested under env, and lets the environment win', async () => {
    writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({
      env: { CLAUDE_MEM_WORKER_PORT: '45679' },
    }));
    const requests: CapturedRequest[] = [];
    installFetchCapture(requests);
    const handlers = registerHook();

    await handlers.session_start?.();
    await handlers.before_agent_start?.({ prompt: 'p' }, { cwd: '/tmp/omp-port' });
    await drainMicrotasks();
    expect(requests[0]?.url.host).toBe('127.0.0.1:45679');

    process.env.CLAUDE_MEM_WORKER_PORT = '45680';
    await handlers.session_shutdown?.();
    await handlers.session_start?.();
    await handlers.before_agent_start?.({ prompt: 'p' }, { cwd: '/tmp/omp-port' });
    await drainMicrotasks();
    expect(requests.at(-1)?.url.host).toBe('127.0.0.1:45680');
  });

  it('does not finalize a session whose init failed', async () => {
    const requests: CapturedRequest[] = [];
    installFetchCapture(requests, path => (path === '/api/sessions/init' ? { status: 500 } : {}));
    const handlers = registerHook();

    await handlers.session_start?.();
    await handlers.before_agent_start?.({ prompt: 'worker is down' }, { cwd: '/tmp/omp-init-fails' });
    await handlers.session_shutdown?.();
    await drainMicrotasks();

    expect(requests.map(request => request.path)).toEqual(['/api/sessions/init']);
  });

  it('does not finalize a session the worker skipped for an excluded project', async () => {
    const requests: CapturedRequest[] = [];
    installFetchCapture(requests, path => (
      path === '/api/sessions/init' ? { body: { skipped: true, reason: 'project_excluded' } } : {}
    ));
    const handlers = registerHook();

    await handlers.session_start?.();
    await handlers.before_agent_start?.({ prompt: 'secret work' }, { cwd: '/tmp/omp-excluded' });
    await drainMicrotasks();
    // Once the worker says the checkout is excluded, nothing more is sent.
    await handlers.tool_result?.({ toolName: 'read', content: 'secret file' }, { cwd: '/tmp/omp-excluded' });
    await handlers.before_agent_start?.({ prompt: 'more secret work' }, { cwd: '/tmp/omp-excluded' });
    await handlers.session_shutdown?.();
    await drainMicrotasks();

    expect(requests.map(request => request.path)).toEqual(['/api/sessions/init']);
  });

  it('records every user prompt, not only the first (R5-6)', async () => {
    const requests: CapturedRequest[] = [];
    installFetchCapture(requests);
    const handlers = registerHook();

    await handlers.session_start?.();
    for (const prompt of ['first prompt', 'second prompt', 'third prompt']) {
      await handlers.before_agent_start?.({ prompt }, { cwd: '/tmp/omp-every-prompt' });
      await drainMicrotasks();
    }

    const inits = requests.filter(request => request.path === '/api/sessions/init');
    expect(inits.map(request => request.body.prompt)).toEqual(['first prompt', 'second prompt', 'third prompt']);
    expect(new Set(inits.map(request => request.body.contentSessionId)).size).toBe(1);
  });

  it('never inits from a tool result that arrives before a prompt (R5-6)', async () => {
    const requests: CapturedRequest[] = [];
    installFetchCapture(requests);
    const handlers = registerHook();

    await handlers.session_start?.();
    await handlers.tool_result?.(
      { toolName: 'read', input: { path: 'a.ts' }, content: 'file text' },
      { cwd: '/tmp/omp-tool-first' },
    );
    await drainMicrotasks();
    await handlers.before_agent_start?.({ prompt: 'the real prompt' }, { cwd: '/tmp/omp-tool-first' });
    await drainMicrotasks();

    // A prompt-less init would pin the session to "[media prompt]" and, being
    // the only init, keep the real prompt from ever being recorded.
    expect(requests.map(request => request.path)).toEqual(['/api/sessions/observations', '/api/sessions/init']);
    expect(requests[1]?.body).toMatchObject({
      contentSessionId: requests[0]?.body.contentSessionId,
      prompt: 'the real prompt',
    });
  });

  it('bounds every worker request with a timeout that counts as a breaker failure (R5-7)', async () => {
    // Every request's timeout has already elapsed: fetch rejects with the
    // signal's reason, as it does for a hung worker. A request with no signal
    // could never be cut short.
    const timeouts: number[] = [];
    const timeoutSpy = spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds: number) => {
      timeouts.push(milliseconds);
      return AbortSignal.abort(new DOMException('The operation timed out.', 'TimeoutError'));
    });
    const paths: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      paths.push(new URL(String(input)).pathname);
      throw init?.signal?.reason ?? new Error('unbounded request');
    }) as typeof fetch;
    const handlers = registerHook();
    const conversation = { messages: [{ role: 'user', content: 'hi' }] };
    const cwd = { cwd: '/tmp/omp-hung-worker' };

    try {
      await handlers.session_start?.();
      // A tool result before any prompt posts at once; the prompt's init and
      // the context fetch follow.
      await handlers.tool_result?.({ toolName: 'read', content: 'x' }, cwd);
      await drainMicrotasks();
      await handlers.before_agent_start?.({ prompt: 'p' }, cwd);
      await drainMicrotasks();
      expect(await handlers.context?.(conversation, cwd)).toBeUndefined();

      expect(paths).toEqual(['/api/sessions/observations', '/api/sessions/init', '/api/context/inject']);
      expect(timeouts).toEqual([5_000, 5_000, 5_000]);

      // Three timeouts opened the breaker: the next model call skips the worker.
      expect(await handlers.context?.(conversation, cwd)).toBeUndefined();
      expect(paths).toHaveLength(3);
    } finally {
      timeoutSpy.mockRestore();
      await closeBreaker(handlers);
    }
  });

  it('drops a tool result whose prompt the worker did not record', async () => {
    const requests: CapturedRequest[] = [];
    installFetchCapture(requests, path => (path === '/api/sessions/init' ? { status: 500 } : {}));
    const handlers = registerHook();
    const cwd = { cwd: '/tmp/omp-init-failed' };

    await handlers.session_start?.();
    await handlers.before_agent_start?.({ prompt: 'worker hiccup' }, cwd);
    await handlers.tool_result?.({ toolName: 'read', content: 'x' }, cwd);
    await drainMicrotasks();

    // Sent anyway, it would land under a prompt the worker never recorded.
    expect(requests.map(request => request.path)).toEqual(['/api/sessions/init']);
  });

  it('drops a tool result that was waiting on an init the worker excluded', async () => {
    const requests: CapturedRequest[] = [];
    const { releaseInit } = installDeferredInitCapture(requests, { skipped: true, reason: 'project_excluded' });
    const handlers = registerHook();
    const cwd = { cwd: '/tmp/omp-excluded-in-flight' };

    await handlers.session_start?.();
    await handlers.before_agent_start?.({ prompt: 'secret work' }, cwd);
    await handlers.tool_result?.({ toolName: 'read', content: 'secret file' }, cwd);
    releaseInit();
    await drainMicrotasks();

    expect(requests.map(request => request.path)).toEqual(['/api/sessions/init']);
  });

  it('records overlapping prompts in order and summarizes after both', async () => {
    const requests: CapturedRequest[] = [];
    const { releaseNextInit } = installHeldInitCapture(requests);
    const handlers = registerHook();
    const cwd = { cwd: '/tmp/omp-overlapping-prompts' };

    await handlers.session_start?.();
    await handlers.before_agent_start?.({ prompt: 'first' }, cwd);
    await handlers.before_agent_start?.({ prompt: 'second' }, cwd);
    await handlers.agent_end?.({ messages: [{ role: 'assistant', content: 'done' }] });
    await handlers.session_shutdown?.();
    await drainMicrotasks();

    // The second init waits for the first reply, so the worker can never
    // record the prompts out of order.
    expect(requests.map(request => request.body.prompt)).toEqual(['first']);

    releaseNextInit();
    await drainMicrotasks();
    releaseNextInit();
    await drainMicrotasks();

    expect(requests.map(request => request.path)).toEqual([
      '/api/sessions/init',
      '/api/sessions/init',
      '/api/sessions/summarize',
    ]);
    expect(requests.map(request => request.body.prompt)).toEqual(['first', 'second', undefined]);
  });

  it('counts an init whose reply never finishes as a failure', async () => {
    const paths: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      paths.push(new URL(String(input)).pathname);
      // Headers arrive, then the body fails, as when the timeout aborts it
      // mid-read.
      const stalledBody = new ReadableStream({
        start(controller) {
          controller.error(new DOMException('The operation timed out.', 'TimeoutError'));
        },
      });
      return new Response(stalledBody, { status: 200 });
    }) as typeof fetch;
    const handlers = registerHook();
    const cwd = { cwd: '/tmp/omp-stalled-reply' };

    try {
      await handlers.session_start?.();
      for (const prompt of ['one', 'two', 'three', 'four']) {
        await handlers.before_agent_start?.({ prompt }, cwd);
        await drainMicrotasks();
      }
      await handlers.session_shutdown?.();
      await drainMicrotasks();

      // Three failed inits opened the breaker before the fourth, and a session
      // with no recorded prompt is never summarized.
      expect(paths).toEqual(['/api/sessions/init', '/api/sessions/init', '/api/sessions/init']);
    } finally {
      await closeBreaker(handlers);
    }
  });

  it('asks the worker for context by cwd and keeps the conversation', async () => {
    const requests: CapturedRequest[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      requests.push({ url, path: url.pathname, body: {} });
      return new Response('# memory', { status: 200 });
    }) as typeof fetch;
    const handlers = registerHook();

    await handlers.session_start?.();
    const original = [{ role: 'user', content: 'hi' }];
    const result = await handlers.context?.({ messages: original }, { cwd: '/tmp/omp-context' }) as {
      messages: unknown[];
    };

    expect(requests[0]?.path).toBe('/api/context/inject');
    expect(requests[0]?.url.searchParams.get('cwd')).toBe('/tmp/omp-context');
    expect(requests[0]?.url.searchParams.get('projects')).toBeNull();
    expect(result.messages).toEqual([...original, { role: 'system', content: '# memory' }]);
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

    // Request order, not sort order: session ids are random, so only the order
    // the inits were sent in says which session came before the compaction.
    const initSessions = requests
      .filter(request => request.path === '/api/sessions/init')
      .map(request => String(request.body.contentSessionId));
    const summaries = requests.filter(request => request.path === '/api/sessions/summarize');
    const summarySessions = summaries
      .map(request => String(request.body.contentSessionId))
      .sort();

    expect(initSessions).toHaveLength(2);
    expect(new Set(initSessions).size).toBe(2);
    expect(summarySessions).toEqual([...initSessions].sort());
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

  it('keeps the session when OMP reloads the session file that is already open', async () => {
    const requests: CapturedRequest[] = [];
    installFetchCapture(requests);
    const handlers = registerHook();
    const cwd = '/owned/omp-reload';

    await handlers.session_start?.();
    await handlers.before_agent_start?.({ prompt: 'first' }, { cwd });
    await handlers.agent_end?.({ messages: [{ role: 'assistant', content: 'first answer' }] });
    await handlers.context?.({ messages: [] }, { cwd });
    // OMP's reload() calls switchSession(this.sessionFile): session_switch fires
    // with the open file as previousSessionFile, after the session manager
    // already points at that same file.
    await handlers.session_switch?.(
      { reason: 'resume', previousSessionFile: '/owned/s.jsonl' },
      { cwd, sessionManager: { getSessionFile: () => '/owned/s.jsonl' } },
    );
    await handlers.before_agent_start?.({ prompt: 'second' }, { cwd });
    await handlers.context?.({ messages: [] }, { cwd });
    await drainMicrotasks();

    const inits = requests.filter(request => request.path === '/api/sessions/init');
    expect(inits.map(request => request.body.prompt)).toEqual(['first', 'second']);
    expect(new Set(inits.map(request => request.body.contentSessionId)).size).toBe(1);
    expect(requests.filter(request => request.path === '/api/sessions/summarize')).toEqual([]);
    // Same session, same cwd: the cached context is still valid.
    expect(requests.filter(request => request.path === '/api/context/inject')).toHaveLength(1);
  });

  it('rotates the session when OMP switches to another session file', async () => {
    const requests: CapturedRequest[] = [];
    installFetchCapture(requests);
    const handlers = registerHook();
    const cwd = '/owned/omp-switch';

    await handlers.session_start?.();
    await handlers.before_agent_start?.({ prompt: 'first' }, { cwd });
    await handlers.agent_end?.({ messages: [{ role: 'assistant', content: 'first answer' }] });
    await handlers.session_switch?.(
      { reason: 'resume', previousSessionFile: '/owned/s.jsonl' },
      { cwd, sessionManager: { getSessionFile: () => '/owned/other.jsonl' } },
    );
    await handlers.before_agent_start?.({ prompt: 'second' }, { cwd });
    await drainMicrotasks();

    const inits = requests.filter(request => request.path === '/api/sessions/init');
    const [firstId, secondId] = inits.map(request => request.body.contentSessionId);
    expect(inits.map(request => request.body.prompt)).toEqual(['first', 'second']);
    expect(firstId).not.toBe(secondId);
    const summaries = requests.filter(request => request.path === '/api/sessions/summarize');
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.body).toMatchObject({
      contentSessionId: firstId,
      last_assistant_message: 'first answer',
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

  it('installs into the agent dir OMP reads, honouring PI_CODING_AGENT_DIR', async () => {
    const agentDir = mkdtempSync(join(tmpdir(), 'omp-agent-dir-'));
    const saved = { agent: process.env.PI_CODING_AGENT_DIR, dev: process.env.CLAUDE_MEM_DEV_HOOK_SOURCE };
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.CLAUDE_MEM_DEV_HOOK_SOURCE = '1'; // resolve the hook from this checkout
    try {
      const { installOmpHooks, uninstallOmpHooks } = await import('../src/services/integrations/OmpHooksInstaller.js');
      const destination = join(agentDir, 'hooks', 'pre', 'claude-mem.ts');

      expect(await installOmpHooks()).toBe(0);
      expect(readFileSync(destination, 'utf-8')).toContain('export default function claudeMemBridge');
      expect(uninstallOmpHooks()).toBe(0);
      expect(existsSync(destination)).toBe(false);
    } finally {
      if (saved.agent === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = saved.agent;
      if (saved.dev === undefined) delete process.env.CLAUDE_MEM_DEV_HOOK_SOURCE;
      else process.env.CLAUDE_MEM_DEV_HOOK_SOURCE = saved.dev;
      rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it('registers only events the OMP HookAPI emits', () => {
    const fixture = JSON.parse(
      readFileSync(join(import.meta.dir, 'fixtures', 'hosts', 'omp-hookapi.json'), 'utf-8'),
    ) as { events: string[] };
    const registered = Object.keys(registerHook());

    expect(registered.length).toBeGreaterThan(0);
    for (const event of registered) {
      expect(fixture.events).toContain(event);
    }
  });
});
