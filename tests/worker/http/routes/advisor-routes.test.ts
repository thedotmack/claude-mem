import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import type { Request, Response } from 'express';
import { SessionStore } from '../../../../src/services/sqlite/SessionStore.js';
import { AdvisorRoutes } from '../../../../src/services/worker/http/routes/AdvisorRoutes.js';

// POST /api/advisor-calls, driven through the route's own validation
// middleware and handler against an in-memory store.
function capturePostChain(routes: AdvisorRoutes, targetPath: string): (req: Request, res: Response) => void {
  let middleware: ((req: Request, res: Response, next: () => void) => void) | undefined;
  let handler: ((req: Request, res: Response) => void) | undefined;
  const app = {
    get: mock(() => {}),
    post: mock((path: string, ...rest: any[]) => {
      if (path !== targetPath) return;
      middleware = rest[0];
      handler = rest[1];
    }),
  };
  routes.setupRoutes(app as any);
  if (!handler || !middleware) throw new Error(`Handler not registered for ${targetPath}`);

  return (req: Request, res: Response): void => {
    let nextCalled = false;
    middleware!(req, res, () => { nextCalled = true; });
    if (nextCalled) handler!(req, res);
  };
}

describe('POST /api/advisor-calls', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  function ingest(body: Record<string, unknown>): Record<string, unknown> {
    const routes = new AdvisorRoutes({ getSessionStore: () => store } as any);
    const handler = capturePostChain(routes, '/api/advisor-calls');
    const json = mock((payload: unknown) => payload);
    const status = mock(() => ({ json }));
    handler({ path: '/api/advisor-calls', query: {}, body } as any, { json, status } as any);
    return json.mock.calls.at(-1)?.[0] as Record<string, unknown>;
  }

  function call(overrides: Record<string, unknown> = {}) {
    return {
      toolUseId: 'srvtoolu_route_1',
      advice: 'Check the retry budget before blaming the network.',
      advisorModel: 'claude-fable-5',
      occurredAtEpoch: 1_000,
      lastUserMessage: 'why does the sync stall?',
      transcriptByteOffset: 2_048,
      ...overrides,
    };
  }

  const session = {
    contentSessionId: 'advisor-route-session',
    platformSource: 'claude',
    cwd: '/work/advisor-route-project',
    transcriptPath: '/work/.claude/transcript.jsonl',
  };

  it('stores the call with its byte offset and the private parts of advice and prompt removed', () => {
    const result = ingest({
      ...session,
      calls: [call({
        advice: 'Rotate the key <private>sk-live-123</private>before retrying.',
        lastUserMessage: 'my key is <private>sk-live-123</private>, why 401?',
      })],
    });

    expect(result).toMatchObject({ status: 'stored', stored: 1, duplicates: 0, privateOnly: 0 });
    const row = store.getAdvisorCalls(0, 10).items[0];
    expect(row.advice).not.toContain('sk-live-123');
    expect(row.advice).toContain('Rotate the key');
    expect(row.last_user_message).not.toContain('sk-live-123');
    expect(row.transcript_byte_offset).toBe(2_048);
    expect(row.project).toBe('advisor-route-project');
  });

  it('drops advice that was entirely private instead of storing an empty row', () => {
    const result = ingest({ ...session, calls: [call({ advice: '<private>all of it</private>' })] });

    expect(result).toMatchObject({ stored: 0, privateOnly: 1 });
    expect(store.getAdvisorCalls(0, 10).items).toHaveLength(0);
  });

  it('treats a replayed tool_use_id as a duplicate', () => {
    ingest({ ...session, calls: [call()] });
    const replay = ingest({ ...session, calls: [call({ advice: 'replayed' })] });

    expect(replay).toMatchObject({ stored: 0, duplicates: 1 });
    expect(store.getAdvisorCalls(0, 10).items.map(row => row.advice))
      .toEqual(['Check the retry budget before blaming the network.']);
  });
});
