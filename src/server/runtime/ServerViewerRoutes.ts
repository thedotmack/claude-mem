// SPDX-License-Identifier: Apache-2.0
//
// #2552 — Viewer UI on the server runtime.
//
// The Viewer UI (plugin/ui/viewer.html) is served by the in-plugin worker via
// ViewerRoutes, but the server-beta runtime never mounted any static handler,
// so the viewer was unreachable. This handler mirrors the worker's static
// serving: it caches viewer.html at boot and serves it at `/` plus any static
// assets under the package `ui` directory.
//
// The viewer reads its feed from worker-shaped endpoints (`/stream`,
// `/api/projects`, `/api/observations`, `/api/summaries`, `/api/sessions`, ...)
// that the server runtime never had, so the page loaded but stayed empty. When
// a Postgres pool is supplied, this handler also serves those endpoints from
// the server's own tables, in the shapes the viewer expects.
//
// Access: every data endpoint requires an API key with `memories:read` (Bearer
// or X-Api-Key) and is scoped to that key's team, and to its project when the
// key is project-bound, exactly like /v1.
//
// The daily log (`/api/logs`, `POST /api/logs/clear`) is one file for the
// whole server, not a per-team resource: the worker serves it loopback-only,
// and here no tenant key may read or wipe it, so both answer 404.

import express, { type Application, type Request, type Response } from 'express';
import path from 'path';
import { existsSync, readFileSync } from 'fs';
import type { RouteHandler } from '../../services/server/Server.js';
import type { PostgresPool } from '../../storage/postgres/pool.js';
import { requirePostgresServerAuth } from '../middleware/postgres-auth.js';
import { getPackageRoot } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';

const VIEWER_HTML_CANDIDATE_PATHS: readonly string[] = (() => {
  const packageRoot = getPackageRoot();
  return [
    path.join(packageRoot, 'ui', 'viewer.html'),
    path.join(packageRoot, 'plugin', 'ui', 'viewer.html'),
  ];
})();

const resolvedViewerHtmlPath: string | null =
  VIEWER_HTML_CANDIDATE_PATHS.find(candidate => existsSync(candidate)) ?? null;

const viewerHtmlBytes: Buffer | null = resolvedViewerHtmlPath
  ? readFileSync(resolvedViewerHtmlPath)
  : null;

