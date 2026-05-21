// SPDX-License-Identifier: Apache-2.0
//
// mount the viewer UI on the server-beta runtime.
//
// Worker mode serves the viewer at http://localhost:37703 (UID-derived) via
// express.static + ViewerRoutes. Server-beta lacked all of that, so operators
// got 'Cannot GET /' on http://127.0.0.1:37877 and had no way to introspect
// their memories without writing curl scripts.
//
// The viewer-bundle.js is identical to worker mode — same React app, same
// endpoint paths. We map them server-side here so the bundle works unchanged.
//
// Response contract (matches src/ui/viewer/hooks/usePagination.ts):
//   GET  /api/{observations,summaries,prompts}?offset=&limit=&project=
//     -> { items: TItem[], hasMore: boolean }
//   GET  /api/stats
//     -> { observations, summaries, prompts, projects } as numbers
//   GET  /api/processing-status
//     -> { isProcessing, queueDepth }
//   GET  /api/settings
//     -> the flat settings.json (API key redacted)
//   POST /api/settings
//     -> persists the body keys to ~/.claude-mem/settings.json
//   GET  /api/logs
//     -> { logs: Array<{ timestamp, level, component, message }> }
//   POST /api/logs/clear
//     -> { cleared: true }
//
// SSE contract (matches src/ui/viewer/hooks/useSSE.ts):
//   event: message
//   data: { type: 'initial_load', projects: string[] }
//   data: { type: 'new_observation', observation: { id, project, content, ... } }
//   data: { type: 'new_summary', summary: ... }
//   data: { type: 'processing_status', isProcessing, queueDepth }

import type { Application, Request, Response } from 'express';
import express from 'express';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, truncateSync, writeFileSync } from 'fs';
import { join } from 'path';
import { logger } from '../../utils/logger.js';
import type { ServerBetaServiceGraph } from './types.js';

// Locate viewer.html across in-container, repo-dev, and marketplace layouts.
function locatePluginUiDir(): string | null {
  const explicit = (process.env.CLAUDE_MEM_UI_DIR ?? '').trim();
  if (explicit && existsSync(join(explicit, 'viewer.html'))) return explicit;

  const candidates = [
    '/opt/claude-mem/ui',
    join(process.cwd(), 'plugin', 'ui'),
    join(process.env.HOME ?? '/root', '.claude/plugins/marketplaces/thedotmack/plugin/ui'),
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, 'viewer.html'))) return dir;
  }
  return null;
}

// Resolved lazily by setupViewerUi() so the module has no side effects at
// import time — makes test setup, conditional mounting, and SSR scenarios
// cleaner. Cached after first resolution to keep subsequent setup* calls fast.
let VIEWER_UI_DIR: string | null = null;
let viewerUiResolved = false;
function getViewerUiDir(): string | null {
  if (!viewerUiResolved) {
    VIEWER_UI_DIR = locatePluginUiDir();
    viewerUiResolved = true;
  }
  return VIEWER_UI_DIR;
}
const SETTINGS_PATH = join(process.env.HOME ?? '/root', '.claude-mem', 'settings.json');
// In Docker the worker writes logs to /data/claude-mem/logs (CLAUDE_MEM_DATA_DIR).
const LOGS_DIR = join(process.env.CLAUDE_MEM_DATA_DIR ?? join(process.env.HOME ?? '/root', '.claude-mem'), 'logs');

// ─── Shared helpers ─────────────────────────────────────────────────────────

interface ListQuery {
  project?: string;
  limit: number;
  offset: number;
}

function parseListQuery(req: Request): ListQuery {
  // Viewer sends `project` (singular). Be lenient and accept `projectId` too.
  const raw = req.query.project ?? req.query.projectId;
  const project = typeof raw === 'string' && raw.length > 0 && raw !== 'undefined' ? raw : undefined;
  const limitRaw = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : NaN;
  const offsetRaw = typeof req.query.offset === 'string' ? Number.parseInt(req.query.offset, 10) : NaN;
  return {
    project,
    limit: Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 500) : 50,
    offset: Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0,
  };
}

