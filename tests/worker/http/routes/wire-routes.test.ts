import { describe, it, expect, beforeAll, beforeEach, afterEach, mock } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Request, Response } from 'express';
import { SessionStore } from '../../../../src/services/sqlite/SessionStore.js';
import { WireRoutes } from '../../../../src/services/worker/http/routes/WireRoutes.js';
import { ModeManager } from '../../../../src/services/domain/ModeManager.js';
import { formatTime } from '../../../../src/shared/timeline-formatting.js';
import { getProjectContext } from '../../../../src/utils/project-name.js';
import { renderRulesFile, type SavedRule } from '../../../../src/services/work-view/my-rules.mjs';

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

function captureGetChain(routes: WireRoutes, targetPath: string): (req: Request, res: Response) => void {
  let handlers: Array<(req: Request, res: Response, next: () => void) => void> = [];
  const app = {
    get: mock((path: string, ...rest: any[]) => { if (path === targetPath) handlers = rest; }),
    post: mock(() => {}),
  };
  routes.setupRoutes(app as any);
  if (handlers.length === 0) throw new Error(`Handler not registered for ${targetPath}`);
  return (req: Request, res: Response): void => {
    for (const handler of handlers) {
      let nextCalled = false;
      handler(req, res, () => { nextCalled = true; });
      if (!nextCalled) return;
    }
  };
}

