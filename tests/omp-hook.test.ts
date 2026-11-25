import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { homedir, tmpdir } from 'os';
import { basename, join } from 'path';
import registerClaudeMemHook from '../omp/hooks/claude-mem.ts';
import { getDefaultWorkerPort } from '../src/shared/install-port.js';

type HookHandler = (...args: unknown[]) => unknown;

type CapturedRequest = {
  url: URL;
  path: string;
  method: string;
  headers: Headers;
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
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
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
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
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
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
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

const ENV_KEYS = [
  'CLAUDE_MEM_DATA_DIR', 'CLAUDE_MEM_WORKER_PORT', 'CLAUDE_MEM_WORKER_HOST',
  'CLAUDE_MEM_SESSION_START_INCLUDE_ALL_SOURCES',
  'CLAUDE_MEM_RUNTIME',
  'CLAUDE_MEM_SERVER_URL', 'CLAUDE_MEM_SERVER_API_KEY', 'CLAUDE_MEM_SERVER_PROJECT_ID',
  'CLAUDE_MEM_SERVER_BETA_URL', 'CLAUDE_MEM_SERVER_BETA_API_KEY', 'CLAUDE_MEM_SERVER_BETA_PROJECT_ID',
  'CLAUDE_MEM_EXCLUDED_PROJECTS', 'CLAUDE_MEM_SKIP_TOOLS', 'CLAUDE_MEM_INTERNAL',
] as const;

describe('OMP Claude Mem hook', () => {
  const originalFetch = globalThis.fetch;
  const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};
  let dataDir: string;

  beforeEach(() => {
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    // Each test reads settings.json from its own data dir.
    dataDir = mkdtempSync(join(tmpdir(), 'omp-hook-data-'));
    process.env.CLAUDE_MEM_DATA_DIR = dataDir;
    for (const key of ENV_KEYS) {
      if (key !== 'CLAUDE_MEM_DATA_DIR') delete process.env[key];
    }
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    rmSync(dataDir, { recursive: true, force: true });
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

  it('reads a numeric worker port from settings.json', async () => {
    writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ CLAUDE_MEM_WORKER_PORT: 45678 }));
    const requests: CapturedRequest[] = [];
    installFetchCapture(requests);
    const handlers = registerHook();

    await handlers.session_start?.();
    await handlers.before_agent_start?.({ prompt: 'p' }, { cwd: '/tmp/omp-port' });
    await drainMicrotasks();

    expect(requests[0]?.url.host).toBe('127.0.0.1:45678');
  });

  it('reads settings.json from a ~ data folder, as the worker does', async () => {
    const homeDataDir = mkdtempSync(join(homedir(), '.omp-hook-tilde-'));
    try {
      writeFileSync(join(homeDataDir, 'settings.json'), JSON.stringify({ CLAUDE_MEM_WORKER_PORT: 45679 }));
      process.env.CLAUDE_MEM_DATA_DIR = `~/${basename(homeDataDir)}`;
      const requests: CapturedRequest[] = [];
      installFetchCapture(requests);
      const handlers = registerHook();

      await handlers.session_start?.();
      await handlers.before_agent_start?.({ prompt: 'p' }, { cwd: '/tmp/omp-port' });
      await drainMicrotasks();

      expect(requests[0]?.url.host).toBe('127.0.0.1:45679');
    } finally {
      rmSync(homeDataDir, { recursive: true, force: true });
    }
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

  it('defaults to the port the worker picks when there is no user id, as on Windows (#6477)', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const getuid = Object.getOwnPropertyDescriptor(process, 'getuid');
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    Object.defineProperty(process, 'getuid', { value: undefined, configurable: true, writable: true });
    try {
      const requests: CapturedRequest[] = [];
      installFetchCapture(requests);
      const handlers = registerHook();

      await handlers.session_start?.();
      await handlers.before_agent_start?.({ prompt: 'p' }, { cwd: '/tmp/omp-port' });
      await drainMicrotasks();

      const port = getDefaultWorkerPort(dataDir, { platform: 'win32', uid: null });
      expect(requests[0]?.url.host).toBe(`127.0.0.1:${port}`);
    } finally {
      Object.defineProperty(process, 'platform', platform);
      if (getuid) Object.defineProperty(process, 'getuid', getuid);
    }
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

  it('strips nested and cap-straddling private blocks from tool results before the cap', async () => {
    const requests: CapturedRequest[] = [];
    installFetchCapture(requests);
    const handlers = registerHook();
    const cwd = { cwd: '/tmp/omp-private-strip' };

    await handlers.session_start?.();
    // Nested same-name blocks: a lazy regex pairs the outer opener with the
    // inner closer and leaves `SECRET</private>` behind.
    await handlers.tool_result?.(
      { toolName: 'read', content: 'before <private>outer<private>inner</private>SECRET</private> after' },
      cwd,
    );
    // A block whose closer sits past the 1,000-char cap: capping first would
    // sever `</private>` and ship the private prefix unbalanced.
    await handlers.tool_result?.(
      { toolName: 'read', content: `${'a'.repeat(990)}<private>${'TOKEN'.repeat(10)}</private>tail` },
      cwd,
    );
    await drainMicrotasks();

    const responses = requests
      .filter(request => request.path === '/api/sessions/observations')
      .map(request => String(request.body.tool_response));
    expect(responses).toEqual(['before  after', `${'a'.repeat(990)}tail`]);
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

  it('keeps live prompt and tool timestamps from before their queued delivery', async () => {
    const requests: CapturedRequest[] = [];
    const { releaseNextInit } = installHeldInitCapture(requests);
    const handlers = registerHook();
    const cwd = { cwd: '/tmp/omp-telemetry-time' };
    const at = Date.now();
    const clock = spyOn(Date, 'now').mockReturnValue(at);
    try {
      await handlers.session_start?.();
      await handlers.before_agent_start?.({ prompt: 'first' }, cwd);
      clock.mockReturnValue(at + 10);
      await handlers.before_agent_start?.({ prompt: 'second' }, cwd);
      clock.mockReturnValue(at + 20);
      await handlers.tool_result?.({ toolName: 'read', content: 'result' }, cwd);
      await drainMicrotasks();
      clock.mockReturnValue(at + 1000);
      releaseNextInit();
      await drainMicrotasks();
      releaseNextInit();
      await drainMicrotasks();
      const inits = requests.filter(request => request.path === '/api/sessions/init');
      expect(inits.map(request => request.body.telemetryPromptEpochMs)).toEqual([at, at + 10]);
      const tool = requests.find(request => request.path === '/api/sessions/observations');
      expect(tool?.body.telemetryToolEpochMs).toBe(at + 20);
      expect(tool?.body.tool_use_id).toBeUndefined();
    } finally { clock.mockRestore(); }
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

  it('adds transient historical context without mutating or replacing the conversation', async () => {
    const requests: CapturedRequest[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      requests.push({ url, path: url.pathname, method: init?.method ?? 'GET', headers: new Headers(init?.headers), body: {} });
      return new Response('# memory', { status: 200 });
    }) as typeof fetch;
    const handlers = registerHook();

    await handlers.session_start?.();
    const original = Object.freeze([
      Object.freeze({ role: 'user', content: 'current request' }),
      Object.freeze({ role: 'assistant', content: 'earlier answer' }),
    ]);
    const event = { messages: original };
    const result = await handlers.context?.(event, { cwd: '/tmp/omp-context' }) as {
      messages: unknown[];
    };
    const again = await handlers.context?.(event, { cwd: '/tmp/omp-context' }) as typeof result;

    expect(requests).toHaveLength(1);
    expect(requests[0]?.path).toBe('/api/context/inject');
    expect(requests[0]?.url.searchParams.get('cwd')).toBe('/tmp/omp-context');
    expect(requests[0]?.url.searchParams.get('projects')).toBeNull();
    expect(requests[0]?.url.searchParams.get('platformSource')).toBe('omp');
    for (const response of [result, again]) {
      expect(response.messages).toHaveLength(original.length + 1);
      expect(response.messages[0]).toBe(original[0]);
      expect(response.messages[1]).toBe(original[1]);
      expect(response.messages.at(-1)).toEqual({
        role: 'custom',
        customType: 'claude-mem:context',
        content: expect.stringContaining('# memory'),
        display: false,
        attribution: 'agent',
        timestamp: expect.any(Number),
      });
    }
    // The callback only returns a request-local view; cached recall must not
    // accumulate in the event OMP owns or replace any existing conversation.
    expect(event.messages).toBe(original);
    expect(original).toHaveLength(2);
    await handlers.session_shutdown?.();
  });

  for (const { label, fileValue, nested, envValue, expectedSource } of [
    { label: 'default', expectedSource: 'omp' },
    { label: 'disabled in settings', fileValue: 'false', expectedSource: 'omp' },
    { label: 'enabled in settings', fileValue: 'true', expectedSource: null },
    { label: 'enabled as a boolean in settings', fileValue: true, expectedSource: null },
    { label: 'enabled under env in settings', fileValue: 'true', nested: true, expectedSource: null },
    { label: 'environment disables file policy', fileValue: 'true', envValue: 'false', expectedSource: 'omp' },
    { label: 'environment enables file policy', fileValue: 'false', envValue: 'true', expectedSource: null },
    { label: 'empty environment overrides enabled file policy', fileValue: 'true', envValue: '', expectedSource: 'omp' },
  ]) {
    it(`honours the all-sources context policy: ${label}`, async () => {
      if (fileValue !== undefined) {
        const policy = { CLAUDE_MEM_SESSION_START_INCLUDE_ALL_SOURCES: fileValue };
        writeFileSync(join(dataDir, 'settings.json'), JSON.stringify(nested ? { env: policy } : policy));
      }
      if (envValue !== undefined) process.env.CLAUDE_MEM_SESSION_START_INCLUDE_ALL_SOURCES = envValue;
      const requests: CapturedRequest[] = [];
      installFetchCapture(requests);
      const handlers = registerHook();
      const cwd = '/tmp/omp policy & project';

      await handlers.session_start?.();
      await handlers.context?.({ messages: [] }, { cwd });
      await handlers.before_agent_start?.({ prompt: 'a real current prompt' }, { cwd });
      await drainMicrotasks();
      await handlers.session_shutdown?.();
      await drainMicrotasks();

      const context = requests.find(request => request.path === '/api/context/inject');
      expect(context?.url.searchParams.get('platformSource')).toBe(expectedSource);
      expect(context?.url.searchParams.get('cwd')).toBe(cwd);
      expect(context?.url.searchParams.get('projects')).toBeNull();
      expect(requests.find(request => request.path === '/api/sessions/init')?.body).toMatchObject({
        cwd, platformSource: 'omp', prompt: 'a real current prompt',
      });
    });
  }

  for (const initialAllSources of [true, false]) {
    it(`refreshes same-cwd recall immediately when all-sources changes from ${initialAllSources}`, async () => {
      const settingsPath = join(dataDir, 'settings.json');
      writeFileSync(settingsPath, JSON.stringify({
        CLAUDE_MEM_SESSION_START_INCLUDE_ALL_SOURCES: initialAllSources,
      }));
      const requests: URL[] = [];
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        requests.push(url);
        return new Response(url.searchParams.get('platformSource') === 'omp'
          ? 'OWNHOST-RECALL' : 'OTHERHOST-RECALL', { status: 200 });
      }) as typeof fetch;
      const handlers = registerHook();
      const cwd = '/tmp/omp-same-project-policy';
      const original = Object.freeze([Object.freeze({ role: 'user', content: 'current request' })]);
      const nowSpy = spyOn(Date, 'now').mockReturnValue(Date.now());

      try {
        await handlers.session_start?.();
        const before = await handlers.context?.({ messages: original }, { cwd }) as {
          messages: Array<{ content: string }>;
        };
        writeFileSync(settingsPath, JSON.stringify({
          CLAUDE_MEM_SESSION_START_INCLUDE_ALL_SOURCES: !initialAllSources,
        }));
        const after = await handlers.context?.({ messages: original }, { cwd }) as typeof before;

        expect(before.messages.at(-1)?.content).toContain(initialAllSources ? 'OTHERHOST-RECALL' : 'OWNHOST-RECALL');
        expect(after.messages.at(-1)?.content).toContain(initialAllSources ? 'OWNHOST-RECALL' : 'OTHERHOST-RECALL');
        expect(after.messages.at(-1)?.content).not.toContain(initialAllSources ? 'OTHERHOST-RECALL' : 'OWNHOST-RECALL');
        expect(requests.map(url => url.searchParams.get('platformSource'))).toEqual(
          initialAllSources ? [null, 'omp'] : ['omp', null],
        );
        expect(requests.every(url => url.searchParams.get('cwd') === cwd)).toBe(true);
        expect(before.messages[0]).toBe(original[0]);
        expect(after.messages[0]).toBe(original[0]);
        expect(original).toHaveLength(1);
      } finally {
        nowSpy.mockRestore();
        await handlers.session_shutdown?.();
      }
    });
  }

  it('does not reuse another cwd memory when the next project has none', async () => {
    process.env.CLAUDE_MEM_SESSION_START_INCLUDE_ALL_SOURCES = 'true';
    const requests: URL[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      requests.push(url);
      return new Response(requests.length === 1 ? 'first project memory' : '', { status: 200 });
    }) as typeof fetch;
    const handlers = registerHook();
    const original = [{ role: 'user', content: 'current project question' }];

    await handlers.session_start?.();
    expect(await handlers.context?.({ messages: original }, { cwd: '/tmp/omp-project-a' })).toBeDefined();
    expect(await handlers.context?.({ messages: original }, { cwd: '/tmp/omp-project-b' })).toBeUndefined();
    expect(requests.map(url => url.searchParams.get('cwd'))).toEqual([
      '/tmp/omp-project-a', '/tmp/omp-project-b',
    ]);
    expect(requests.every(url => !url.searchParams.has('platformSource'))).toBe(true);
    expect(original).toEqual([{ role: 'user', content: 'current project question' }]);
    await handlers.session_shutdown?.();
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
    expect(handlers.session_branch).toBe(handlers.session_switch);

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
    const saved = { agent: process.env.PI_CODING_AGENT_DIR, dev: process.env.CLAUDE_MEM_DEV_HOOK_SOURCE, profile: process.env.OMP_PROFILE };
    process.env.OMP_PROFILE = ''; // keep a caller's named profile outside this fixture
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
      if (saved.profile === undefined) delete process.env.OMP_PROFILE;
      else process.env.OMP_PROFILE = saved.profile;
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

  describe('server runtime (CLAUDE_MEM_RUNTIME=server)', () => {
    it('routes session start, tool events, context, and session end to /v1 with bearer auth', async () => {
      writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({
        CLAUDE_MEM_RUNTIME: 'server',
        CLAUDE_MEM_SERVER_URL: 'https://mem.example.com/',
        CLAUDE_MEM_SERVER_API_KEY: 'cmem_secret_key',
        CLAUDE_MEM_SERVER_PROJECT_ID: 'proj-123',
      }));
      const requests: CapturedRequest[] = [];
      installFetchCapture(requests, path => {
        if (path === '/v1/sessions/start') {
          return { status: 201, body: { session: { id: 'srv-sess-1', projectId: 'proj-123' } } };
        }
        if (path === '/v1/context') {
          return { status: 200, body: { observations: [], context: '# shared server memory' } };
        }
        return { status: 200, body: {} };
      });
      const handlers = registerHook();
      const cwd = '/work/acme';

      await handlers.session_start?.();
      const ctxResult = await handlers.context?.(
        { messages: [{ role: 'user', content: 'hi' }] },
        { cwd },
      ) as { messages: Array<{ role: string; customType?: string; content: string }> };
      await handlers.before_agent_start?.(
        { prompt: 'fix <private>secret</private> bug' },
        { cwd },
      );
      await handlers.tool_result?.(
        {
          toolName: 'read',
          toolCallId: 'call-42',
          input: { path: 'a.ts', note: 'keep <private>hidden</private> ok' },
          content: 'file contents',
        },
        { cwd },
      );
      await handlers.agent_end?.({
        messages: [{ role: 'assistant', content: 'fixed <private>token</private> it' }],
      });
      await handlers.session_shutdown?.();
      await drainMicrotasks();

      expect(requests.map(r => `${r.method} ${r.url.origin}${r.path}`)).toEqual([
        'POST https://mem.example.com/v1/context',
        'POST https://mem.example.com/v1/sessions/start',
        'POST https://mem.example.com/v1/events',
        'POST https://mem.example.com/v1/events',
        'POST https://mem.example.com/v1/events',
        'POST https://mem.example.com/v1/sessions/srv-sess-1/end',
      ]);
      for (const req of requests) {
        expect(req.headers.get('authorization')).toBe('Bearer cmem_secret_key');
      }

      // Context request & injection
      expect(requests[0]?.body).toEqual({
        projectId: 'proj-123',
        platformSource: 'omp',
        folderProjects: ['acme'],
      });
      expect(ctxResult.messages.at(-1)?.content).toContain('# shared server memory');

      // Session start request
      const contentSessionId = String(requests[1]?.body.contentSessionId);
      expect(contentSessionId).toMatch(/^omp-/);
      expect(requests[1]?.body).toEqual({
        projectId: 'proj-123',
        externalSessionId: contentSessionId,
        contentSessionId,
        platformSource: 'omp',
        metadata: {
          prompt: 'fix  bug',
          cwd,
          project: 'acme',
        },
      });

      // Every prompt is also its own event, recorded without inference
      expect(requests[2]?.url.searchParams.get('generate')).toBe('false');
      expect(requests[2]?.body).toEqual({
        projectId: 'proj-123',
        serverSessionId: 'srv-sess-1',
        contentSessionId,
        platformSource: 'omp',
        sourceType: 'hook',
        eventType: 'user_prompt',
        occurredAtEpoch: expect.any(Number),
        payload: { prompt: 'fix  bug', cwd, platformSource: 'omp' },
      });

      // Tool event request
      expect(requests[3]?.url.searchParams.get('generate')).toBeNull();
      expect(requests[3]?.body).toMatchObject({
        projectId: 'proj-123',
        serverSessionId: 'srv-sess-1',
        contentSessionId,
        platformSource: 'omp',
        sourceType: 'hook',
        eventType: 'tool_use',
        occurredAtEpoch: expect.any(Number),
        payload: {
          tool_name: 'Read',
          tool_input: { path: 'a.ts', note: 'keep  ok' },
          tool_response: 'file contents',
          platformSource: 'omp',
          cwd,
          tool_use_id: 'call-42',
        },
      });

      // Assistant message event before session end
      expect(requests[4]?.body).toMatchObject({
        projectId: 'proj-123',
        serverSessionId: 'srv-sess-1',
        contentSessionId,
        platformSource: 'omp',
        sourceType: 'hook',
        eventType: 'assistant_message',
        occurredAtEpoch: expect.any(Number),
        payload: {
          last_assistant_message: 'fixed  it',
          platformSource: 'omp',
        },
      });

      // End session request
      expect(requests[5]?.body).toEqual({});
    });

    it('accepts legacy server-beta runtime and CLAUDE_MEM_SERVER_BETA_* settings when canonical keys are empty', async () => {
      writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({
        env: {
          CLAUDE_MEM_RUNTIME: 'server-beta',
          CLAUDE_MEM_SERVER_URL: '',
          CLAUDE_MEM_SERVER_API_KEY: '',
          CLAUDE_MEM_SERVER_PROJECT_ID: '',
          CLAUDE_MEM_SERVER_BETA_URL: 'http://127.0.0.1:37877',
          CLAUDE_MEM_SERVER_BETA_API_KEY: 'beta-key',
          CLAUDE_MEM_SERVER_BETA_PROJECT_ID: 'beta-proj',
        },
      }));
      const requests: CapturedRequest[] = [];
      installFetchCapture(requests, path => (
        path === '/v1/sessions/start'
          ? { body: { session: { id: 'srv-beta-1' } } }
          : {}
      ));
      const handlers = registerHook();

      await handlers.session_start?.();
      await handlers.before_agent_start?.({ prompt: 'hello' }, { cwd: '/tmp/repo' });
      await drainMicrotasks();

      expect(requests.map(r => r.path)).toEqual(['/v1/sessions/start', '/v1/events']);
      expect(requests[0]?.url.origin).toBe('http://127.0.0.1:37877');
      expect(requests[0]?.path).toBe('/v1/sessions/start');
      expect(requests[0]?.headers.get('authorization')).toBe('Bearer beta-key');
      expect(requests[0]?.body.projectId).toBe('beta-proj');
    });

    for (const missing of ['CLAUDE_MEM_SERVER_URL', 'CLAUDE_MEM_SERVER_API_KEY', 'CLAUDE_MEM_SERVER_PROJECT_ID'] as const) {
      it(`falls back to the local worker when ${missing} is missing`, async () => {
        const cfg: Record<string, string> = {
          CLAUDE_MEM_RUNTIME: 'server',
          CLAUDE_MEM_SERVER_URL: 'https://mem.example.com',
          CLAUDE_MEM_SERVER_API_KEY: 'cmem_secret_key',
          CLAUDE_MEM_SERVER_PROJECT_ID: 'proj-123',
          CLAUDE_MEM_WORKER_PORT: '45681',
        };
        delete cfg[missing];
        writeFileSync(join(dataDir, 'settings.json'), JSON.stringify(cfg));
        const requests: CapturedRequest[] = [];
        installFetchCapture(requests);
        const handlers = registerHook();

        await handlers.session_start?.();
        await handlers.before_agent_start?.({ prompt: 'fallback' }, { cwd: '/tmp/fallback' });
        await drainMicrotasks();

        expect(requests).toHaveLength(1);
        expect(requests[0]?.url.host).toBe('127.0.0.1:45681');
        expect(requests[0]?.path).toBe('/api/sessions/init');
        expect(requests[0]?.headers.get('authorization')).toBeNull();
      });
    }

    it('lets environment variables override settings.json for runtime selection', async () => {
      writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({
        CLAUDE_MEM_RUNTIME: 'server',
        CLAUDE_MEM_SERVER_URL: 'https://mem.example.com',
        CLAUDE_MEM_SERVER_API_KEY: 'cmem_secret_key',
        CLAUDE_MEM_SERVER_PROJECT_ID: 'proj-123',
        CLAUDE_MEM_WORKER_PORT: '45682',
      }));
      process.env.CLAUDE_MEM_RUNTIME = 'worker';
      const requests: CapturedRequest[] = [];
      installFetchCapture(requests);
      const handlers = registerHook();

      await handlers.session_start?.();
      await handlers.before_agent_start?.({ prompt: 'use worker' }, { cwd: '/tmp/env-override' });
      await drainMicrotasks();

      expect(requests[0]?.path).toBe('/api/sessions/init');
      expect(requests[0]?.url.host).toBe('127.0.0.1:45682');
    });

    it('omits platformSource from /v1/context when CLAUDE_MEM_SESSION_START_INCLUDE_ALL_SOURCES=true', async () => {
      writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({
        CLAUDE_MEM_RUNTIME: 'server',
        CLAUDE_MEM_SERVER_URL: 'https://mem.example.com',
        CLAUDE_MEM_SERVER_API_KEY: 'cmem_secret_key',
        CLAUDE_MEM_SERVER_PROJECT_ID: 'proj-123',
        CLAUDE_MEM_SESSION_START_INCLUDE_ALL_SOURCES: 'true',
      }));
      const requests: CapturedRequest[] = [];
      installFetchCapture(requests, () => ({ body: { observations: [], context: 'all-host memory' } }));
      const handlers = registerHook();

      await handlers.session_start?.();
      await handlers.context?.({ messages: [] }, { cwd: '/work/acme' });

      expect(requests[0]?.path).toBe('/v1/context');
      expect(requests[0]?.body).toEqual({
        projectId: 'proj-123',
        folderProjects: ['acme'],
      });
    });

    it('does not finalize a server session when /v1/sessions/start fails', async () => {
      writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({
        CLAUDE_MEM_RUNTIME: 'server',
        CLAUDE_MEM_SERVER_URL: 'https://mem.example.com',
        CLAUDE_MEM_SERVER_API_KEY: 'cmem_secret_key',
        CLAUDE_MEM_SERVER_PROJECT_ID: 'proj-123',
      }));
      const requests: CapturedRequest[] = [];
      installFetchCapture(requests, path => (
        path === '/v1/sessions/start' ? { status: 503 } : {}
      ));
      const handlers = registerHook();

      await handlers.session_start?.();
      await handlers.before_agent_start?.({ prompt: 'server down' }, { cwd: '/tmp/srv-fail' });
      await handlers.tool_result?.({ toolName: 'read', content: 'x' }, { cwd: '/tmp/srv-fail' });
      await handlers.session_shutdown?.();
      await drainMicrotasks();

      expect(requests.map(r => r.path)).toEqual(['/v1/sessions/start']);
    });

    it('finalizes the previous server session and rotates on compaction', async () => {
      writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({
        CLAUDE_MEM_RUNTIME: 'server',
        CLAUDE_MEM_SERVER_URL: 'https://mem.example.com',
        CLAUDE_MEM_SERVER_API_KEY: 'cmem_secret_key',
        CLAUDE_MEM_SERVER_PROJECT_ID: 'proj-123',
      }));
      let nextServerId = 0;
      const requests: CapturedRequest[] = [];
      installFetchCapture(requests, path => {
        if (path === '/v1/sessions/start') {
          nextServerId += 1;
          return { status: 201, body: { session: { id: `srv-compact-${nextServerId}` } } };
        }
        return { status: 200, body: {} };
      });
      const handlers = registerHook();

      await handlers.session_start?.();
      await handlers.before_agent_start?.({ prompt: 'before compact' }, { cwd: '/work/acme' });
      await handlers.agent_end?.({ messages: [{ role: 'assistant', content: 'pre-compact reply' }] });
      await handlers.session_compact?.();
      await handlers.before_agent_start?.({ prompt: 'after compact' }, { cwd: '/work/acme' });
      await handlers.session_shutdown?.();
      await drainMicrotasks();

      const ends = requests.filter(r => r.path.endsWith('/end')).map(r => r.path).sort();
      expect(ends).toEqual([
        '/v1/sessions/srv-compact-1/end',
        '/v1/sessions/srv-compact-2/end',
      ]);
      const assistantEvents = requests.filter(r => r.path === '/v1/events' && r.body.eventType === 'assistant_message');
      expect(assistantEvents).toHaveLength(1);
      expect(assistantEvents[0]?.body).toMatchObject({
        serverSessionId: 'srv-compact-1',
        payload: { last_assistant_message: 'pre-compact reply', platformSource: 'omp' },
      });
    });

    // Server events never pass through the worker's ingest gates, so the hook
    // applies them itself (#6367 review).
    function writeServerSettings(extra: Record<string, string> = {}): void {
      writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({
        CLAUDE_MEM_RUNTIME: 'server',
        CLAUDE_MEM_SERVER_URL: 'https://mem.example.com',
        CLAUDE_MEM_SERVER_API_KEY: 'cmem_secret_key',
        CLAUDE_MEM_SERVER_PROJECT_ID: 'proj-123',
        ...extra,
      }));
    }

    function installServerCapture(requests: CapturedRequest[]): void {
      installFetchCapture(requests, path => {
        if (path === '/v1/sessions/start') return { status: 201, body: { session: { id: 'srv-gate-1' } } };
        if (path === '/v1/context') return { body: { context: '# memory' } };
        return {};
      });
    }

    for (const [label, configure] of [
      ['a CLAUDE_MEM_EXCLUDED_PROJECTS glob in settings.json', () => writeServerSettings({ CLAUDE_MEM_EXCLUDED_PROJECTS: '/work/private/**' })],
      ['a folder-name pattern in the environment', () => {
        writeServerSettings({ CLAUDE_MEM_EXCLUDED_PROJECTS: 'nothing-matches' });
        process.env.CLAUDE_MEM_EXCLUDED_PROJECTS = 'secret-*';
      }],
      ['CLAUDE_MEM_INTERNAL=1', () => {
        writeServerSettings();
        process.env.CLAUDE_MEM_INTERNAL = '1';
      }],
    ] as const) {
      it(`sends nothing to the server for an excluded checkout (${label})`, async () => {
        configure();
        const requests: CapturedRequest[] = [];
        installServerCapture(requests);
        const handlers = registerHook();
        const cwd = '/work/private/secret-app';

        await handlers.session_start?.();
        // A tool result before any prompt never waits on an init.
        await handlers.tool_result?.({ toolName: 'bash', content: 'early' }, { cwd });
        const ctxResult = await handlers.context?.({ messages: [] }, { cwd });
        await handlers.before_agent_start?.({ prompt: 'leak nothing' }, { cwd });
        await handlers.tool_result?.({ toolName: 'read', content: 'x' }, { cwd });
        await handlers.agent_end?.({ messages: [{ role: 'assistant', content: 'done' }] });
        await handlers.session_shutdown?.();
        await drainMicrotasks();

        expect(ctxResult).toBeUndefined();
        expect(requests).toEqual([]);
      });
    }

    it('still sends a checkout that no exclusion pattern matches', async () => {
      writeServerSettings({ CLAUDE_MEM_EXCLUDED_PROJECTS: '/work/private/**,secret-*' });
      const requests: CapturedRequest[] = [];
      installServerCapture(requests);
      const handlers = registerHook();

      await handlers.session_start?.();
      await handlers.before_agent_start?.({ prompt: 'public work' }, { cwd: '/work/public/app' });
      await drainMicrotasks();

      expect(requests.map(r => r.path)).toEqual(['/v1/sessions/start', '/v1/events']);
    });

    it('records every prompt as a user_prompt event with generate=false', async () => {
      writeServerSettings();
      const requests: CapturedRequest[] = [];
      installServerCapture(requests);
      const handlers = registerHook();
      const cwd = '/work/acme';

      await handlers.session_start?.();
      await handlers.before_agent_start?.({ prompt: 'first ask' }, { cwd });
      await handlers.before_agent_start?.({ prompt: 'second ask' }, { cwd });
      await drainMicrotasks();

      const promptEvents = requests.filter(r => r.path === '/v1/events' && r.body.eventType === 'user_prompt');
      expect(promptEvents.map(r => r.url.searchParams.get('generate'))).toEqual(['false', 'false']);
      expect(promptEvents.map(r => (r.body.payload as { prompt: string }).prompt)).toEqual(['first ask', 'second ask']);
      expect(promptEvents.map(r => r.body.serverSessionId)).toEqual(['srv-gate-1', 'srv-gate-1']);
    });

    it('names the project the way the Claude Code hooks do: git root, or <repo>/<worktree>', async () => {
      const root = mkdtempSync(join(tmpdir(), 'omp-hook-git-'));
      try {
        const repo = join(root, 'acme-repo');
        const worktree = join(root, 'acme-feature');
        const git = (...args: string[]) => execFileSync('git', args, { stdio: 'ignore' });
        git('init', '-q', repo);
        git('-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'init');
        git('-C', repo, 'worktree', 'add', '-q', '--detach', worktree);
        const subdir = join(repo, 'src', 'deep');
        mkdirSync(subdir, { recursive: true });

        writeServerSettings();
        const requests: CapturedRequest[] = [];
        installServerCapture(requests);
        const handlers = registerHook();

        for (const cwd of [subdir, worktree]) {
          await handlers.session_start?.();
          await handlers.context?.({ messages: [] }, { cwd });
          await handlers.before_agent_start?.({ prompt: 'name me' }, { cwd });
          await drainMicrotasks();
        }

        const contexts = requests.filter(r => r.path === '/v1/context').map(r => r.body.folderProjects);
        const starts = requests.filter(r => r.path === '/v1/sessions/start')
          .map(r => (r.body.metadata as { project?: string }).project);
        expect(contexts).toEqual([['acme-repo'], ['acme-repo/acme-feature']]);
        expect(starts).toEqual(['acme-repo', 'acme-repo/acme-feature']);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('drops tools listed in CLAUDE_MEM_SKIP_TOOLS, by OMP or mapped name, in any case', async () => {
      writeServerSettings({ CLAUDE_MEM_SKIP_TOOLS: ' BASH , todo_write' });
      const requests: CapturedRequest[] = [];
      installServerCapture(requests);
      const handlers = registerHook();
      const cwd = '/work/acme';

      await handlers.session_start?.();
      await handlers.before_agent_start?.({ prompt: 'run things' }, { cwd });
      await handlers.tool_result?.({ toolName: 'bash', content: 'skipped (mapped to Bash)' }, { cwd });
      await handlers.tool_result?.({ toolName: 'todo_write', content: 'skipped (native name)' }, { cwd });
      await handlers.tool_result?.({ toolName: 'read', content: 'kept' }, { cwd });
      await drainMicrotasks();

      const tools = requests.filter(r => r.body.eventType === 'tool_use')
        .map(r => (r.body.payload as { tool_name: string }).tool_name);
      expect(tools).toEqual(['Read']);
    });

    it('records nothing for a wholly private prompt: no start, prompt event or tool events', async () => {
      writeServerSettings();
      const requests: CapturedRequest[] = [];
      installServerCapture(requests);
      const handlers = registerHook();
      const cwd = '/work/acme';

      await handlers.session_start?.();
      await handlers.before_agent_start?.({ prompt: '  <private>my token is abc</private>  ' }, { cwd });
      await handlers.tool_result?.({ toolName: 'read', content: 'private turn' }, { cwd });
      await handlers.agent_end?.({ messages: [{ role: 'assistant', content: 'private reply' }] });
      await handlers.session_shutdown?.();
      await drainMicrotasks();

      expect(requests).toEqual([]);
    });

    it('drops a private later turn but still ends the session its public turn started', async () => {
      writeServerSettings();
      const requests: CapturedRequest[] = [];
      installServerCapture(requests);
      const handlers = registerHook();
      const cwd = '/work/acme';

      await handlers.session_start?.();
      await handlers.before_agent_start?.({ prompt: 'public ask' }, { cwd });
      await handlers.tool_result?.({ toolName: 'read', content: 'public turn' }, { cwd });
      await handlers.before_agent_start?.({ prompt: '<private>secret ask</private>' }, { cwd });
      await handlers.tool_result?.({ toolName: 'bash', content: 'private turn' }, { cwd });
      await handlers.agent_end?.({ messages: [{ role: 'assistant', content: 'private reply' }] });
      await handlers.session_shutdown?.();
      await drainMicrotasks();

      expect(requests.map(r => `${r.path} ${String(r.body.eventType ?? '')}`.trim())).toEqual([
        '/v1/sessions/start',
        '/v1/events user_prompt',
        '/v1/events tool_use',
        '/v1/sessions/srv-gate-1/end',
      ]);
      expect(JSON.stringify(requests.map(r => r.body))).not.toContain('secret ask');
    });
  });
});
