import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import type { Request, Response } from 'express';
import { SessionStore } from '../../../../src/services/sqlite/SessionStore.js';
import { WireRoutes } from '../../../../src/services/worker/http/routes/WireRoutes.js';

// POST /api/wire/tool-observations (wire gateway Endless Mode), driven through
// the route's own validation middleware and handler against an in-memory store.
function capturePostChain(routes: WireRoutes, targetPath: string): (req: Request, res: Response) => void {
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

describe('POST /api/wire/tool-observations', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore(':memory:');
    const sessionDbId = store.createSDKSession('wire-session', 'wire-project', 'read the parser', undefined, 'codex');
    store.updateMemorySessionId(sessionDbId, 'wire-memory');
  });

  afterEach(() => {
    store.close();
  });

  function lookup(body: Record<string, unknown>): { status: number; body: any } {
    const routes = new WireRoutes({ getSessionStore: () => store } as any);
    const handler = capturePostChain(routes, '/api/wire/tool-observations');
    let status = 200;
    const json = mock((payload: unknown) => payload);
    const statusMock = mock((code: number) => { status = code; return { json }; });
    handler({ path: '/api/wire/tool-observations', query: {}, body } as any, { json, status: statusMock } as any);
    return { status, body: json.mock.calls.at(-1)?.[0] };
  }

  function toolUse(toolUseId: string, contentSessionId = 'wire-session', platformSource = 'codex'): void {
    store.upsertToolUse({
      toolUseId, contentSessionId, platformSource, project: 'wire-project', toolName: 'read_file',
      toolInput: '{"path":"a.ts"}', toolResponse: 'x'.repeat(50_000),
    });
  }

  it('answers each linked tool use with its observation, never the tool bodies, and leaves unlinked ones out', () => {
    toolUse('call_1');
    toolUse('call_2');
    toolUse('call_3');
    const observation = store.storeObservation('wire-memory', 'wire-project', {
      type: 'discovery', title: 'Parser read', subtitle: null, facts: ['parser in src/', 'tests pass'],
      narrative: 'The parser was read.', concepts: [], files_read: [], files_modified: [],
    });
    store.linkToolUsesToObservation({ contentSessionId: 'wire-session', toolUseIds: ['call_1', 'call_2'], observationId: observation.id });

    const answer = lookup({ platformSource: 'codex', contentSessionId: 'wire-session', toolUseIds: ['call_1', 'call_2', 'call_3', 'call_unknown'] });
    expect(answer.status).toBe(200);
    const observations = [...answer.body.observations].sort((a: any, b: any) => a.toolUseId.localeCompare(b.toolUseId));
    expect(observations).toEqual([
      { toolUseId: 'call_1', observationId: observation.id, title: 'Parser read', narrative: 'The parser was read.', facts: ['parser in src/', 'tests pass'] },
      { toolUseId: 'call_2', observationId: observation.id, title: 'Parser read', narrative: 'The parser was read.', facts: ['parser in src/', 'tests pass'] },
    ]);
    expect(JSON.stringify(answer.body)).not.toContain('xxxxxxxxxx');
  });

  it('keeps to the session and the agent asked about', () => {
    toolUse('call_1', 'other-session');
    toolUse('call_2', 'wire-session', 'gemini-cli');
    const observation = store.storeObservation('wire-memory', 'wire-project', {
      type: 'discovery', title: 'Elsewhere', subtitle: null, facts: [], narrative: null, concepts: [], files_read: [], files_modified: [],
    });
    store.linkToolUsesToObservation({ contentSessionId: 'other-session', toolUseIds: ['call_1'], observationId: observation.id });
    store.linkToolUsesToObservation({ contentSessionId: 'wire-session', toolUseIds: ['call_2'], observationId: observation.id });
    expect(lookup({ platformSource: 'codex', contentSessionId: 'wire-session', toolUseIds: ['call_1', 'call_2'] }).body).toEqual({ observations: [] });
  });

  it('refuses a body without a session, agent or id list', () => {
    expect(lookup({ contentSessionId: 'wire-session', toolUseIds: ['call_1'] }).status).toBe(400);
    expect(lookup({ platformSource: 'codex', contentSessionId: 'wire-session' }).status).toBe(400);
    expect(lookup({ platformSource: 'codex', contentSessionId: 'wire-session', toolUseIds: [], extra: true }).status).toBe(400);
  });
});
