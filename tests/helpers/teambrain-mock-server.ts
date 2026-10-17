/**
 * A stand-in for the TeamBrain server contract the client is built to:
 * the installer pairing (POST /api/installer/oauth/start, POST /api/pro/trial/poll),
 * the TeamBrain API (cli/status, cli/membership, cli/leave, brief, search), and
 * the local worker endpoints `teambrain join` talks to (health, admin restart,
 * sync status, projects). One Bun.serve on an ephemeral loopback port serves
 * all of it, records every request, and checks the sync bearer on TeamBrain calls.
 */

export const MOCK_PAIRING_ID = 'a'.repeat(32);
export const MOCK_PAIRING_SECRET = 'b'.repeat(48);
export const MOCK_USER_CODE = 'ABCD-2345';
export const MOCK_INVITE_TOKEN = 'tb_inviteTokenFixture_0123456789';
export const MOCK_SEAT_USER_ID = 'user_seat_1';
export const MOCK_SEAT_SETUP_TOKEN = 'SEAT_SETUP_TOKEN_MUST_NOT_LEAK';
export const MOCK_HUB_URL = 'https://sync.example.test';
export const MOCK_TEAM = { id: 'team_1', name: 'Acme Eng' };

export interface RecordedRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  authorization: string | null;
  userId: string | null;
  body: unknown;
}

export interface MockReply {
  status?: number;
  body?: unknown;
  /** Send this text as the body instead of JSON. */
  raw?: string;
  /** Hold the answer this long (a server that stalls). */
  delayMs?: number;
}

export interface TeamBrainMockState {
  /** The poll's ready body; defaults to a seat holder's (no memory_* fields). */
  readyBody: Record<string, unknown>;
  oauthStart: MockReply | null;
  /** Replaces the poll's ready answer (e.g. a 410 join_failed). */
  poll: MockReply | null;
  /** Replaces the cli/status answer (e.g. a 500). */
  status: MockReply | null;
  /** Replaces the worker's /api/health answer. */
  health: MockReply | null;
  teams: Array<Record<string, unknown>>;
  brief: MockReply;
  search: MockReply;
  membership: MockReply;
  leave: MockReply;
  projects: string[];
  workerPid: number;
  syncConfigured: boolean;
  /** What /api/sync/status reports after a restart. */
  syncConfiguredAfterRestart: boolean;
  /** The bearer and user id TeamBrain calls must carry. */
  expectedToken: string;
  expectedUserId: string;
}

export interface TeamBrainMock {
  origin: string;
  port: number;
  state: TeamBrainMockState;
  requests: RecordedRequest[];
  requestsTo(path: string): RecordedRequest[];
  stop(): Promise<void>;
}

export function seatReadyBody(origin: string): Record<string, unknown> {
  return {
    status: 'ready',
    user_id: MOCK_SEAT_USER_ID,
    setup_token: MOCK_SEAT_SETUP_TOKEN,
    hub_url: MOCK_HUB_URL,
    plan: 'teambrain_seat',
    team: MOCK_TEAM,
    teambrain_url: origin,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function reply(answer: MockReply, fallback: unknown): Promise<Response> {
  if (answer.delayMs) await new Promise(resolve => setTimeout(resolve, answer.delayMs));
  if (answer.raw !== undefined) return new Response(answer.raw, { status: answer.status ?? 200 });
  return json(answer.body ?? fallback, answer.status ?? 200);
}

export async function startTeamBrainMock(overrides: Partial<TeamBrainMockState> = {}): Promise<TeamBrainMock> {
  const requests: RecordedRequest[] = [];
  const state = {} as TeamBrainMockState;

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const url = new URL(request.url);
      const text = await request.text();
      let body: unknown = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = text;
      }
      const recorded: RecordedRequest = {
        method: request.method,
        path: url.pathname,
        query: url.searchParams,
        authorization: request.headers.get('authorization'),
        userId: request.headers.get('x-user-id'),
        body,
      };
      requests.push(recorded);
      const route = `${request.method} ${url.pathname}`;

      if (route === 'POST /api/installer/oauth/start') {
        if (state.oauthStart) return reply(state.oauthStart, {});
        const origin = `http://127.0.0.1:${server.port}`;
        return json({
          pairing_id: MOCK_PAIRING_ID,
          secret: MOCK_PAIRING_SECRET,
          user_code: MOCK_USER_CODE,
          authorization_url: `${origin}/login?next=${encodeURIComponent(`/api/pro/trial/claim?pairing=${MOCK_PAIRING_ID}&login_only=1`)}`,
          checkout_url: `${origin}/api/pro/trial/claim?pairing=${MOCK_PAIRING_ID}&trial=7`,
          poll_interval: 1,
          expires_in: 60,
        });
      }
      if (route === 'POST /api/pro/trial/poll') return state.poll ? reply(state.poll, {}) : json(state.readyBody);

      if (url.pathname.startsWith('/api/teambrain/')) {
        if (recorded.authorization !== `Bearer ${state.expectedToken}` || recorded.userId !== state.expectedUserId) {
          return json({ error: 'unauthorized' }, 401);
        }
        if (route === 'GET /api/teambrain/cli/status') return state.status ? reply(state.status, {}) : json({ teams: state.teams });
        if (route === 'POST /api/teambrain/cli/membership') return reply(state.membership, { ok: true });
        if (route === 'POST /api/teambrain/cli/leave') {
          const leftTeamId = (body as { team_id?: unknown } | null)?.team_id;
          if (!state.leave.status) state.teams = state.teams.filter(team => team.id !== leftTeamId);
          return reply(state.leave, { ok: true });
        }
        if (route === 'GET /api/teambrain/brief') {
          return reply(state.brief, { team: MOCK_TEAM, text: `Brief for ${url.searchParams.get('project')}` });
        }
        if (route === 'POST /api/teambrain/search') return reply(state.search, { results: [], text: '' });
      }

      if (route === 'GET /api/health') return state.health ? reply(state.health, {}) : json({ status: 'ok', pid: state.workerPid });
      if (route === 'POST /api/admin/restart') {
        state.workerPid += 1;
        state.syncConfigured = state.syncConfiguredAfterRestart;
        return json({ status: 'restarting' });
      }
      if (route === 'GET /api/sync/status') {
        return json(state.syncConfigured ? { configured: true, hub: { reachable: true, error: null } } : { configured: false });
      }
      if (route === 'GET /api/projects') return json({ projects: state.projects, sources: [], projectsBySource: {} });

      return json({ error: `no mock for ${route}` }, 404);
    },
  });

  const origin = `http://127.0.0.1:${server.port}`;
  Object.assign(state, {
    readyBody: seatReadyBody(origin),
    oauthStart: null,
    poll: null,
    status: null,
    health: null,
    teams: [{ ...MOCK_TEAM, role: 'member', broadcasting: false, projects: null, seats_used: 2, seat_limit: 5 }],
    brief: {},
    search: {},
    membership: {},
    leave: {},
    projects: ['proj-a', 'proj-b'],
    workerPid: 100,
    syncConfigured: false,
    syncConfiguredAfterRestart: true,
    expectedToken: MOCK_SEAT_SETUP_TOKEN,
    expectedUserId: MOCK_SEAT_USER_ID,
    ...overrides,
  } satisfies TeamBrainMockState);

  return {
    origin,
    port: server.port,
    state,
    requests,
    requestsTo: (path: string) => requests.filter(request => request.path === path),
    stop: async () => {
      server.stop(true);
    },
  };
}
