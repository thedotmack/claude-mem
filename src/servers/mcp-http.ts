// Streamable HTTP front for the claude-mem MCP server.
//
// stdio MCP servers are one process per client session. This serves many clients
// from one process: every MCP session gets its own Server instance and a working
// directory (the project), so the tools that scope by project still work.
//
// Loopback only. The server binds to 127.0.0.1, ::1 or localhost and refuses any
// other host: it exposes every local tool, work_state_write included, and serving
// that to a network is a product decision this transport does not make.
//
// Where a session's working directory comes from, highest priority first:
//   1. the `X-Claude-Mem-Cwd` request header (Claude Code: `${CLAUDE_PROJECT_DIR}`),
//   2. the MCP `roots/list` answer of the client (opencode answers with the project),
//   3. the server process' own cwd.
//
// Trust model for that directory: it becomes the sandbox root of smart_outline,
// smart_unfold and smart_search (resolveWithinWorkspace). Over stdio the root is the
// cwd the client started the server in, so the client already picks it; over HTTP
// the client names it per request instead. Either way the client is a local process
// of this OS user (loopback peer, loopback Host, no foreign browser Origin), so it can
// name no directory it could not already read. The header must be an absolute path
// to an existing directory, and an unusable one is refused (400) rather than
// silently replaced by the session or process cwd.
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Request as ExpressRequest } from 'express';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest, RootsListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { isLocalhost } from '../server/middleware/request-auth-helpers.js';
import { isOwnPageOrigin, type WorkerOriginPolicy } from '../services/worker/http/origin-policy.js';
import { logger } from '../utils/logger.js';

export const CWD_HEADER = 'x-claude-mem-cwd';
export const MCP_HTTP_PATH = '/mcp';
export const DEFAULT_HTTP_HOST = '127.0.0.1';
export const DEFAULT_HTTP_PORT = 37790;

// The same cap as the worker's JSON body limit (express.json({ limit: '5mb' }) in
// src/services/worker/http/middleware.ts): tool arguments are forwarded to the worker,
// so a larger request could never succeed there anyway.
const MAX_BODY_BYTES = 5 * 1024 * 1024;
// Reaps sessions whose client went away without a DELETE (abandoned-session memory
// protection). Reaping a live but idle session is cheap: the MCP Streamable HTTP spec
// requires a client that gets 404 for its session id to initialize a new one.
const SESSION_IDLE_MS = 60 * 60 * 1000;
// How often idle sessions are looked for. It only decides how late past SESSION_IDLE_MS
// a session goes (at most 5 of 60 minutes); each sweep is a walk over at most
// MAX_SESSIONS entries.
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
// roots/list blocks the client's first tool call. A client that has not opened its
// standalone SSE stream cannot answer, and the SDK's default request timeout (60 s)
// would stall that call a minute. A client that can answer is a local process on
// loopback.
const ROOTS_TIMEOUT_MS = 2000;
// Each failed roots/list attempt can add ROOTS_TIMEOUT_MS to a tool call, so a client
// that never answers costs at most 6 s in total before the session settles on the
// process cwd (logged).
const MAX_ROOTS_ATTEMPTS = 3;
// Abuse protection: every session holds an MCP Server and transport in memory until
// it is closed or swept. A local client stuck in an initialize loop would otherwise
// grow the process for an hour. Real use is one session per open editor or agent on
// this machine, far below this.
export const MAX_SESSIONS = 256;

const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1'];

export interface McpHttpOptions {
  /** 127.0.0.1, ::1 or localhost; anything else is refused. */
  host: string;
  port: number;
}

/** Resolves the project directory for one tool call from the request that carries it. */
export type CwdResolver = (extra?: {
  requestInfo?: { headers?: Record<string, string | string[] | undefined> };
}) => string;

/** The loopback host name, without IPv6 brackets; throws for any other host. */
function loopbackHostOrThrow(raw: string): string {
  const host = raw.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1');
  if (!LOOPBACK_HOSTS.includes(host)) {
    throw new Error(
      `Refusing to listen on ${raw}: the MCP HTTP transport binds to loopback only (127.0.0.1, ::1 or localhost).`,
    );
  }
  return host;
}

/**
 * Read the HTTP options from the command line and environment.
 * Returns null when HTTP mode was not requested (the server then speaks stdio).
 */