beforeAll(() => {
  // The timeline line's icon comes from the active mode, as at session start.
  ModeManager.getInstance().loadMode('code');
});

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
    const timelineLine = expect.stringMatching(new RegExp(`^${observation.id} \\S+ \\S+ Parser read$`));
    expect(observations).toEqual([
      { toolUseId: 'call_1', observationId: observation.id, title: 'Parser read', narrative: 'The parser was read.', facts: ['parser in src/', 'tests pass'], timelineLine },
      { toolUseId: 'call_2', observationId: observation.id, title: 'Parser read', narrative: 'The parser was read.', facts: ['parser in src/', 'tests pass'], timelineLine },
    ]);
    expect(JSON.stringify(answer.body)).not.toContain('xxxxxxxxxx');
  });

  it('gives each observation the one-line entry the session-start timeline shows for it', () => {
    toolUse('call_1');
    const observation = store.storeObservation('wire-memory', 'wire-project', {
      type: 'bugfix', title: 'Parser fixed', subtitle: null, facts: [], narrative: null, concepts: [], files_read: [], files_modified: [],
    });
    store.linkToolUsesToObservation({ contentSessionId: 'wire-session', toolUseIds: ['call_1'], observationId: observation.id });

    const [answered] = lookup({ platformSource: 'codex', contentSessionId: 'wire-session', toolUseIds: ['call_1'] }).body.observations;
    // AgentFormatter's row: "<id> <compact time> <type icon> <title>", e.g. "12 3:04p 🔴 Parser fixed".
    const compactTime = formatTime(observation.createdAtEpoch).toLowerCase().replace(' am', 'a').replace(' pm', 'p');
    const icon = ModeManager.getInstance().getTypeIcon('bugfix');
    expect(answered.timelineLine).toBe(`${observation.id} ${compactTime} ${icon} Parser fixed`);
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

describe('GET /api/wire/header', () => {
  const cwd = '/Users/someone/code/header-test-app';
  const project = getProjectContext(cwd).primary;
  // Fixtures stay inside the repo's gitignored .scratch/, never the system temp folder.
  const scratchDir = join(import.meta.dir, '../../../../.scratch');
  let directory: string;
  let rulesFilePath: string;

  beforeEach(() => {
    mkdirSync(scratchDir, { recursive: true });
    directory = mkdtempSync(join(scratchDir, 'wire-header-test-'));
    rulesFilePath = join(directory, 'MY-RULES.md');
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  function rule(fields: Partial<SavedRule> & Pick<SavedRule, 'ruleId' | 'then'>): SavedRule {
    const scopeTier = fields.scopeTier ?? 'everywhere';
    const scopeName = fields.scopeName ?? 'Everywhere';
    return {
      scopeTier, scopeName, scopeId: scopeTier === 'everywhere' ? 'everywhere' : `${scopeTier}:${scopeName}`,
      when: '', setBy: 'owner', status: 'on', kind: 'directive', source: 'you', timesSeen: 1, latestAt: null,
      quotes: [], replacedBy: null, replacedAt: null, savedAt: null, ...fields,
    };
  }

  /** MY-RULES.md exactly as WorkViewRoutes writes it. */
  function writeRulesFile(rules: SavedRule[]): string {
    const markdown = renderRulesFile(rules).markdown;
    writeFileSync(rulesFilePath, markdown);
    return markdown;
  }

  async function header(
    query: Record<string, unknown> = { cwd },
    { ip = '127.0.0.1', requestHeaders = {}, contextReader }: {
      ip?: string; requestHeaders?: Record<string, string>; contextReader?: { projectsForCwd(cwd: string): Promise<string[]> };
    } = {},
  ): Promise<{ status: number; body: any }> {
    const routes = new WireRoutes({ getSessionStore: () => { throw new Error('not used'); } } as any, { rulesFilePath, contextReader });
    const handler = captureGetChain(routes, '/api/wire/header');
    let status = 200;
    const json = mock((payload: unknown) => payload);
    const statusMock = mock((code: number) => { status = code; return { json }; });
    const headers: Record<string, string> = { host: '127.0.0.1:37777', ...requestHeaders };
    handler(
      { path: '/api/wire/header', query, ip, socket: { remoteAddress: ip }, header: (name: string) => headers[name.toLowerCase()] } as any,
      { json, status: statusMock } as any,
    );
    // The handler is async (projects may resolve off-thread): let it finish.
    await new Promise(resolve => setImmediate(resolve));
    return { status, body: json.mock.calls.at(-1)?.[0] };
  }

  const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

  it("keeps the top lines, Everywhere, this checkout's project and situation sections, and drops other projects", async () => {
    writeRulesFile([
      rule({ ruleId: 'r1', then: 'Fail fast.' }),
      rule({ ruleId: 'r2', then: 'Run the parser tests.', scopeTier: 'project', scopeName: project }),
      rule({ ruleId: 'r3', then: 'Never touch billing.', scopeTier: 'project', scopeName: 'some-other-project' }),
      rule({ ruleId: 'r4', then: 'Write a plan first.', scopeTier: 'situation', scopeName: 'When planning' }),
      // A situation named like a project section is still a situation, and kept.
      rule({ ruleId: 'r5', then: 'Check the deploy.', scopeTier: 'situation', scopeName: 'In production' }),
    ]);
    const answer = await header();
    expect(answer.status).toBe(200);
    // The file minus the other project's section, byte for byte.
    expect(answer.body.text).toBe(renderRulesFile([
      rule({ ruleId: 'r1', then: 'Fail fast.' }),
      rule({ ruleId: 'r2', then: 'Run the parser tests.', scopeTier: 'project', scopeName: project }),
      rule({ ruleId: 'r4', then: 'Write a plan first.', scopeTier: 'situation', scopeName: 'When planning' }),
      rule({ ruleId: 'r5', then: 'Check the deploy.', scopeTier: 'situation', scopeName: 'In production' }),
    ]).markdown);
    expect(answer.body.text).toContain('## Situation: In production\n\n- Check the deploy.');
    expect(answer.body.text.startsWith('# My Rules\n')).toBe(true);
    expect(answer.body.text).not.toContain('Never touch billing.');
    expect(answer.body.hash).toBe(sha256(answer.body.text));
  });

  it('answers null text when the file is missing or no section is kept', async () => {
    expect((await header()).body).toEqual({ text: null, hash: sha256('') });
    writeRulesFile([]);
    expect((await header()).body).toEqual({ text: null, hash: sha256('') });
    writeRulesFile([rule({ ruleId: 'r1', then: 'Elsewhere.', scopeTier: 'project', scopeName: 'some-other-project' })]);
    expect((await header()).body).toEqual({ text: null, hash: sha256('') });
  });

  it('keeps the hash while the file is unchanged and changes it when the file changes', async () => {
    writeRulesFile([rule({ ruleId: 'r1', then: 'Fail fast.' }), rule({ ruleId: 'r2', then: 'Be brief.' })]);
    const first = (await header()).body;
    expect((await header()).body).toEqual(first);
    writeRulesFile([rule({ ruleId: 'r1', then: 'Fail faster.' }), rule({ ruleId: 'r2', then: 'Be brief.' })]);
    const changed = (await header()).body;
    expect(changed.text).toContain('- Fail faster.');
    expect(changed.hash).not.toBe(first.hash);
  });

  it('refuses a relative or missing cwd and another computer', async () => {
    writeRulesFile([rule({ ruleId: 'r1', then: 'Fail fast.' })]);
    expect((await header({ cwd: 'relative/path' })).status).toBe(400);
    expect((await header({})).status).toBe(400);
    expect((await header({ cwd }, { ip: '10.0.0.5' })).status).toBe(403);
  });

  it('refuses any browser page, even one on this computer', async () => {
    writeRulesFile([rule({ ruleId: 'r1', then: 'Fail fast.' })]);
    expect((await header({ cwd }, { requestHeaders: { origin: 'http://localhost:37777' } })).status).toBe(403);
    expect((await header({ cwd }, { requestHeaders: { origin: 'null' } })).status).toBe(403);
    expect((await header({ cwd }, { requestHeaders: { 'sec-fetch-site': 'cross-site' } })).status).toBe(403);
    expect((await header()).status).toBe(200);
  });

  it("resolves the checkout's projects through the context reader when there is one", async () => {
    writeRulesFile([
      rule({ ruleId: 'r1', then: 'Reader project rule.', scopeTier: 'project', scopeName: 'reader-project' }),
      rule({ ruleId: 'r2', then: 'Path project rule.', scopeTier: 'project', scopeName: project }),
    ]);
    const asked: string[] = [];
    const contextReader = { projectsForCwd: async (askedCwd: string) => { asked.push(askedCwd); return ['reader-project']; } };
    const answer = await header({ cwd }, { contextReader });
    expect(asked).toEqual([cwd]);
    expect(answer.body.text).toContain('- Reader project rule.');
    expect(answer.body.text).not.toContain('- Path project rule.');
  });
});
