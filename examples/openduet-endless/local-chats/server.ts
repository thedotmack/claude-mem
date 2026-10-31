// SPDX-License-Identifier: Apache-2.0
//
// OpenDuet's chats, kept on this computer.
//
// OpenDuet keeps every conversation in CopilotKit Intelligence, CopilotKit's hosted service, and will
// not start without an account there. This is a small stand-in that answers the same calls from a
// SQLite file instead: the REST calls CopilotKit's runtime makes (threads, history, run locks) and the
// realtime socket its runner and the browser use (Phoenix channels). OpenDuet itself is unchanged
// apart from where its INTELLIGENCE_* settings point.
//
// It does not claim any CopilotKit licence or entitlement. Asked, it says it has none, which OpenDuet
// already handles: conversations run, and the features CopilotKit licenses (its memory, Automatic
// Learning, the hosted thread list) stay off. OpenDuet then keeps memory in its own database.
//
// The protocol is read from the MIT-licensed clients that talk to it, in @copilotkit/runtime 1.77
// (intelligence-platform/client.mjs, runner/intelligence.mjs) and @copilotkit/core 1.77
// (IntelligenceAgent and the thread store).

import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import type { Server, ServerWebSocket } from 'bun';
import { messagesFromEvents, stateFromEvents } from './messages.js';
import { ChatStore, summarize, type ThreadSummary } from './store.js';

export type LocalChatsOptions = {
  /** The SQLite file. ':memory:' for tests. */
  dbPath: string;
  /** The key OpenDuet sends as INTELLIGENCE_API_KEY. Compared in constant time. */
  apiKey: string;
  host?: string;
  /** 0 picks a free port. */
  port?: number;
  log?: (line: string) => void;
  /** How often expired run locks and join tokens are cleared. Tests shorten it. */
  sweepMs?: number;
};

type Plane = 'runner' | 'client';

type GrantScope = { kind: 'thread'; threadId: string } | { kind: 'user'; userId: string; joinCode: string };

type Grant = GrantScope & { expiresAt: number };

type Channel = {
  topic: string;
  joinRef: string | null;
  kind: 'ingestion' | 'thread' | 'user_meta';
  threadId?: string;
  runId?: string;
  mode?: 'run' | 'connect';
  joinCode?: string;
  /** A connect watcher still owed stream_idle when the active run ends. */
  awaitingIdle?: boolean;
};

type SocketData = { plane: Plane; grant: Grant | null; channels: Map<string, Channel> };

type Socket = ServerWebSocket<SocketData>;

type Watcher = { ws: Socket; channel: Channel };

type Lock = { runId: string; expiresAt: number; finished: boolean };

const AG_UI_CHANNEL_EVENT = 'ag-ui';
const CLIENT_AG_UI_EVENT = 'ag_ui_event';
const THREADS_CHANNEL_EVENT = 'thread_metadata';
const RUNNER_EVENT_BATCH_CAPABILITY = 'runner_event_batch_v1';
const GRANT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LOCK_TTL_SECONDS = 60;
const MAX_BODY_BYTES = 32 * 1024 * 1024;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function notKept(path: string): Response {
  return json({ error: 'not_available', message: `The local chat store does not keep this (${path}).` }, 404);
}