// Compose the project descriptor the viewer expects: a string id derived from
// project_id. Worker mode uses a directory-derived name; in server-beta we
// expose the UUID directly since project_id is the canonical key.
// Observation row shape the viewer-bundle.js expects. The shape comes from
// worker mode (sqlite columns) and is snake_case + flat: title/subtitle/
// narrative/facts/concepts/files_read/files_modified are lifted out of the
// Postgres `metadata` JSONB column so the React card components can read
// them without traversing nested objects. JSON-array fields are emitted as
// STRING-encoded JSON because ObservationCard.tsx does JSON.parse(...) on them.
function viewerObservationFromRow(row: {
  id: string;
  project_id: string;
  team_id: string;
  kind: string;
  content: string;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}) {
  const meta = (row.metadata ?? {}) as Record<string, unknown>;
  const liftString = (key: string): string | undefined => {
    const v = meta[key];
    return typeof v === 'string' && v.length > 0 ? v : undefined;
  };
  const liftJsonArray = (key: string): string | undefined => {
    const v = meta[key];
    if (Array.isArray(v)) return JSON.stringify(v);
    if (typeof v === 'string' && v.length > 0) return v;
    return undefined;
  };
  return {
    id: row.id,
    // Worker contract: snake_case fields + flat title/subtitle/narrative.
    project: row.project_id,
    projectId: row.project_id,
    teamId: row.team_id,
    type: row.kind,
    kind: row.kind,
    platform_source: liftString('platformSource') ?? liftString('platform_source') ?? 'claude',
    title: liftString('title'),
    subtitle: liftString('subtitle'),
    narrative: liftString('narrative') ?? row.content,
    text: row.content,
    content: row.content,
    facts: liftJsonArray('facts'),
    concepts: liftJsonArray('concepts'),
    files_read: liftJsonArray('files_read'),
    files_modified: liftJsonArray('files_modified'),
    metadata: row.metadata,
    timestamp: row.created_at.toISOString(),
    created_at: row.created_at.toISOString(),
    created_at_epoch: row.created_at.getTime(),
    createdAtEpoch: row.created_at.getTime(),
    updatedAtEpoch: row.updated_at.getTime(),
    memory_session_id: liftString('serverSessionId') ?? null,
  };
}

// ─── 1. Static file serving + index ─────────────────────────────────────────

export function setupViewerUi(app: Application): void {
  const dir = getViewerUiDir();
  if (!dir) {
    logger.warn('SYSTEM', 'Viewer UI not found at any expected location; GET / will 404', {
      hint: 'set CLAUDE_MEM_UI_DIR or copy plugin/ui/ to one of the standard paths',
    });
    return;
  }
  logger.info('SYSTEM', 'Viewer UI mounted on server-beta', { dir });
  app.use(express.static(dir));

  // Cache the index HTML at boot.
  const indexBytes = readFileSync(join(dir, 'viewer.html'));
  app.get('/', (_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(indexBytes);
  });
}

// ─── 2. API compatibility shims — /api/* → Postgres ─────────────────────────

// Loopback-only guard for the viewer compat shims. The /api/* and /stream
// routes ship without bearer-token enforcement so the bundled React app can
// load without baking the server API key into the page. To keep that safe,
// we restrict the routes to loopback addresses; any non-loopback request
// is rejected with 403. Operators who want to expose the viewer remotely
// should front it with their own authenticated reverse-proxy.
function requireLoopback(req: Request, res: Response, next: () => void): void {
  const ip = req.ip ?? '';
  const isLoopback =
    ip === '127.0.0.1' ||
    ip === '::1' ||
    ip === '::ffff:127.0.0.1' ||
    ip.startsWith('127.');
  if (!isLoopback) {
    res.status(403).json({
      error: 'Forbidden',
      message: 'Viewer compat routes (/api/*, /stream) are loopback-only. Front with an authenticated reverse-proxy for remote access.',
    });
    return;
  }
  next();
}