if (resolvedViewerHtmlPath) {
  logger.info('SYSTEM', 'Cached viewer.html at boot (server runtime)', {
    path: resolvedViewerHtmlPath,
    bytes: viewerHtmlBytes!.byteLength,
  });
} else {
  logger.warn('SYSTEM', 'viewer.html not found for server runtime', {
    candidates: VIEWER_HTML_CANDIDATE_PATHS,
  });
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_FEED_PAGE_SIZE = 200;
const MAX_SESSION_PAGE_SIZE = 100;
const STREAM_KEEPALIVE_MS = 15_000;

// The viewer groups by the folder label hooks attach (`metadata.project`), not
// by the server's project row. Rows written without a label (manual memories,
// imports) fall back to the server project's name.
const OBSERVATION_PROJECT_LABEL =
  "COALESCE(NULLIF(o.metadata->>'project', ''), NULLIF(s.metadata->>'project', ''), p.name)";
const SESSION_PROJECT_LABEL = "COALESCE(NULLIF(s.metadata->>'project', ''), p.name)";
// Rows without a session (manual memories, imports) have no adapter; the
// viewer's default source is 'claude'.
const PLATFORM_SOURCE = "COALESCE(NULLIF(s.platform_source, ''), 'claude')";

export interface ServerViewerRoutesOptions {
  /** Without a pool only the static viewer is mounted. */
  pool?: PostgresPool;
  /** Same value the /v1 routes use. */
  authMode?: string;
}

/** Team/project a request may read. Null fields mean "not restricted". */
interface ViewerScope {
  teamId: string | null;
  projectId: string | null;
}

/** Collects positional parameters for a dynamically filtered query. */
class SqlParams {
  readonly values: unknown[] = [];
  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

export class ServerViewerRoutes implements RouteHandler {
  constructor(private readonly options: ServerViewerRoutesOptions = {}) {}

  setupRoutes(app: Application): void {
    const packageRoot = getPackageRoot();
    // Serve static assets from BOTH the npm-package `ui` dir and the plugin
    // `plugin/ui` dir, matching the worker's resolution order so the viewer
    // loads regardless of which layout the server image ships.
    app.use(express.static(path.join(packageRoot, 'ui')));
    app.use(express.static(path.join(packageRoot, 'plugin', 'ui')));

    app.get('/', (_req: Request, res: Response) => {
      if (!viewerHtmlBytes) {
        res.status(503).json({ error: 'ViewerUnavailable', message: 'Viewer UI not found at any expected location' });
        return;
      }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(viewerHtmlBytes);
    });

    if (this.options.pool) {
      this.setupDataRoutes(app, this.options.pool);
    }
  }

  // Exposed for tests: did the build ship a viewer.html the server can serve?
  static hasViewerHtml(): boolean {
    return viewerHtmlBytes !== null;
  }

  private setupDataRoutes(app: Application, pool: PostgresPool): void {
    const read = requirePostgresServerAuth(pool, {
      authMode: this.options.authMode,
      requiredScopes: ['memories:read'],
    });

    app.get('/stream', read, this.handle(async (req, res) => {
      const scope = this.scopeOf(req, res);
      if (!scope) return;
      const [catalog, status] = await Promise.all([
        fetchProjectCatalog(pool, scope),
        fetchProcessingStatus(pool, scope),
      ]);

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();
      const send = (event: unknown) => res.write(`data: ${JSON.stringify(event)}\n\n`);
      send({ type: 'initial_load', ...catalog, timestamp: Date.now() });
      send({ type: 'processing_status', ...status });

      // The server runtime has no in-process event bus to push new rows; the
      // viewer's own polling refreshes the feed. Keep the stream open so it
      // does not reconnect in a loop.
      const keepalive = setInterval(() => res.write(': keepalive\n\n'), STREAM_KEEPALIVE_MS);
      req.on('close', () => clearInterval(keepalive));
    }));

    app.get('/api/projects', read, this.handle(async (req, res) => {
      const scope = this.scopeOf(req, res);
      if (!scope) return;
      res.json(await fetchProjectCatalog(pool, scope));
    }));

    app.get('/api/observations', read, this.handle(async (req, res) => {
      const scope = this.scopeOf(req, res);
      if (!scope) return;
      const page = parsePage(req, MAX_FEED_PAGE_SIZE);
      const rows = await queryFeed(pool, scope, req, page, { summaries: false });
      res.json(toPage(rows, page.limit, toViewerObservation));
    }));

    app.get('/api/summaries', read, this.handle(async (req, res) => {
      const scope = this.scopeOf(req, res);
      if (!scope) return;
      const page = parsePage(req, MAX_FEED_PAGE_SIZE);
      const rows = await queryFeed(pool, scope, req, page, { summaries: true });
      res.json(toPage(rows, page.limit, toViewerSummary));
    }));

    app.get('/api/sessions', read, this.handle(async (req, res) => {
      const scope = this.scopeOf(req, res);
      if (!scope) return;
      const page = parsePage(req, MAX_SESSION_PAGE_SIZE);
      const rows = await querySessions(pool, scope, req, page);
      const { items, hasMore } = toPage(rows, page.limit, toViewerSession);
      res.json({ sessions: items, hasMore });
    }));

    app.get('/api/processing-status', read, this.handle(async (req, res) => {
      const scope = this.scopeOf(req, res);
      if (!scope) return;
      res.json(await fetchProcessingStatus(pool, scope));
    }));

    // The server stores prompts only inside raw agent events and has no
    // viewer settings or local backups; answer with empty values so those
    // panels render instead of erroring.
    app.get('/api/prompts', read, (_req: Request, res: Response) => {
      res.json({ items: [], hasMore: false });
    });
    app.get('/api/settings', read, (_req: Request, res: Response) => {
      res.json({});
    });
    app.get('/api/backup/status', read, (_req: Request, res: Response) => {
      res.json({ configured: false });
    });

    // The log is server-wide, so a tenant key gets neither its content nor a
    // way to clear it. Answered after auth so the 401 contract matches the
    // other viewer routes; the viewer's log panel shows the 404 as an error.
    const logUnavailable = (_req: Request, res: Response) => {
      res.status(404).json({
        error: 'NotFound',
        message: 'The server log is shared across teams and is not served per API key; read it on the host',
      });
    };
    app.get('/api/logs', read, logUnavailable);
    app.post('/api/logs/clear', read, logUnavailable);
  }

  /** Resolves the read scope, or answers 403 for a key bound to no team. */
  private scopeOf(req: Request, res: Response): ViewerScope | null {
    const ctx = req.authContext;
    if (!ctx || ctx.mode === 'local-dev') {
      return { teamId: null, projectId: null };
    }
    if (!ctx.teamId) {
      res.status(403).json({ error: 'Forbidden', message: 'API key is not bound to a team' });
      return null;
    }
    return { teamId: ctx.teamId, projectId: ctx.projectId ?? null };
  }

  private handle(
    fn: (req: Request, res: Response) => Promise<void>,
  ): (req: Request, res: Response) => void {
    return (req, res) => {
      fn(req, res).catch((error: unknown) => {
        const err = error instanceof Error ? error : new Error(String(error));
        logger.warn('HTTP', 'Viewer data route failed (server runtime)', { path: req.path }, err);
        if (!res.headersSent) {
          res.status(500).json({ error: 'InternalError', message: 'Viewer query failed' });
        } else {
          res.end();
        }
      });
    };
  }
}

interface Page {
  limit: number;
  offset: number;
}

function parsePage(req: Request, maxLimit: number): Page {
  const limit = parseNonNegativeInt(req.query.limit) ?? DEFAULT_PAGE_SIZE;
  const offset = parseNonNegativeInt(req.query.offset) ?? 0;
  return { limit: Math.min(Math.max(limit, 1), maxLimit), offset };
}

function parseNonNegativeInt(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function queryString(req: Request, name: string): string | null {
  const value = req.query[name];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Fetches one extra row so the caller can report hasMore without a COUNT. */
function toPage<Row, Item>(rows: Row[], limit: number, map: (row: Row) => Item): { items: Item[]; hasMore: boolean } {
  return { items: rows.slice(0, limit).map(map), hasMore: rows.length > limit };
}

function scopeClause(scope: ViewerScope, params: SqlParams, alias: string): string {
  let clause = '';
  if (scope.teamId) clause += ` AND ${alias}.team_id = ${params.add(scope.teamId)}`;
  if (scope.projectId) clause += ` AND ${alias}.project_id = ${params.add(scope.projectId)}`;
  return clause;
}

async function fetchProjectCatalog(
  pool: PostgresPool,
  scope: ViewerScope,
): Promise<{ projects: string[]; sources: string[]; projectsBySource: Record<string, string[]> }> {
  const params = new SqlParams();
  const observationScope = scopeClause(scope, params, 'o');
  const sessionScope = scopeClause(scope, params, 's');
  const result = await pool.query<{ platform_source: string; project: string; last_seen: Date }>(
    `SELECT platform_source, project, max(last_seen) AS last_seen FROM (
       SELECT ${PLATFORM_SOURCE} AS platform_source, ${OBSERVATION_PROJECT_LABEL} AS project, max(o.created_at) AS last_seen
         FROM observations o
         JOIN projects p ON p.id = o.project_id
         LEFT JOIN server_sessions s ON s.id = o.server_session_id
        WHERE TRUE${observationScope}
        GROUP BY 1, 2
       UNION ALL
       SELECT ${PLATFORM_SOURCE} AS platform_source, ${SESSION_PROJECT_LABEL} AS project, max(s.created_at) AS last_seen
         FROM server_sessions s
         JOIN projects p ON p.id = s.project_id
        WHERE TRUE${sessionScope}
        GROUP BY 1, 2
     ) labels
     WHERE project IS NOT NULL
     GROUP BY platform_source, project
     ORDER BY last_seen DESC`,
    params.values,
  );

  // Most recently active first, which is the order the viewer's project
  // picker shows.
  const projects: string[] = [];
  const projectsBySource: Record<string, string[]> = {};
  for (const row of result.rows) {
    if (!projects.includes(row.project)) projects.push(row.project);
    (projectsBySource[row.platform_source] ??= []).push(row.project);
  }
  return { projects, sources: Object.keys(projectsBySource), projectsBySource };
}

async function fetchProcessingStatus(
  pool: PostgresPool,
  scope: ViewerScope,
): Promise<{ isProcessing: boolean; queueDepth: number }> {
  const params = new SqlParams();
  const result = await pool.query<{ depth: string }>(
    `SELECT count(*) AS depth
       FROM observation_generation_jobs j
      WHERE j.status IN ('queued', 'processing')${scopeClause(scope, params, 'j')}`,
    params.values,
  );
  const queueDepth = Number(result.rows[0]?.depth ?? 0);
  return { isProcessing: queueDepth > 0, queueDepth };
}

interface FeedRow {
  id: string;
  server_session_id: string | null;
  content_session_id: string | null;
  project: string;
  platform_source: string;
  kind: string;
  content: string;
  metadata: Record<string, unknown> | null;
  created_at: Date;
}

async function queryFeed(
  pool: PostgresPool,
  scope: ViewerScope,
  req: Request,
  page: Page,
  options: { summaries: boolean },
): Promise<FeedRow[]> {
  const params = new SqlParams();
  let where = options.summaries ? "o.kind = 'summary'" : "o.kind <> 'summary'";
  where += scopeClause(scope, params, 'o');
  const project = queryString(req, 'project');
  if (project) where += ` AND ${OBSERVATION_PROJECT_LABEL} = ${params.add(project)}`;
  const platformSource = queryString(req, 'platformSource');
  if (platformSource) where += ` AND ${PLATFORM_SOURCE} = ${params.add(platformSource)}`;
  const contentSessionId = queryString(req, 'contentSessionId');
  if (contentSessionId) {
    const id = params.add(contentSessionId);
    where += ` AND (s.content_session_id = ${id} OR o.server_session_id = ${id})`;
  }

  const result = await pool.query<FeedRow>(
    `SELECT o.id, o.server_session_id, s.content_session_id,
            ${OBSERVATION_PROJECT_LABEL} AS project, ${PLATFORM_SOURCE} AS platform_source,
            o.kind, o.content, o.metadata, o.created_at
       FROM observations o
       JOIN projects p ON p.id = o.project_id
       LEFT JOIN server_sessions s ON s.id = o.server_session_id
      WHERE ${where}
      ORDER BY o.created_at DESC, o.id DESC
      LIMIT ${params.add(page.limit + 1)} OFFSET ${params.add(page.offset)}`,
    params.values,
  );
  return result.rows;
}

interface SessionRow {
  id: string;
  content_session_id: string | null;
  project: string;
  platform_source: string;
  custom_title: string | null;
  created_at: Date;
  item_count: string;
}

async function querySessions(
  pool: PostgresPool,
  scope: ViewerScope,
  req: Request,
  page: Page,
): Promise<SessionRow[]> {
  const params = new SqlParams();
  let where = `TRUE${scopeClause(scope, params, 's')}`;
  const project = queryString(req, 'project');
  if (project) where += ` AND ${SESSION_PROJECT_LABEL} = ${params.add(project)}`;
  const platformSource = queryString(req, 'platformSource');
  if (platformSource) where += ` AND ${PLATFORM_SOURCE} = ${params.add(platformSource)}`;

  const result = await pool.query<SessionRow>(
    `SELECT s.id, s.content_session_id,
            ${SESSION_PROJECT_LABEL} AS project, ${PLATFORM_SOURCE} AS platform_source,
            -- session-init stores the opening prompt; it stands in for a title.
            COALESCE(NULLIF(s.metadata->>'title', ''), LEFT(NULLIF(s.metadata->>'prompt', ''), 120)) AS custom_title,
            s.created_at,
            (SELECT count(*) FROM observations o WHERE o.server_session_id = s.id) AS item_count
       FROM server_sessions s
       JOIN projects p ON p.id = s.project_id
      WHERE ${where}
      ORDER BY s.created_at DESC, s.id DESC
      LIMIT ${params.add(page.limit + 1)} OFFSET ${params.add(page.offset)}`,
    params.values,
  );
  return result.rows;
}

function metadataOf(row: { metadata: Record<string, unknown> | null }): Record<string, unknown> {
  return row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

// The worker stores facts/concepts/files as JSON-encoded strings, and the
// viewer parses them as such; the server stores real arrays.
function jsonListOrNull(value: unknown): string | null {
  if (Array.isArray(value)) return value.length > 0 ? JSON.stringify(value) : null;
  return stringOrNull(value);
}

function toViewerObservation(row: FeedRow) {
  const meta = metadataOf(row);
  const createdAt = new Date(row.created_at);
  const promptNumber = Number(meta.prompt_number);
  return {
    id: row.id,
    memory_session_id: row.server_session_id ?? '',
    content_session_id: row.content_session_id ?? '',
    project: row.project,
    platform_source: row.platform_source,
    type: row.kind,
    title: stringOrNull(meta.title),
    subtitle: stringOrNull(meta.subtitle),
    narrative: stringOrNull(meta.narrative),
    text: row.content || null,
    facts: jsonListOrNull(meta.facts),
    concepts: jsonListOrNull(meta.concepts),
    files_read: jsonListOrNull(meta.files_read),
    files_modified: jsonListOrNull(meta.files_modified),
    prompt_number: Number.isSafeInteger(promptNumber) ? promptNumber : null,
    created_at: createdAt.toISOString(),
    created_at_epoch: createdAt.getTime(),
  };
}

function toViewerSummary(row: FeedRow) {
  const meta = metadataOf(row);
  return {
    id: row.id,
    session_id: row.server_session_id ?? '',
    content_session_id: row.content_session_id ?? '',
    project: row.project,
    platform_source: row.platform_source,
    request: stringOrNull(meta.request) ?? undefined,
    investigated: stringOrNull(meta.investigated) ?? undefined,
    learned: stringOrNull(meta.learned) ?? undefined,
    completed: stringOrNull(meta.completed) ?? undefined,
    next_steps: stringOrNull(meta.next_steps) ?? undefined,
    notes: stringOrNull(meta.notes),
    created_at_epoch: new Date(row.created_at).getTime(),
  };
}

function toViewerSession(row: SessionRow) {
  return {
    content_session_id: row.content_session_id ?? row.id,
    project: row.project,
    platform_source: row.platform_source,
    custom_title: row.custom_title,
    started_at_epoch: new Date(row.created_at).getTime(),
    item_count: Number(row.item_count),
  };
}