function sameSecret(given: string, expected: string): boolean {
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

function isTerminal(type: unknown): boolean {
  return type === 'RUN_FINISHED' || type === 'RUN_ERROR';
}

function eventIdOf(payload: Record<string, unknown>): string | null {
  const metadata = payload.metadata as Record<string, unknown> | undefined;
  return typeof metadata?.cpki_event_id === 'string' && metadata.cpki_event_id ? metadata.cpki_event_id : null;
}

export function createLocalChats(options: LocalChatsOptions): { server: Server<SocketData>; store: ChatStore; stop: () => void } {
  if (!options.apiKey || options.apiKey.length < 16) throw new Error('local chats: the API key must be at least 16 characters');
  const log = options.log ?? (() => {});
  const store = new ChatStore(options.dbPath);
  const grants = new Map<string, Grant>();
  const locks = new Map<string, Lock>();
  const runners = new Map<string, Watcher>();
  const threadWatchers = new Map<string, Set<Watcher>>();
  const userWatchers = new Map<string, Set<Watcher>>();

  const joinCodeFor = (userId: string) => createHash('sha256').update(`user:${userId}`).digest('base64url').slice(0, 24);

  const grant = (value: GrantScope): string => {
    const token = randomBytes(24).toString('base64url');
    grants.set(token, { ...value, expiresAt: Date.now() + GRANT_TTL_MS });
    return token;
  };

  const readGrant = (token: string | null): Grant | null => {
    if (!token) return null;
    const found = grants.get(token);
    if (!found) return null;
    if (found.expiresAt < Date.now()) {
      grants.delete(token);
      return null;
    }
    return found;
  };

  // A browser that joined while a run was going is owed stream_idle when that run ends, however it ends.
  const settleIdle = (threadId: string, latestEventId: string | null) => {
    for (const watcher of threadWatchers.get(threadId) ?? []) {
      if (watcher.channel.mode === 'connect' && watcher.channel.awaitingIdle) {
        watcher.channel.awaitingIdle = false;
        push(watcher, 'stream_idle', { latestEventId });
      }
    }
  };

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [token, value] of grants) if (value.expiresAt < now) grants.delete(token);
    for (const [threadId, lock] of locks) {
      if (!lock.finished && lock.expiresAt >= now) continue;
      locks.delete(threadId);
      // A runner that died without a last event or a release leaves its lock to expire: let waiting browsers go.
      if (!lock.finished) settleIdle(threadId, store.latestEventId(threadId));
    }
  }, options.sweepMs ?? 60_000);

  // ---- Phoenix framing: [join_ref, ref, topic, event, payload] -----------------------------------

  const send = (ws: Socket, joinRef: string | null, ref: string | null, topic: string, event: string, payload: unknown) => {
    ws.send(JSON.stringify([joinRef, ref, topic, event, payload]));
  };
  const push = (watcher: Watcher, event: string, payload: unknown) => {
    send(watcher.ws, watcher.channel.joinRef, null, watcher.channel.topic, event, payload);
  };

  const addWatcher = (map: Map<string, Set<Watcher>>, key: string, watcher: Watcher) => {
    let set = map.get(key);
    if (!set) map.set(key, (set = new Set()));
    set.add(watcher);
  };
  const dropWatcher = (ws: Socket, channel: Channel) => {
    if (channel.kind === 'thread' && channel.threadId) {
      for (const watcher of threadWatchers.get(channel.threadId) ?? []) if (watcher.ws === ws && watcher.channel === channel) threadWatchers.get(channel.threadId)!.delete(watcher);
    }
    if (channel.kind === 'user_meta' && channel.joinCode) {
      for (const watcher of userWatchers.get(channel.joinCode) ?? []) if (watcher.ws === ws && watcher.channel === channel) userWatchers.get(channel.joinCode)!.delete(watcher);
    }
    if (channel.kind === 'ingestion' && channel.runId && runners.get(channel.runId)?.ws === ws) runners.delete(channel.runId);
  };

  const activeLock = (threadId: string): Lock | null => {
    const lock = locks.get(threadId);
    if (!lock || lock.finished || lock.expiresAt < Date.now()) return null;
    return lock;
  };

  const announce = (userId: string, operation: 'created' | 'updated' | 'archived' | 'deleted', thread: ThreadSummary) => {
    const payload =
      operation === 'deleted'
        ? { operation, threadId: thread.id, thread, deleted: { id: thread.id } }
        : { operation, threadId: thread.id, thread };
    for (const watcher of userWatchers.get(joinCodeFor(userId)) ?? []) push(watcher, THREADS_CHANNEL_EVENT, payload);
  };

  // ---- Events from the runner ---------------------------------------------------------------------

  // Each run's RUN_STARTED carries the whole conversation again. Stored as is, a long chat would keep a fresh copy of
  // its history every turn, so the stored copy keeps only the messages the thread doesn't have yet. History reads give
  // the same messages either way (they keep the first copy of each id), and browsers watching live get the event whole.
  const withoutKnownHistory = (threadId: string, payload: Record<string, unknown>): Record<string, unknown> => {
    const input = payload.input as { messages?: unknown[] } | undefined;
    if (payload.type !== 'RUN_STARTED' || !Array.isArray(input?.messages) || input.messages.length === 0) return payload;
    const known = new Set(messagesFromEvents(store.threadEvents(threadId).map((e) => e.payload)).map((m) => m.id));
    if (known.size === 0) return payload;
    const fresh = input.messages.filter((raw) => {
      const id = (raw as { id?: unknown } | null)?.id;
      return typeof id !== 'string' || !known.has(id);
    });
    return fresh.length === input.messages.length ? payload : { ...payload, input: { ...input, messages: fresh } };
  };

  const ingest = (threadId: string, runId: string, payload: Record<string, unknown>): boolean => {
    const eventId = eventIdOf(payload);
    if (!eventId) return false;
    const { inserted } = store.appendEvent(threadId, runId, eventId, withoutKnownHistory(threadId, payload));
    if (!inserted) return true;
    for (const watcher of threadWatchers.get(threadId) ?? []) {
      const { channel } = watcher;
      if (channel.mode === 'run' && channel.runId !== runId) continue;
      push(watcher, CLIENT_AG_UI_EVENT, payload);
    }
    if (payload.type === 'RUN_STARTED') store.touchRun(threadId);
    if (isTerminal(payload.type)) {
      const lock = locks.get(threadId);
      if (lock && lock.runId === runId) lock.finished = true;
      store.touchRun(threadId);
      settleIdle(threadId, eventId);
      const row = store.getThread(threadId);
      if (row) announce(row.user_id, 'updated', summarize(row));
    }
    return true;
  };

  // ---- Channel joins ------------------------------------------------------------------------------

  type JoinResult = { ok: true; response: unknown; after?: () => void } | { ok: false; response: unknown };

  const joinIngestion = (ws: Socket, channel: Channel, params: Record<string, unknown>): JoinResult => {
    if (ws.data.plane !== 'runner') return { ok: false, response: { reason: 'unauthorized', retryable: false } };
    const runId = channel.topic.slice('ingestion:'.length);
    const threadId = typeof params.thread_id === 'string' ? params.thread_id : '';
    if (!runId || !threadId || !store.getThread(threadId)) return { ok: false, response: { reason: 'thread_not_found', retryable: false } };
    channel.kind = 'ingestion';
    channel.threadId = threadId;
    channel.runId = runId;
    runners.set(runId, { ws, channel });
    return { ok: true, response: { capabilities: [RUNNER_EVENT_BATCH_CAPABILITY] } };
  };

  const joinThread = (ws: Socket, channel: Channel, params: Record<string, unknown>): JoinResult => {
    const threadId = channel.topic.slice('thread:'.length);
    const allowed = ws.data.grant?.kind === 'thread' && ws.data.grant.threadId === threadId;
    if (!allowed) return { ok: false, response: { reason: 'unauthorized', retryable: false } };
    if (!store.getThread(threadId)) return { ok: false, response: { reason: 'thread_not_found', retryable: false } };
    channel.kind = 'thread';
    channel.threadId = threadId;
    const watcher: Watcher = { ws, channel };
    if (params.stream_mode === 'run' && typeof params.run_id === 'string') {
      channel.mode = 'run';
      channel.runId = params.run_id;
      // The run may already be under way, or over: send what it has said so far, then follow it.
      return {
        ok: true,
        response: {},
        after: () => {
          for (const event of store.runEvents(threadId, params.run_id as string)) push(watcher, CLIENT_AG_UI_EVENT, event.payload);
          addWatcher(threadWatchers, threadId, watcher);
        },
      };
    }
    channel.mode = 'connect';
    const cursor = typeof params.last_seen_event_id === 'string' ? store.seqOf(threadId, params.last_seen_event_id) : null;
    return {
      ok: true,
      response: {},
      after: () => {
        const replay = store.threadEvents(threadId, cursor ?? 0);
        for (const event of replay) push(watcher, CLIENT_AG_UI_EVENT, event.payload);
        const latestEventId = store.latestEventId(threadId);
        push(watcher, 'replay_complete', { latestEventId });
        addWatcher(threadWatchers, threadId, watcher);
        if (activeLock(threadId)) channel.awaitingIdle = true;
        else push(watcher, 'stream_idle', { latestEventId });
      },
    };
  };

  const joinUserMeta = (ws: Socket, channel: Channel): JoinResult => {
    const joinCode = channel.topic.slice('user_meta:'.length);
    if (ws.data.grant?.kind !== 'user' || ws.data.grant.joinCode !== joinCode) return { ok: false, response: { reason: 'unauthorized', retryable: false } };
    channel.kind = 'user_meta';
    channel.joinCode = joinCode;
    return { ok: true, response: {}, after: () => addWatcher(userWatchers, joinCode, { ws, channel }) };
  };

  const onFrame = (ws: Socket, raw: string) => {
    let frame: unknown;
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }
    if (!Array.isArray(frame) || frame.length !== 5) return;
    const [joinRef, ref, topic, event, payload] = frame as [string | null, string | null, string, string, Record<string, unknown>];
    const reply = (status: 'ok' | 'error', response: unknown) => send(ws, joinRef, ref, topic, 'phx_reply', { status, response });

    if (topic === 'phoenix' && event === 'heartbeat') return reply('ok', {});

    if (event === 'phx_join') {
      const previous = ws.data.channels.get(topic);
      if (previous) dropWatcher(ws, previous);
      const channel: Channel = { topic, joinRef, kind: 'thread' };
      const params = payload && typeof payload === 'object' ? payload : {};
      const result: JoinResult = topic.startsWith('ingestion:')
        ? joinIngestion(ws, channel, params)
        : topic.startsWith('thread:')
          ? joinThread(ws, channel, params)
          : topic.startsWith('user_meta:') && !topic.startsWith('user_meta:memories:')
            ? joinUserMeta(ws, channel)
            : { ok: false, response: { reason: 'not_available', retryable: false } };
      if (!result.ok) return reply('error', result.response);
      ws.data.channels.set(topic, channel);
      reply('ok', result.response);
      result.after?.();
      return;
    }

    const channel = ws.data.channels.get(topic);
    if (event === 'phx_leave') {
      if (channel) {
        dropWatcher(ws, channel);
        ws.data.channels.delete(topic);
      }
      return reply('ok', {});
    }
    if (!channel || channel.joinRef !== joinRef) return reply('error', { reason: 'unmatched_topic' });

    if (channel.kind === 'ingestion' && (event === 'event' || event === 'events')) {
      const events = event === 'events' ? ((payload?.events as Record<string, unknown>[]) ?? []) : [payload];
      let accepted = 0;
      let highestSeq: number | null = null;
      for (const item of events) {
        if (!item || typeof item !== 'object' || !ingest(channel.threadId!, channel.runId!, item)) continue;
        accepted += 1;
        const seq = (item.metadata as Record<string, unknown> | undefined)?.cpki_event_seq;
        if (typeof seq === 'number') highestSeq = Math.max(highestSeq ?? 0, seq);
      }
      if (accepted !== events.length) return reply('error', { reason: 'invalid_event', retryable: false });
      return reply('ok', { accepted, rejected: 0, highestSeq });
    }

    if (channel.kind === 'thread' && event === 'stop_run') {
      const runId = typeof payload?.run_id === 'string' ? payload.run_id : activeLock(channel.threadId!)?.runId;
      const runner = runId ? runners.get(runId) : undefined;
      // Only a run of the thread this browser joined: its token is for that thread alone.
      if (runner && runner.channel.threadId === channel.threadId) push(runner, AG_UI_CHANNEL_EVENT, { type: 'CUSTOM', name: 'stop', value: { runId } });
      return reply('ok', {});
    }

    return reply('error', { reason: 'unsupported_event' });
  };

  // ---- REST ---------------------------------------------------------------------------------------

  const readBody = async (request: Request): Promise<Record<string, unknown>> => {
    const length = Number(request.headers.get('content-length') ?? 0);
    if (length > MAX_BODY_BYTES) throw new Error('body too large');
    const text = await request.text();
    if (!text) return {};
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : {};
  };

  const handleThreads = async (request: Request, url: URL, parts: string[]): Promise<Response> => {
    const method = request.method;
    // /api/threads
    if (parts.length === 2) {
      if (method === 'GET') {
        const userId = url.searchParams.get('userId') ?? '';
        const agentId = url.searchParams.get('agentId') ?? '';
        if (!userId || !agentId) return json({ error: 'userId and agentId are required' }, 400);
        const page = store.listThreads({
          userId,
          agentId,
          includeArchived: url.searchParams.get('includeArchived') === 'true',
          limit: Number(url.searchParams.get('limit') ?? 50) || 50,
          cursor: url.searchParams.get('cursor') ?? undefined,
        });
        const joinCode = joinCodeFor(userId);
        return json({
          threads: page.rows.map(summarize),
          joinCode,
          joinToken: grant({ kind: 'user', userId, joinCode }),
          nextCursor: page.nextCursor,
        });
      }
      if (method === 'POST') {
        const body = await readBody(request);
        const threadId = String(body.threadId ?? '');
        const userId = String(body.userId ?? '');
        const agentId = String(body.agentId ?? '');
        if (!threadId || !userId || !agentId) return json({ error: 'threadId, userId and agentId are required' }, 400);
        if (store.getThread(threadId)) return json({ error: 'thread_exists' }, 409);
        const row = store.createThread({
          id: threadId,
          userId,
          agentId,
          ...(typeof body.name === 'string' ? { name: body.name } : {}),
          ...(typeof body.learningContainerId === 'string' ? { learningContainerId: body.learningContainerId } : {}),
        });
        const thread = summarize(row);
        announce(userId, 'created', thread);
        return json({ thread });
      }
      return json({ error: 'method_not_allowed' }, 405);
    }

    // /api/threads/subscribe
    if (parts.length === 3 && parts[2] === 'subscribe' && method === 'POST') {
      const body = await readBody(request);
      const userId = String(body.userId ?? '');
      if (!userId) return json({ error: 'userId is required' }, 400);
      const joinCode = joinCodeFor(userId);
      return json({ joinToken: grant({ kind: 'user', userId, joinCode }), joinCode });
    }

    const threadId = decodeURIComponent(parts[2] ?? '');
    const row = store.getThread(threadId);

    // /api/threads/:id
    if (parts.length === 3) {
      if (method === 'GET') return row ? json({ thread: summarize(row) }) : json({ error: 'thread_not_found' }, 404);
      if (method === 'PATCH') {
        if (!row) return json({ error: 'thread_not_found' }, 404);
        const body = await readBody(request);
        const updated = store.updateThread(threadId, {
          ...(body.name !== undefined ? { name: body.name === null ? null : String(body.name) } : {}),
          ...(typeof body.archived === 'boolean' ? { archived: body.archived } : {}),
        })!;
        const thread = summarize(updated);
        announce(updated.user_id, body.archived === true ? 'archived' : 'updated', thread);
        return json({ thread });
      }
      if (method === 'DELETE') {
        if (!row) return json({ error: 'thread_not_found' }, 404);
        store.deleteThread(threadId);
        locks.delete(threadId);
        announce(row.user_id, 'deleted', summarize(row));
        return json({ deleted: true });
      }
      return json({ error: 'method_not_allowed' }, 405);
    }

    const action = parts[3];

    if (action === 'messages' && method === 'GET') {
      if (!row) return json({ messages: [] });
      return json({ messages: messagesFromEvents(store.threadEvents(threadId).map((e) => e.payload)) });
    }

    if (action === 'lock') {
      const body = await readBody(request);
      const runId = String(body.runId ?? '');
      if (!runId) return json({ error: 'runId is required' }, 400);
      if (method === 'POST') {
        let thread = row;
        if (!thread) {
          const userId = String(body.userId ?? '');
          const agentId = String(body.agentId ?? '');
          if (!userId || !agentId) return json({ error: 'thread_not_found' }, 404);
          thread = store.createThread({ id: threadId, userId, agentId });
          announce(userId, 'created', summarize(thread));
        }
        const held = activeLock(threadId);
        if (held && held.runId !== runId) return json({ error: 'thread_locked', runId: held.runId }, 409);
        const ttlSeconds = Number(body.ttlSeconds) > 0 ? Number(body.ttlSeconds) : DEFAULT_LOCK_TTL_SECONDS;
        locks.set(threadId, { runId, expiresAt: Date.now() + ttlSeconds * 1000, finished: false });
        return json({
          threadId,
          runId,
          joinToken: grant({ kind: 'thread', threadId }),
          lock: { key: `thread:${threadId}`, ttlSeconds },
        });
      }
      const lock = locks.get(threadId);
      if (method === 'PATCH') {
        if (!lock || lock.runId !== runId || lock.finished) return json({ error: 'lock_not_held' }, 409);
        const ttlSeconds = Number(body.ttlSeconds) > 0 ? Number(body.ttlSeconds) : DEFAULT_LOCK_TTL_SECONDS;
        lock.expiresAt = Date.now() + ttlSeconds * 1000;
        return json({ ttlSeconds });
      }
      if (method === 'DELETE') {
        if (lock && lock.runId === runId) {
          locks.delete(threadId);
          settleIdle(threadId, store.latestEventId(threadId));
        }
        return json({ released: true });
      }
      return json({ error: 'method_not_allowed' }, 405);
    }

    if (action === 'join-code' && method === 'GET') {
      if (!row) return json({ error: 'thread_not_found' }, 404);
      const joinCode = joinCodeFor(row.user_id);
      return json({ joinCode, joinToken: grant({ kind: 'user', userId: row.user_id, joinCode }) });
    }

    if (action === 'connect' && method === 'POST') {
      if (!row) return new Response(null, { status: 204 });
      const lock = activeLock(threadId);
      return json({
        threadId,
        joinToken: grant({ kind: 'thread', threadId }),
        ...(lock ? { runId: lock.runId } : {}),
      });
    }

    return json({ error: 'not_found' }, 404);
  };

  const handleInspect = (parts: string[]): Response => {
    // /api/_inspect/threads/:id/(events|state)
    const threadId = decodeURIComponent(parts[3] ?? '');
    if (!store.getThread(threadId)) return json({ error: 'thread_not_found' }, 404);
    const events = store.threadEvents(threadId).map((e) => e.payload);
    if (parts[4] === 'events') return json({ events, decodeErrorRowIds: [], truncated: false });
    if (parts[4] === 'state') return json(stateFromEvents(events));
    return json({ error: 'not_found' }, 404);
  };

  const handleRest = async (request: Request, url: URL): Promise<Response> => {
    const auth = request.headers.get('authorization') ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!sameSecret(token, options.apiKey)) return json({ error: 'unauthorized' }, 401);
    const parts = url.pathname.split('/').filter(Boolean);
    try {
      if (parts[0] === 'api' && parts[1] === 'entitlements' && parts[2] === 'runtime') {
        // Says plainly that nothing is licensed here. OpenDuet reads this as "no Intelligence licence"
        // and keeps memory in its own database; CopilotKit's licensed extras stay off.
        return json({
          status: 'unavailable',
          error: {
            code: 'LOCAL_CHAT_STORE',
            message: 'Chats are kept in a local store on this computer. No CopilotKit Intelligence entitlement is available.',
            retryable: false,
          },
        });
      }
      if (parts[0] === 'api' && parts[1] === 'threads') return await handleThreads(request, url, parts);
      if (parts[0] === 'api' && parts[1] === '_inspect' && parts[2] === 'threads' && request.method === 'GET') return handleInspect(parts);
      return notKept(url.pathname);
    } catch (error) {
      log(`local chats: ${request.method} ${url.pathname} failed: ${error instanceof Error ? error.message : String(error)}`);
      return json({ error: 'bad_request' }, 400);
    }
  };

  const server = Bun.serve<SocketData, never>({
    hostname: options.host ?? '127.0.0.1',
    port: options.port ?? 0,
    maxRequestBodySize: MAX_BODY_BYTES,
    async fetch(request, srv) {
      const url = new URL(request.url);
      if (url.pathname === '/health') return json({ ok: true, name: 'openduet-local-chats' });

      const plane: Plane | null = url.pathname === '/runner/websocket' ? 'runner' : url.pathname === '/client/websocket' ? 'client' : null;
      if (plane) {
        let grantFound: Grant | null = null;
        let protocol: string | undefined;
        if (plane === 'runner') {
          // The runner sends its key as a WebSocket subprotocol, the way Phoenix's authToken does.
          const offered = (request.headers.get('sec-websocket-protocol') ?? '').split(',').map((p) => p.trim());
          const bearer = offered.find((p) => p.startsWith('base64url.bearer.phx.'));
          let key = '';
          try {
            const encoded = bearer?.slice('base64url.bearer.phx.'.length) ?? '';
            key = atob(encoded + '='.repeat((4 - (encoded.length % 4)) % 4));
          } catch {
            key = '';
          }
          if (!sameSecret(key, options.apiKey)) return new Response('unauthorized', { status: 403 });
          protocol = 'phoenix';
        } else {
          grantFound = readGrant(url.searchParams.get('join_token'));
          if (!grantFound) return new Response('unauthorized', { status: 403 });
        }
        const upgraded = srv.upgrade(request, {
          data: { plane, grant: grantFound, channels: new Map() },
          ...(protocol ? { headers: { 'Sec-WebSocket-Protocol': protocol } } : {}),
        });
        return upgraded ? (undefined as unknown as Response) : new Response('upgrade failed', { status: 400 });
      }
      if (url.pathname.endsWith('/websocket') || url.pathname.endsWith('/longpoll')) return notKept(url.pathname);
      return handleRest(request, url);
    },
    websocket: {
      maxPayloadLength: MAX_BODY_BYTES,
      idleTimeout: 120,
      message(ws, message) {
        onFrame(ws, typeof message === 'string' ? message : Buffer.from(message).toString('utf8'));
      },
      close(ws) {
        for (const channel of ws.data.channels.values()) dropWatcher(ws, channel);
        ws.data.channels.clear();
      },
    },
  });

  log(`local chats: listening on http://${server.hostname}:${server.port}, store ${options.dbPath}`);

  return {
    server,
    store,
    stop: () => {
      clearInterval(sweep);
      server.stop(true);
      store.close();
    },
  };
}

if (import.meta.main) {
  const apiKey = process.env.LOCAL_CHATS_API_KEY ?? '';
  const dbPath = process.env.LOCAL_CHATS_DB ?? '';
  if (!apiKey || !dbPath) {
    process.stderr.write('LOCAL_CHATS_API_KEY and LOCAL_CHATS_DB are required\n');
    process.exit(2);
  }
  const { stop } = createLocalChats({
    apiKey,
    dbPath,
    host: process.env.LOCAL_CHATS_HOST ?? '127.0.0.1',
    port: Number(process.env.LOCAL_CHATS_PORT ?? 37879),
    log: (line) => process.stdout.write(`${new Date().toISOString()} ${line}\n`),
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      stop();
      process.exit(0);
    });
  }
}
