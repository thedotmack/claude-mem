// Streamable HTTP front for the claude-mem MCP server.
//
// stdio MCP servers are one process per client session. This serves many clients
// from one process: every MCP session gets its own Server instance and a working
// directory (the project), so the tools that scope by project still work.
//
// Where a session's working directory comes from, highest priority first:
//   1. the `X-Claude-Mem-Cwd` request header (Claude Code: `${CLAUDE_PROJECT_DIR}`),
//   2. the MCP `roots/list` answer of the client (opencode answers with the project),
//   3. the server process' own cwd.
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { logger } from '../utils/logger.js';

export const CWD_HEADER = 'x-claude-mem-cwd';
export const MCP_HTTP_PATH = '/mcp';
export const DEFAULT_HTTP_HOST = '127.0.0.1';
export const DEFAULT_HTTP_PORT = 37790;

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const SESSION_IDLE_MS = 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const ROOTS_TIMEOUT_MS = 2000;
const MAX_ROOTS_ATTEMPTS = 3;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

export interface McpHttpOptions {
  host: string;
  port: number;
  /** Bearer token required on every request. Mandatory for a non-loopback host. */
  token?: string;
}

/**
 * Read the HTTP options from the command line and environment.
 * Returns null when HTTP mode was not requested (the server then speaks stdio).
 * The token is read from the environment only, so it never shows in a process list.
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

  const host = flag('host') ?? env.CLAUDE_MEM_MCP_HTTP_HOST ?? DEFAULT_HTTP_HOST;
  const portText = flag('port') ?? env.CLAUDE_MEM_MCP_HTTP_PORT ?? String(DEFAULT_HTTP_PORT);
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid MCP HTTP port: ${portText}`);
  }
  const token = env.CLAUDE_MEM_MCP_HTTP_TOKEN?.trim() || undefined;
  if (!LOOPBACK_HOSTS.has(host) && !token) {
    throw new Error(`Refusing to listen on ${host} without CLAUDE_MEM_MCP_HTTP_TOKEN`);
  }
  return { host, port, token };
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

/** Host header values we answer to (DNS rebinding protection): the loopback names plus the bind host. */
export function allowedHosts(bindHost: string, port: number): string[] {
  const names = new Set([...LOOPBACK_HOSTS, bindHost]);
  const bare = [...names].map((h) => (h.includes(':') ? `[${h}]` : h));
  return bare.flatMap((h) => [h, `${h}:${port}`]);
}

/** Constant-time check of an `Authorization: Bearer <token>` header. */
export function isAuthorized(authorization: string | undefined, token: string | undefined): boolean {
  if (!token) return true;
  const match = /^Bearer\s+(.+)$/i.exec(authorization ?? '');
  if (!match) return false;
  const given = Buffer.from(match[1].trim());
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

type CwdSource = 'header' | 'roots' | 'default';

interface Session {
  transport: StreamableHTTPServerTransport;
  server: Server;
  cwd: string;
  cwdSource: CwdSource;
  lastSeen: number;
  rootsAttempts: number;
  rootsInFlight?: Promise<void>;
}

export interface McpHttpHandle {
  port: number;
  sessionCount(): number;
  close(): Promise<void>;
}

export interface StartMcpHttpOptions extends McpHttpOptions {
  /** Build one MCP Server for one session; `getCwd` returns that session's project directory. */
  createServer: (getCwd: () => string) => Server;
}

function sendJsonRpcError(res: ServerResponse, status: number, code: number, message: string): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

export async function startMcpHttpServer(options: StartMcpHttpOptions): Promise<McpHttpHandle> {
  const sessions = new Map<string, Session>();
  const defaultCwd = process.cwd();

  const applyHeaderCwd = (session: Session, req: IncomingMessage): void => {
    const header = req.headers[CWD_HEADER];
    const cwd = normalizeCwd(Array.isArray(header) ? header[0] : header);
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
      // A client that has not opened its standalone SSE stream cannot answer; do not wait a minute for it.
      const { roots } = await session.server.listRoots(undefined, { timeout: ROOTS_TIMEOUT_MS });
      const cwd = cwdFromRoots(roots);
      // The header may have arrived while we waited for the client's answer.
      if (cwd && (session.cwdSource as CwdSource) !== 'header') {
        session.cwd = cwd;
        session.cwdSource = 'roots';
      }
    } catch (error) {
      logger.warn('SYSTEM', 'MCP HTTP: roots/list failed, keeping default cwd', undefined,
        error instanceof Error ? error : new Error(String(error)));
    }
  };

  // The client's roots are fetched lazily, at its first real request: right after `initialize`
  // it may not have opened the standalone SSE stream yet, and the server's request would be lost.
  const ensureCwd = async (session: Session, body: unknown): Promise<void> => {
    const method = (body as { method?: unknown } | undefined)?.method;
    if (typeof method !== 'string' || method === 'initialize' || method.startsWith('notifications/')) return;
    if (session.cwdSource !== 'default' || session.rootsAttempts >= MAX_ROOTS_ATTEMPTS) return;
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
    } as Session;
    applyHeaderCwd(session, req);
    session.transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => {
        sessions.set(sessionId, session);
      },
      enableDnsRebindingProtection: true,
      allowedHosts: allowedHosts(options.host, actualPort),
      allowedOrigins: [],
    });
    session.server = options.createServer(() => session.cwd);
    session.transport.onclose = () => {
      const id = session.transport.sessionId;
      if (id) sessions.delete(id);
    };
    return session;
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', sessions: sessions.size }));
      return;
    }
    if (url.pathname !== MCP_HTTP_PATH) {
      res.writeHead(404).end();
      return;
    }
    if (!isAuthorized(req.headers.authorization, options.token)) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      sendJsonRpcError(res, 401, -32001, 'Unauthorized');
      return;
    }

    const sessionIdHeader = req.headers['mcp-session-id'];
    const sessionId = Array.isArray(sessionIdHeader) ? sessionIdHeader[0] : sessionIdHeader;

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
    const session = createSession(req);
    await session.server.connect(session.transport);
    await session.transport.handleRequest(req, res, body);
  };

  let actualPort = options.port;
  const httpServer = createHttpServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('SYSTEM', 'MCP HTTP request failed', undefined, error instanceof Error ? error : new Error(message));
      sendJsonRpcError(res, message === 'Request body too large' ? 413 : 500, -32603, message);
    });
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    httpServer.once('error', rejectListen);
    httpServer.listen(options.port, options.host, () => {
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