export function setupViewerApiCompat(app: Application, graph: ServerBetaServiceGraph): void {
  const pool = graph.postgres.pool;

  // Gate every /api/* route behind the loopback check so unauthenticated
  // remote callers can't bypass the server's main auth middleware via these
  // viewer-only compat shims.
  app.use('/api', requireLoopback);

  // JSON body parser for POST /api/settings + POST /api/logs/clear.
  // Server-beta's main routes use their own parser; mount a separate one
  // scoped to /api so we don't double-parse upstream.
  app.use('/api', express.json({ limit: '1mb' }));

  // GET /api/observations — paginated list, newest first.
  app.get('/api/observations', async (req: Request, res: Response) => {
    try {
      const { project, limit, offset } = parseListQuery(req);
      const params: unknown[] = [limit, offset];
      let projectClause = '';
      if (project) {
        params.push(project);
        projectClause = `WHERE project_id = $${params.length}`;
      }
      const result = await pool.query<{
        id: string;
        project_id: string;
        team_id: string;
        kind: string;
        content: string;
        metadata: Record<string, unknown>;
        created_at: Date;
        updated_at: Date;
      }>(
        `SELECT id, project_id, team_id, kind, content, metadata, created_at, updated_at
         FROM observations
         ${projectClause}
         ORDER BY created_at DESC
         LIMIT $1 OFFSET $2`,
        params,
      );
      res.json({
        items: result.rows.map(viewerObservationFromRow),
        hasMore: result.rows.length === limit,
      });
    } catch (err) {
      logger.warn('HTTP', '/api/observations failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ error: 'InternalError', items: [], hasMore: false });
    }
  });

  app.get('/api/summaries', async (req: Request, res: Response) => {
    try {
      const { project, limit, offset } = parseListQuery(req);
      const params: unknown[] = [limit, offset];
      let projectClause = '';
      if (project) {
        params.push(project);
        projectClause = `AND project_id = $${params.length}`;
      }
      const result = await pool.query<{
        id: string;
        project_id: string;
        content: string;
        metadata: Record<string, unknown>;
        created_at: Date;
      }>(
        `SELECT id, project_id, content, metadata, created_at
         FROM observations
         WHERE kind = 'session_summary'
         ${projectClause}
         ORDER BY created_at DESC
         LIMIT $1 OFFSET $2`,
        params,
      );
      res.json({
        items: result.rows.map((r) => ({
          id: r.id,
          project: r.project_id,
          projectId: r.project_id,
          content: r.content,
          metadata: r.metadata,
          timestamp: r.created_at.toISOString(),
          createdAtEpoch: r.created_at.getTime(),
        })),
        hasMore: result.rows.length === limit,
      });
    } catch (err) {
      logger.warn('HTTP', '/api/summaries failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ error: 'InternalError', items: [], hasMore: false });
    }
  });

  app.get('/api/prompts', async (req: Request, res: Response) => {
    try {
      const { project, limit, offset } = parseListQuery(req);
      const params: unknown[] = [limit, offset];
      let projectClause = '';
      if (project) {
        params.push(project);
        projectClause = `AND project_id = $${params.length}`;
      }
      const result = await pool.query<{
        id: string;
        project_id: string;
        payload: { prompt?: string };
        occurred_at: Date;
      }>(
        `SELECT id, project_id, payload, occurred_at
         FROM agent_events
         WHERE event_type = 'UserPromptSubmit'
         ${projectClause}
         ORDER BY occurred_at DESC
         LIMIT $1 OFFSET $2`,
        params,
      );
      res.json({
        items: result.rows.map((r) => ({
          id: r.id,
          project: r.project_id,
          projectId: r.project_id,
          prompt: r.payload?.prompt ?? '',
          timestamp: r.occurred_at.toISOString(),
          createdAtEpoch: r.occurred_at.getTime(),
        })),
        hasMore: result.rows.length === limit,
      });
    } catch (err) {
      logger.warn('HTTP', '/api/prompts failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ error: 'InternalError', items: [], hasMore: false });
    }
  });

  app.get('/api/stats', async (_req: Request, res: Response) => {
    try {
      const result = await pool.query<{
        observations: string;
        summaries: string;
        prompts: string;
        projects: string;
      }>(
        `SELECT
           (SELECT COUNT(*) FROM observations) AS observations,
           (SELECT COUNT(*) FROM observations WHERE kind = 'session_summary') AS summaries,
           (SELECT COUNT(*) FROM agent_events WHERE event_type = 'UserPromptSubmit') AS prompts,
           (SELECT COUNT(*) FROM projects) AS projects`,
      );
      const row = result.rows[0];
      res.json({
        observations: Number.parseInt(row?.observations ?? '0', 10),
        summaries: Number.parseInt(row?.summaries ?? '0', 10),
        prompts: Number.parseInt(row?.prompts ?? '0', 10),
        projects: Number.parseInt(row?.projects ?? '0', 10),
      });
    } catch (err) {
      logger.warn('HTTP', '/api/stats failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ error: 'InternalError', observations: 0, summaries: 0, prompts: 0, projects: 0 });
    }
  });

  app.get('/api/processing-status', async (_req: Request, res: Response) => {
    try {
      const queue = graph.queueManager;
      const hasLaneMetrics = queue.kind === 'queue-manager' && typeof (queue as { getLaneMetrics?: unknown }).getLaneMetrics === 'function';
      if (!hasLaneMetrics) {
        res.json({ isProcessing: false, queueDepth: 0, runtime: 'server-beta' });
        return;
      }
      const lanes = await (queue as unknown as {
        getLaneMetrics: () => Promise<Array<{ waiting?: number; active?: number }>>;
      }).getLaneMetrics();
      const queueDepth = lanes.reduce((sum, l) => sum + (l.waiting ?? 0), 0);
      const activeCount = lanes.reduce((sum, l) => sum + (l.active ?? 0), 0);
      res.json({
        isProcessing: activeCount > 0,
        queueDepth,
        activeCount,
        runtime: 'server-beta',
      });
    } catch (err) {
      logger.warn('HTTP', '/api/processing-status failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.json({ isProcessing: false, queueDepth: 0, runtime: 'server-beta' });
    }
  });

  // GET /api/settings — serve settings.json with the API key redacted.
  app.get('/api/settings', async (_req: Request, res: Response) => {
    try {
      if (!existsSync(SETTINGS_PATH)) {
        res.json({});
        return;
      }
      const raw = JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8')) as Record<string, unknown>;
      // Redact any value that LOOKS like a credential. The viewer never needs
      // the actual secret — it only renders metadata + non-sensitive options.
      const redacted: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(raw)) {
        if (/_API_KEY$|_KEY$|_TOKEN$|_SECRET$|PASSWORD/i.test(k)) {
          redacted[k] = typeof v === 'string' && v.length > 0 ? '***redacted***' : v;
        } else {
          redacted[k] = v;
        }
      }
      res.json(redacted);
    } catch (err) {
      logger.warn('HTTP', '/api/settings GET failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.json({});
    }
  });

  // POST /api/settings — merge body keys into ~/.claude-mem/settings.json.
  // Whitelist the writable keys so a compromised browser tab can't smuggle
  // an API key or runtime override into the file.
  const WRITABLE_SETTINGS = new Set<string>([
    'CLAUDE_MEM_MODEL',
    'CLAUDE_MEM_CONTEXT_OBSERVATIONS',
    'CLAUDE_MEM_PROVIDER',
    'CLAUDE_MEM_CLAUDE_AUTH_METHOD',
    'CLAUDE_MEM_GEMINI_MODEL',
    'CLAUDE_MEM_OPENROUTER_MODEL',
    'CLAUDE_MEM_OPENROUTER_SITE_URL',
    'CLAUDE_MEM_OPENROUTER_APP_NAME',
    'CLAUDE_MEM_MODE',
    'CLAUDE_MEM_LOG_LEVEL',
    'CLAUDE_MEM_INCLUDE_LAST_SUMMARY',
    'CLAUDE_MEM_INCLUDE_LAST_MESSAGE',
    'CLAUDE_MEM_SKIP_TOOLS',
    'CLAUDE_MEM_EXCLUDED_PROJECTS',
    'CLAUDE_MEM_WORKER_PORT',
    'CLAUDE_MEM_WORKER_HOST',
  ]);

  app.post('/api/settings', async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const dir = join(process.env.HOME ?? '/root', '.claude-mem');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

      const existing: Record<string, unknown> = existsSync(SETTINGS_PATH)
        ? (JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8')) as Record<string, unknown>)
        : {};

      let touched = 0;
      for (const [key, value] of Object.entries(body)) {
        if (!WRITABLE_SETTINGS.has(key)) continue;
        existing[key] = value;
        touched += 1;
      }
      writeFileSync(SETTINGS_PATH, JSON.stringify(existing, null, 2), 'utf-8');
      // useSettings.ts checks `result.success` — anything else surfaces as
      // 'Error: undefined' in the viewer's status bar.
      res.json({ success: true, touched });
    } catch (err) {
      logger.warn('HTTP', '/api/settings POST failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ success: false, error: 'Could not write settings.json' });
    }
  });

  // GET /api/logs — return the last N lines from the current claude-mem log
  // file. Worker mode logs at level INFO+ live under /data/claude-mem/logs/.
  app.get('/api/logs', async (req: Request, res: Response) => {
    try {
      if (!existsSync(LOGS_DIR)) {
        res.json({ logs: [] });
        return;
      }
      const limitRaw = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : NaN;
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 5000) : 500;

      // Pick the newest log file (claude-mem-YYYY-MM-DD.log convention).
      const files = readdirSync(LOGS_DIR)
        .filter((f) => f.endsWith('.log'))
        .map((f) => ({ name: f, mtime: statSync(join(LOGS_DIR, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      if (files.length === 0) {
        res.json({ logs: [] });
        return;
      }
      const latest = files[0]!;
      const latestPath = join(LOGS_DIR, latest.name);
      // Bounded tail: budget ~600 bytes per line so a 5000-line request reads
      // at most ~3 MiB instead of the full file (which can grow to hundreds
      // of MB over time). We seek from the end and fall back to a full read
      // only when the file is smaller than the budget.
      const stat = statSync(latestPath);
      const budget = Math.min(stat.size, limit * 600 + 16 * 1024);
      let raw: string;
      if (budget >= stat.size) {
        raw = readFileSync(latestPath, 'utf-8');
      } else {
        const fd = openSync(latestPath, 'r');
        try {
          const buf = Buffer.alloc(budget);
          readSync(fd, buf, 0, budget, stat.size - budget);
          raw = buf.toString('utf-8');
          // Drop the partial first line so we don't show truncated content.
          const firstNewline = raw.indexOf('\n');
          if (firstNewline >= 0) raw = raw.slice(firstNewline + 1);
        } finally {
          closeSync(fd);
        }
      }
      const lines = raw.split('\n').filter((l) => l.length > 0);
      const tail = lines.slice(-limit);

      // Parse '[ISO] [LEVEL] [COMPONENT] message {context}' format.
      const logs = tail.map((line) => {
        const match = line.match(/^\[(?<ts>[^\]]+)\]\s*\[(?<level>[^\]]+)\]\s*\[(?<component>[^\]]+)\]\s*(?<message>.*)$/);
        if (!match?.groups) {
          return { timestamp: '', level: 'info', component: 'CONSOLE', message: line };
        }
        return {
          timestamp: match.groups.ts.trim(),
          level: match.groups.level.trim().toLowerCase(),
          component: match.groups.component.trim(),
          message: match.groups.message.trim(),
        };
      });
      res.json({ logs });
    } catch (err) {
      logger.warn('HTTP', '/api/logs failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ logs: [], error: 'InternalError' });
    }
  });

  // POST /api/logs/clear — truncate the current log file in place.
  app.post('/api/logs/clear', async (_req: Request, res: Response) => {
    try {
      if (!existsSync(LOGS_DIR)) {
        res.json({ cleared: true });
        return;
      }
      const files = readdirSync(LOGS_DIR).filter((f) => f.endsWith('.log'));
      let cleared = 0;
      for (const f of files) {
        try {
          truncateSync(join(LOGS_DIR, f), 0);
          cleared += 1;
        } catch {
          /* skip files we can't truncate */
        }
      }
      res.json({ cleared: true, filesCleared: cleared });
    } catch (err) {
      logger.warn('HTTP', '/api/logs/clear failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ cleared: false, error: 'InternalError' });
    }
  });

  // GET /api/projects — list project ids the viewer can populate its dropdown
  // with. The viewer reads projects from the SSE initial_load too, but a
  // direct endpoint is useful for refresh-without-reconnect.
  app.get('/api/projects', async (_req: Request, res: Response) => {
    try {
      const result = await pool.query<{ id: string; name: string }>(
        `SELECT id, name FROM projects ORDER BY name ASC`,
      );
      res.json({
        projects: result.rows.map((r) => r.id),
        projectsByName: Object.fromEntries(result.rows.map((r) => [r.name, r.id])),
      });
    } catch (err) {
      logger.warn('HTTP', '/api/projects failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ projects: [], projectsByName: {} });
    }
  });
}

// ─── 3. SSE stream — protocol matches useSSE.ts ─────────────────────────────

export function setupViewerSseStream(app: Application, graph: ServerBetaServiceGraph): void {
  const pool = graph.postgres.pool;

  app.get('/stream', requireLoopback, async (req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    // Send the initial_load event the viewer expects. Without this projects
    // never populate and the 'All Projects' dropdown stays empty.
    try {
      const projectsRes = await pool.query<{ id: string }>(`SELECT id FROM projects ORDER BY name ASC`);
      res.write(
        `data: ${JSON.stringify({
          type: 'initial_load',
          projects: projectsRes.rows.map((r) => r.id),
        })}\n\n`,
      );
    } catch (err) {
      logger.debug('HTTP', '/stream initial_load failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.write(`data: ${JSON.stringify({ type: 'initial_load', projects: [] })}\n\n`);
    }

    // Composite cursor (created_at, id) so we don't drop rows that share a
    // created_at boundary when a batch insert produces >LIMIT rows at the
    // same NOW() timestamp. We start lastSeenId empty and use it as a
    // tiebreaker in the WHERE clause once a real id has been observed.
    let lastSeenEpoch = Date.now();
    let lastSeenId: string | null = null;
    let closed = false;

    const interval = setInterval(async () => {
      if (closed) return;
      try {
        const result = await pool.query<{
          id: string;
          project_id: string;
          team_id: string;
          kind: string;
          content: string;
          metadata: Record<string, unknown>;
          created_at: Date;
          updated_at: Date;
        }>(
          lastSeenId === null
            ? `SELECT id, project_id, team_id, kind, content, metadata, created_at, updated_at
                 FROM observations
                 WHERE created_at > to_timestamp($1 / 1000.0)
                 ORDER BY created_at ASC, id ASC
                 LIMIT 25`
            : `SELECT id, project_id, team_id, kind, content, metadata, created_at, updated_at
                 FROM observations
                 WHERE (created_at > to_timestamp($1 / 1000.0))
                    OR (created_at = to_timestamp($1 / 1000.0) AND id > $2)
                 ORDER BY created_at ASC, id ASC
                 LIMIT 25`,
          lastSeenId === null ? [lastSeenEpoch] : [lastSeenEpoch, lastSeenId],
        );
        for (const row of result.rows) {
          const epoch = row.created_at.getTime();
          if (epoch >= lastSeenEpoch) {
            lastSeenEpoch = epoch;
            lastSeenId = row.id;
          }
          const observation = viewerObservationFromRow(row);
          res.write(
            `data: ${JSON.stringify({ type: 'new_observation', observation })}\n\n`,
          );
        }

        // Processing status heartbeat — keeps the spinner in the header live.
        try {
          const queue = graph.queueManager;
          const hasLaneMetrics =
            queue.kind === 'queue-manager' &&
            typeof (queue as { getLaneMetrics?: unknown }).getLaneMetrics === 'function';
          if (hasLaneMetrics) {
            const lanes = await (queue as unknown as {
              getLaneMetrics: () => Promise<Array<{ waiting?: number; active?: number }>>;
            }).getLaneMetrics();
            const queueDepth = lanes.reduce((sum, l) => sum + (l.waiting ?? 0), 0);
            const activeCount = lanes.reduce((sum, l) => sum + (l.active ?? 0), 0);
            res.write(
              `data: ${JSON.stringify({
                type: 'processing_status',
                isProcessing: activeCount > 0,
                queueDepth,
              })}\n\n`,
            );
          }
        } catch {
          /* non-fatal */
        }

        // Heartbeat keeps proxies from killing quiet connections.
        res.write(`: heartbeat ${Date.now()}\n\n`);
      } catch (err) {
        logger.debug('HTTP', '/stream poll failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }, 2000);

    req.on('close', () => {
      closed = true;
      clearInterval(interval);
    });
  });
}

export { locatePluginUiDir };