export function parseHttpArgs(argv: readonly string[], env: NodeJS.ProcessEnv): McpHttpOptions | null {
  const flag = (name: string): string | undefined => {
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === `--${name}`) return argv[i + 1];
      if (argv[i].startsWith(`--${name}=`)) return argv[i].slice(name.length + 3);
    }
    return undefined;
  };
  const requested = argv.includes('--http') || env.CLAUDE_MEM_MCP_HTTP === '1';
  if (!requested) return null;

  const host = loopbackHostOrThrow(flag('host') ?? env.CLAUDE_MEM_MCP_HTTP_HOST ?? DEFAULT_HTTP_HOST);
  const portText = flag('port') ?? env.CLAUDE_MEM_MCP_HTTP_PORT ?? String(DEFAULT_HTTP_PORT);
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid MCP HTTP port: ${portText}`);
  }
  return { host, port };
}

/** The project directory a request names in its X-Claude-Mem-Cwd header, if usable. */
export function headerCwd(headers: Record<string, string | string[] | undefined> | undefined): string | null {
  if (!headers) return null;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === CWD_HEADER);
  const value = key ? headers[key] : undefined;
  return normalizeCwd(Array.isArray(value) ? value[0] : value);
}

/** A usable project directory from a header value or file:// URI, or null. */
export function normalizeCwd(value: string | undefined | null): string | null {
  if (typeof value !== 'string') return null;
  let candidate = value.trim();
  if (candidate.length === 0 || candidate.includes('\0')) return null;
  if (candidate.startsWith('file://')) {
    try {
      candidate = fileURLToPath(candidate);
    } catch {
      return null;
    }
  }
  if (!isAbsolute(candidate)) return null;
  const resolved = resolve(candidate);
  try {
    return statSync(resolved).isDirectory() ? resolved : null;
  } catch {
    return null;
  }
}

/** The first usable directory in an MCP `roots/list` result. */
export function cwdFromRoots(roots: ReadonlyArray<{ uri: string }> | undefined): string | null {
  for (const root of roots ?? []) {
    const cwd = normalizeCwd(root.uri);
    if (cwd) return cwd;
  }
  return null;
}

/** Host header values we answer to (DNS rebinding protection): the loopback names, with and without the port. */
export function allowedHosts(port: number): string[] {
  return LOOPBACK_HOSTS
    .map((h) => (h.includes(':') ? `[${h}]` : h))
    .flatMap((h) => [h, `${h}:${port}`]);
}

type CwdSource = 'header' | 'roots' | 'default';

interface Session {
  transport: StreamableHTTPServerTransport;
  server: Server;
  cwd: string;
  cwdSource: CwdSource;
  lastSeen: number;
  rootsAttempts: number;
  /** The client said its roots changed: ask again before the next request. */
  rootsStale: boolean;
  rootsInFlight?: Promise<void>;
}

export interface McpHttpHandle {
  port: number;
  sessionCount(): number;
  close(): Promise<void>;
}

export interface StartMcpHttpOptions extends McpHttpOptions {
  /** Build one MCP Server for one session; `resolveCwd` returns the project directory of a call. */
  createServer: (resolveCwd: CwdResolver) => Server;
  /**
   * The worker's browser-origin policy (buildWorkerOriginPolicy). A request with an Origin
   * header passes only if isOwnPageOrigin accepts it, so CLAUDE_MEM_ALLOWED_ORIGINS also
   * governs this server. Local MCP clients send no Origin.
   */
  originPolicy: WorkerOriginPolicy;
  /** Defaults to MAX_SESSIONS; tests lower it. */
  maxSessions?: number;
}

function sendJsonRpcError(res: ServerResponse, status: number, code: number, message: string): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** A client mistake in the request body, answered with its own HTTP status and JSON-RPC code. */
class RequestBodyError extends Error {
  constructor(message: string, readonly httpStatus: number, readonly jsonRpcCode: number) {
    super(message);
  }
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      if (tooLarge) return; // Drain the rest unread, so the 413 reaches the client.
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        reject(new RequestBodyError(`Request body too large (limit ${MAX_BODY_BYTES} bytes)`, 413, -32600));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) return;
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new RequestBodyError('Parse error: the request body is not valid JSON', 400, -32700));
      }
    });
    req.on('error', reject);
  });
}

export async function startMcpHttpServer(options: StartMcpHttpOptions): Promise<McpHttpHandle> {
  const bindHost = loopbackHostOrThrow(options.host);
  const maxSessions = options.maxSessions ?? MAX_SESSIONS;
  const sessions = new Map<string, Session>();
  // Sessions between createSession and the SDK's onsessioninitialized, so concurrent
  // initialize requests cannot slip past the cap.
  let initializing = 0;
  const defaultCwd = process.cwd();

  const applyHeaderCwd = (session: Session, req: IncomingMessage): void => {
    const cwd = normalizeCwd(firstHeader(req.headers[CWD_HEADER]));
    if (cwd) {
      session.cwd = cwd;
      session.cwdSource = 'header';
    }
  };

  const refreshRoots = async (session: Session): Promise<void> => {
    if (session.cwdSource === 'header') return;
    if (!session.server.getClientCapabilities()?.roots) return;
    session.rootsAttempts++;
    try {
      const { roots } = await session.server.listRoots(undefined, { timeout: ROOTS_TIMEOUT_MS });
      const cwd = cwdFromRoots(roots);
      session.rootsStale = false;
      // The header may have arrived while we waited for the client's answer.
      if (cwd && (session.cwdSource as CwdSource) !== 'header') {
        session.cwd = cwd;
        session.cwdSource = 'roots';
      }
    } catch (error) {
      const givingUp = session.rootsAttempts >= MAX_ROOTS_ATTEMPTS;
      logger.warn('SYSTEM', givingUp
        ? `MCP HTTP: roots/list failed ${MAX_ROOTS_ATTEMPTS} times, this session stays on ${session.cwd}`
        : 'MCP HTTP: roots/list failed, keeping the current cwd', { cwd: session.cwd },
        error instanceof Error ? error : new Error(String(error)));
    }
  };

  // The client's roots are fetched lazily, at its first real request: right after `initialize`
  // it may not have opened the standalone SSE stream yet, and the server's request would be lost.
  const ensureCwd = async (session: Session, body: unknown): Promise<void> => {
    const method = (body as { method?: unknown } | undefined)?.method;
    if (typeof method !== 'string' || method === 'initialize' || method.startsWith('notifications/')) return;
    // Roots decide the directory only while no header ever did. They are asked again when the
    // client reports a change (notifications/roots/list_changed), before the next request runs.
    if (session.cwdSource === 'header') return;
    if (session.cwdSource !== 'default' && !session.rootsStale) return;
    if (session.rootsAttempts >= MAX_ROOTS_ATTEMPTS) return;
    session.rootsInFlight ??= refreshRoots(session).finally(() => {
      session.rootsInFlight = undefined;
    });
    await session.rootsInFlight;
  };

  const createSession = (req: IncomingMessage): Session => {
    const session = {
      cwd: defaultCwd,
      cwdSource: 'default' as CwdSource,
      lastSeen: Date.now(),
      rootsAttempts: 0,
      rootsStale: false,
    } as Session;
    applyHeaderCwd(session, req);
    session.transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => {
        sessions.set(sessionId, session);
      },
      // Kept as a second layer behind the Host check in `handle`. The SDK's Origin check is
      // not used: it only runs when allowedOrigins is non-empty, so `handle` checks Origin.
      enableDnsRebindingProtection: true,
      allowedHosts: allowedHosts(actualPort),
    });
    // A request names its own directory in its own header. Reading it from the request, not from
    // shared session state, keeps overlapping requests of one session apart; the session cwd
    // (last header, else roots) only serves requests that carry no header.
    session.server = options.createServer((extra) => headerCwd(extra?.requestInfo?.headers) ?? session.cwd);
    session.server.setNotificationHandler(RootsListChangedNotificationSchema, async () => {
      session.rootsStale = true;
      session.rootsAttempts = 0;
    });
    session.transport.onclose = () => {
      const id = session.transport.sessionId;
      if (id) sessions.delete(id);
    };
    return session;
  };

  const refuse = (req: IncomingMessage, res: ServerResponse, status: number, message: string, context: Record<string, unknown>): void => {
    logger.warn('SECURITY', `MCP HTTP: ${message}`, { ...context, method: req.method, path: req.url });
    sendJsonRpcError(res, status, -32000, message);
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // Bound to loopback, so every peer should be local; checked anyway so a non-local
    // peer can never reach the tools, whatever the bind.
    if (!isLocalhost(req as unknown as ExpressRequest)) {
      refuse(req, res, 403, 'Forbidden: only loopback clients may connect', { peer: req.socket.remoteAddress });
      return;
    }
    // DNS rebinding: a page whose name was repointed at 127.0.0.1 still sends its own Host.
    const host = (req.headers.host ?? '').trim().toLowerCase();
    if (!allowedHosts(actualPort).includes(host)) {
      refuse(req, res, 403, `Forbidden: Host "${host}" is not a loopback name`, { host });
      return;
    }
    // A browser page other than an allowlisted one must not drive the tools (CSRF).
    const origin = firstHeader(req.headers.origin);
    if (origin !== undefined && !isOwnPageOrigin(origin, req.headers.host, options.originPolicy)) {
      refuse(req, res, 403, `Forbidden: Origin "${origin}" is not allowed (add it to CLAUDE_MEM_ALLOWED_ORIGINS to allow it)`, { origin });
      return;
    }

    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    if (url.pathname !== MCP_HTTP_PATH) {
      res.writeHead(404).end();
      return;
    }

    const cwdHeader = firstHeader(req.headers[CWD_HEADER]);
    if (cwdHeader !== undefined && normalizeCwd(cwdHeader) === null) {
      refuse(req, res, 400, `Bad Request: ${CWD_HEADER} must be an absolute path to an existing directory`, { cwd: cwdHeader });
      return;
    }

    const sessionId = firstHeader(req.headers['mcp-session-id']);

    if (sessionId) {
      const session = sessions.get(sessionId);
      if (!session) {
        sendJsonRpcError(res, 404, -32001, 'Session not found');
        return;
      }
      session.lastSeen = Date.now();
      applyHeaderCwd(session, req);
      const sessionBody = req.method === 'POST' ? await readJsonBody(req) : undefined;
      await ensureCwd(session, sessionBody);
      await session.transport.handleRequest(req, res, sessionBody);
      return;
    }

    if (req.method !== 'POST') {
      sendJsonRpcError(res, 400, -32000, 'Missing Mcp-Session-Id header');
      return;
    }
    const body = await readJsonBody(req);
    if (!isInitializeRequest(body)) {
      sendJsonRpcError(res, 400, -32000, 'Bad Request: no valid session; send initialize first');
      return;
    }
    if (sessions.size + initializing >= maxSessions) {
      logger.error('SYSTEM', `MCP HTTP: session limit reached (${maxSessions} open), refusing a new session`, {
        open: sessions.size,
        initializing,
      });
      sendJsonRpcError(res, 503, -32000,
        `MCP HTTP session limit reached (${maxSessions} open). Close idle MCP clients or restart the server.`);
      return;
    }
    initializing++;
    try {
      const session = createSession(req);
      await session.server.connect(session.transport);
      await session.transport.handleRequest(req, res, body);
    } finally {
      initializing--;
    }
  };

  let actualPort = options.port;
  const httpServer = createHttpServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (error instanceof RequestBodyError) {
        logger.warn('SYSTEM', `MCP HTTP: ${error.message}`, { method: req.method, path: req.url });
        sendJsonRpcError(res, error.httpStatus, error.jsonRpcCode, error.message);
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      logger.error('SYSTEM', 'MCP HTTP request failed', undefined, error instanceof Error ? error : new Error(message));
      sendJsonRpcError(res, 500, -32603, message);
    });
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    httpServer.once('error', rejectListen);
    httpServer.listen(options.port, bindHost, () => {
      httpServer.off('error', rejectListen);
      resolveListen();
    });
  });
  actualPort = (httpServer.address() as AddressInfo).port;

  const sweeper = setInterval(() => {
    const cutoff = Date.now() - SESSION_IDLE_MS;
    for (const [id, session] of sessions) {
      if (session.lastSeen < cutoff) {
        sessions.delete(id);
        void session.transport.close().catch(() => {});
      }
    }
  }, SWEEP_INTERVAL_MS);
  sweeper.unref();

  return {
    port: actualPort,
    sessionCount: () => sessions.size,
    close: async () => {
      clearInterval(sweeper);
      const open = [...sessions.values()];
      sessions.clear();
      await Promise.allSettled(open.map((s) => s.transport.close()));
      httpServer.closeAllConnections?.();
      await new Promise<void>((resolveClose) => httpServer.close(() => resolveClose()));
    },
  };
}
