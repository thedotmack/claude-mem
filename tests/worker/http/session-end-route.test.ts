import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import type { Request, Response } from 'express';
import { SessionRoutes } from '../../../src/services/worker/http/routes/SessionRoutes.js';
import * as providerDispatch from '../../../src/services/worker/provider-dispatch.js';
import type { TelegramWrapupFormatter, TelegramWrapupFormatterInput } from '../../../src/services/integrations/TelegramWrapupNotifier.js';

afterEach(() => mock.restore());

type Handler = (req: Request, res: Response) => void;

function captureSessionEndHandler(routes: SessionRoutes): Handler {
  let handler: Handler | undefined;
  const app = {
    post: mock((path: string, ...handlers: Handler[]) => {
      if (path === '/api/sessions/session-end') {
        handler = handlers.at(-1);
      }
    }),
  };

  routes.setupRoutes(app as any);
  if (!handler) throw new Error('SessionEnd route was not registered');
  return handler;
}

function makeRequest(body: Record<string, unknown>): Request {
  return {
    path: '/api/sessions/session-end',
    body,
    query: {},
    get: () => undefined,
  } as unknown as Request;
}

function makeResponse(): { res: Response; json: ReturnType<typeof mock> } {
  const json = mock(() => {});
  return {
    res: { headersSent: false, json } as unknown as Response,
    json,
  };
}

async function flushAsyncHandler(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
}

function makeRoutes(findSessionDbIdByContentSessionId: ReturnType<typeof mock>, requestSessionWrapup: ReturnType<typeof mock>): SessionRoutes {
  return new SessionRoutes(
    { requestSessionWrapup } as any,
    { getSessionStore: () => ({ findSessionDbIdByContentSessionId }) } as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
  );
}

describe('SessionEnd route', () => {
  it.each(['claude', 'gemini', 'openrouter'] as const)('formats through the active %s summary provider and model', async provider => {
    let formatter!: TelegramWrapupFormatter;
    const input: TelegramWrapupFormatterInput = {
      sessionDbId: 42, contentSessionId: 'session', project: 'project', platformSource: 'claude', summaryText: 'whole summary',
    };
    const agents = {
      claude: { formatTelegramWrapup: mock(async () => '• Claude summary') },
      gemini: { formatTelegramWrapup: mock(async () => '• Gemini summary') },
      openrouter: { formatTelegramWrapup: mock(async () => '• OpenRouter summary') },
    };
    const selection = spyOn(providerDispatch, 'selectProviderForGenerator');
    new SessionRoutes({
      getSession: () => ({ currentProvider: provider, lastModelId: 'active-model' }),
      setTelegramWrapupFormatter: (value: TelegramWrapupFormatter) => { formatter = value; },
    } as any, {} as any, agents.claude as any, agents.gemini as any, agents.openrouter as any, {} as any, {} as any, {} as any);

    await formatter(input);

    expect(agents[provider].formatTelegramWrapup).toHaveBeenCalledWith(input, 'active-model');
    expect(selection).not.toHaveBeenCalled();
    for (const [name, agent] of Object.entries(agents)) {
      if (name !== provider) expect(agent.formatTelegramWrapup).not.toHaveBeenCalled();
    }
  });

  it.each([false, true])('uses normal provider dispatch for a replay and releases the probe (failure: %s)', async fail => {
    let formatter!: TelegramWrapupFormatter;
    const input: TelegramWrapupFormatterInput = {
      sessionDbId: 42, contentSessionId: 'session', project: 'project', platformSource: 'claude', summaryText: 'whole summary',
    };
    const selection = spyOn(providerDispatch, 'selectProviderForGenerator')
      .mockReturnValue({ provider: 'openrouter', gatewayProbeClaimId: 123 });
    const release = spyOn(providerDispatch, 'releaseCmemGatewayProbe').mockImplementation(() => {});
    const formatTelegramWrapup = mock(async () => {
      if (fail) throw new Error('provider failed');
      return '• Formatted replay';
    });
    new SessionRoutes({
      getSession: () => undefined,
      setTelegramWrapupFormatter: (value: TelegramWrapupFormatter) => { formatter = value; },
    } as any, {} as any, {} as any, {} as any, { formatTelegramWrapup } as any, {} as any, {} as any, {} as any);

    if (fail) await expect(formatter(input)).rejects.toThrow('provider failed');
    else await expect(formatter(input)).resolves.toBe('• Formatted replay');

    expect(selection).toHaveBeenCalledTimes(1);
    expect(formatTelegramWrapup).toHaveBeenCalledWith(input, undefined);
    expect(release).toHaveBeenCalledWith(123);
  });

  it('returns unknown_session and does not request a wrap-up when no matching platform-scoped session exists', async () => {
    const findSessionDbIdByContentSessionId = mock(() => null);
    const requestSessionWrapup = mock(async () => {});
    const handler = captureSessionEndHandler(makeRoutes(findSessionDbIdByContentSessionId, requestSessionWrapup));
    const { res, json } = makeResponse();

    handler(makeRequest({ contentSessionId: 'missing-session', platformSource: 'Cursor' }), res);
    await flushAsyncHandler();

    expect(findSessionDbIdByContentSessionId).toHaveBeenCalledWith('missing-session', 'cursor');
    expect(requestSessionWrapup).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith({ status: 'unknown_session' });
  });

  it('accepts a known session and requests its wrap-up exactly once', async () => {
    const findSessionDbIdByContentSessionId = mock(() => 42);
    const requestSessionWrapup = mock(async () => {});
    const handler = captureSessionEndHandler(makeRoutes(findSessionDbIdByContentSessionId, requestSessionWrapup));
    const { res, json } = makeResponse();

    handler(makeRequest({ contentSessionId: 'known-session', platformSource: 'Claude Code', reason: 'clear' }), res);
    await flushAsyncHandler();

    expect(findSessionDbIdByContentSessionId).toHaveBeenCalledWith('known-session', 'claude');
    expect(requestSessionWrapup).toHaveBeenCalledTimes(1);
    expect(requestSessionWrapup).toHaveBeenCalledWith(42);
    expect(json).toHaveBeenCalledWith({ status: 'accepted' });
  });
});
