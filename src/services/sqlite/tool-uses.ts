// Durable raw tool-use rows (schema v51).
//
// `pending_messages` is the GENERATION QUEUE: rows are claimed, fed to the
// observer, then deleted. Nothing durable survives it, so raw tool I/O was
// unrecoverable once an observation had been written. `tool_uses` is the
// backup/side index for that same payload — written from the SAME ingest
// choke point (`ingestObservation`), never a second capture path, so the
// transcript-watch JSONL spine stays authoritative for transcripts and this
// table stays a progressive-disclosure side index for tool bodies.
//
// Receipt freeze 2026-09-06: this table carries tool IDENTITY only. Dollars
// live on OpenRouter call-time stamps / the Receipt spend log. `or_generation_id`
// and `or_session_id` are nullable JOIN keys back to those lines — never a
// `cost_usd` / micros column here. See reports/tool-sqlite-offload/RECEIPT-JOIN.md.
import { Database } from 'bun:sqlite';
import { createHash } from 'crypto';
import { logger } from '../../utils/logger.js';
import { DEFAULT_PLATFORM_SOURCE, normalizePlatformSource } from '../../shared/platform-source.js';

/**
 * Soft cap per stored payload field. The Pro hook envelope already truncates
 * `tool_input` / `tool_response` to 16 KB each on the wire
 * (`cowork/PRO-ENDPOINT-SPEC.md`), but the local worker path does not, and a
 * single Read of a large file would otherwise pin megabytes into a table that
 * — unlike `pending_messages` — is never drained. 64 KB keeps the in-row shape
 * the plan asked for (no blob sidecar) while bounding growth.
 *
 * Truncated values get a `…[truncated: N bytes]` marker so a reader can tell a
 * clipped payload from one that legitimately ends there. A truncated value is
 * NOT valid JSON any more; `get_tool_uses` consumers must tolerate that.
 */
export const MAX_TOOL_PAYLOAD_BYTES = 64 * 1024;

/**
 * claude-mem's own read tools, which must never be backed up into this table.
 *
 * `get_tool_uses` RETURNS raw tool bodies. Recording its own PostToolUse would
 * store those bodies a second time, and disclosing them again would store them
 * a third — the table grows with every read instead of every tool call. The
 * other layers are gated for the same reason at a smaller scale.
 *
 * This gates only the `tool_uses` backup write. The observation generator still
 * sees these calls exactly as it does today; nothing about that path changes.
 * OpenClaw already drops `memory_*` before it ever reaches the worker
 * (`openclaw/src/index.ts:802`); the prefix is mirrored here so every other
 * adapter gets the same protection.
 */
const RECURSIVE_MEMORY_TOOLS: ReadonlySet<string> = new Set([
  'search',
  'timeline',
  'get_observations',
  'get_tool_uses',
  'session_start_context',
  'observation_search',
]);

export function isRecursiveMemoryTool(toolName: string): boolean {
  if (!toolName) return false;
  if (toolName.startsWith('memory_')) return true;
  if (!toolName.startsWith('mcp__')) return false;

  // mcp__<server>__<tool>. Match the SERVER segment too: a different MCP
  // server's generic `search` is a real tool call and belongs in the index.
  const parts = toolName.split('__');
  if (parts.length < 3) return false;
  const server = parts[1].toLowerCase();
  const tool = parts.slice(2).join('__');
  const isClaudeMemServer = server.includes('claude-mem')
    || server.includes('claude_mem')
    || server.includes('mcp-search')
    || server.includes('cmem');

  return isClaudeMemServer && RECURSIVE_MEMORY_TOOLS.has(tool);
}

export interface ToolUseRow {
  id: number;
  tool_use_id: string;
  content_session_id: string;
  memory_session_id: string | null;
  session_db_id: number | null;
  project: string;
  platform_source: string;
  tool_name: string;
  tool_input: string | null;
  tool_response: string | null;
  cwd: string | null;
  prompt_number: number | null;
  agent_type: string | null;
  agent_id: string | null;
  observation_id: number | null;
  or_generation_id: string | null;
  or_session_id: string | null;
  content_hash: string | null;
  created_at: string;
  created_at_epoch: number;
}

export interface UpsertToolUseInput {
  toolUseId: string;
  contentSessionId: string;
  sessionDbId?: number | null;
  memorySessionId?: string | null;
  project: string;
  platformSource?: string;
  toolName: string;
  toolInput?: string | null;
  toolResponse?: string | null;
  cwd?: string | null;
  promptNumber?: number | null;
  agentType?: string | null;
  agentId?: string | null;
  orGenerationId?: string | null;
  orSessionId?: string | null;
  createdAtEpoch?: number;
}

export interface ToolUseQueryFilters {
  project?: string;
  contentSessionId?: string;
  memorySessionId?: string;
  sessionDbId?: number;
  toolName?: string | string[];
  agentId?: string;
  platformSource?: string;
  dateStart?: number;
  dateEnd?: number;
  limit?: number;
  offset?: number;
  orderBy?: 'date_desc' | 'date_asc';
}

/**
 * UTF-8-safe byte truncation. Copied from the oversized-prompt guard in
 * `SessionRoutes.handleSessionInitByClaudeId` so both boundaries clip the same
 * way (never mid-codepoint).
 */
export function truncatePayload(value: string, maxBytes: number = MAX_TOOL_PAYLOAD_BYTES): string {
  const byteLength = Buffer.byteLength(value, 'utf8');
  if (byteLength <= maxBytes) return value;

  const buf = Buffer.from(value, 'utf8');
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return `${buf.subarray(0, end).toString('utf8')}…[truncated: ${byteLength} bytes]`;
}

/**
 * Stable identity of the ORIGINAL (pre-truncation) payload, so a hash still
 * distinguishes two different oversized tool bodies that clip to the same
 * prefix. Same 16-hex shape as `computeObservationContentHash`.
 */
export function computeToolUseContentHash(
  toolName: string,
  toolInput: string | null | undefined,
  toolResponse: string | null | undefined
): string {
  return createHash('sha256')
    .update([toolName || '', toolInput || '', toolResponse || ''].join('\x00'))
    .digest('hex')
    .slice(0, 16);
}

/**
 * v51 DDL. `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS` only —
 * no FK on `session_db_id` / `observation_id` on purpose: a FK here would let a
 * single orphan row abort the whole constructor migration chain (#3378), and
 * `observation_id` is deliberately linked LATE (after generation), so it cannot
 * be required at insert time.
 */
export function createToolUsesSchema(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS tool_uses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tool_use_id TEXT NOT NULL,
      content_session_id TEXT NOT NULL,
      memory_session_id TEXT,
      session_db_id INTEGER,
      project TEXT NOT NULL,
      platform_source TEXT NOT NULL DEFAULT '${DEFAULT_PLATFORM_SOURCE}',
      tool_name TEXT NOT NULL,
      tool_input TEXT,
      tool_response TEXT,
      cwd TEXT,
      prompt_number INTEGER,
      agent_type TEXT,
      agent_id TEXT,
      observation_id INTEGER,
      or_generation_id TEXT,
      or_session_id TEXT,
      content_hash TEXT,
      created_at TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL,
      UNIQUE(content_session_id, tool_use_id)
    )
  `);

  db.run('CREATE INDEX IF NOT EXISTS idx_tool_uses_project ON tool_uses(project)');
  db.run('CREATE INDEX IF NOT EXISTS idx_tool_uses_memory_session ON tool_uses(memory_session_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_tool_uses_content_session ON tool_uses(content_session_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_tool_uses_session_db_id ON tool_uses(session_db_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_tool_uses_tool_name ON tool_uses(tool_name)');
  db.run('CREATE INDEX IF NOT EXISTS idx_tool_uses_created_at_epoch ON tool_uses(created_at_epoch)');
  db.run('CREATE INDEX IF NOT EXISTS idx_tool_uses_observation_id ON tool_uses(observation_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_tool_uses_or_generation_id ON tool_uses(or_generation_id)');
}

/**
 * Idempotent write. A replayed PostToolUse (hook retry, transcript re-scan)
 * carries the same `(content_session_id, tool_use_id)` and must not duplicate;
 * it refreshes the payload instead, because the replay may be the first one to
 * carry a `tool_response`. Fields the replay does not carry are preserved via
 * COALESCE — notably `observation_id`, which is linked later.
 *
 * Returns the row id, or null when the caller gave no `tool_use_id` (a tool
 * event with no stable identity cannot be de-duplicated, so it is skipped
 * rather than inserted as an unbounded duplicate).
 */
export function upsertToolUse(db: Database, input: UpsertToolUseInput): number | null {
  if (!input.toolUseId || !input.contentSessionId || !input.toolName) return null;
  if (isRecursiveMemoryTool(input.toolName)) return null;

  const createdAtEpoch = input.createdAtEpoch ?? Date.now();
  const createdAt = new Date(createdAtEpoch).toISOString();
  const contentHash = computeToolUseContentHash(input.toolName, input.toolInput, input.toolResponse);

  const toolInput = input.toolInput != null ? truncatePayload(input.toolInput) : null;
  const toolResponse = input.toolResponse != null ? truncatePayload(input.toolResponse) : null;

  const row = db.prepare(`
    INSERT INTO tool_uses (
      tool_use_id, content_session_id, memory_session_id, session_db_id, project,
      platform_source, tool_name, tool_input, tool_response, cwd, prompt_number,
      agent_type, agent_id, or_generation_id, or_session_id, content_hash,
      created_at, created_at_epoch
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(content_session_id, tool_use_id) DO UPDATE SET
      memory_session_id = COALESCE(excluded.memory_session_id, tool_uses.memory_session_id),
      session_db_id     = COALESCE(excluded.session_db_id, tool_uses.session_db_id),
      project           = CASE WHEN excluded.project != '' THEN excluded.project ELSE tool_uses.project END,
      platform_source   = excluded.platform_source,
      tool_input        = COALESCE(excluded.tool_input, tool_uses.tool_input),
      tool_response     = COALESCE(excluded.tool_response, tool_uses.tool_response),
      cwd               = COALESCE(excluded.cwd, tool_uses.cwd),
      prompt_number     = COALESCE(excluded.prompt_number, tool_uses.prompt_number),
      agent_type        = COALESCE(excluded.agent_type, tool_uses.agent_type),
      agent_id          = COALESCE(excluded.agent_id, tool_uses.agent_id),
      or_generation_id  = COALESCE(excluded.or_generation_id, tool_uses.or_generation_id),
      or_session_id     = COALESCE(excluded.or_session_id, tool_uses.or_session_id),
      content_hash      = excluded.content_hash
    RETURNING id
  `).get(
    input.toolUseId,
    input.contentSessionId,
    input.memorySessionId ?? null,
    input.sessionDbId ?? null,
    input.project ?? '',
    normalizePlatformSource(input.platformSource),
    input.toolName,
    toolInput,
    toolResponse,
    input.cwd ?? null,
    input.promptNumber ?? null,
    input.agentType ?? null,
    input.agentId ?? null,
    input.orGenerationId ?? null,
    input.orSessionId ?? null,
    contentHash,
    createdAt,
    createdAtEpoch
  ) as { id: number } | null;

  return row ? row.id : null;
}

/**
 * Late link, called once the observer has actually stored observations for the
 * batch these tool uses were claimed into. `observation_id` is only ever set
 * when it is still NULL: the first observation that consumed a tool use owns
 * the link, and a later batch that happens to re-claim the same id must not
 * steal it. `memory_session_id` is backfilled at the same time because it does
 * not exist yet at ingest.
 *
 * Returns the number of rows updated.
 */
export function linkToolUsesToObservation(
  db: Database,
  params: {
    contentSessionId: string;
    toolUseIds: string[];
    observationId: number;
    memorySessionId?: string | null;
  }
): number {
  const ids = params.toolUseIds.filter(id => typeof id === 'string' && id.length > 0);
  if (ids.length === 0) return 0;

  const placeholders = ids.map(() => '?').join(',');
  const result = db.prepare(`
    UPDATE tool_uses
    SET observation_id = COALESCE(observation_id, ?),
        memory_session_id = COALESCE(?, memory_session_id)
    WHERE content_session_id = ?
      AND tool_use_id IN (${placeholders})
  `).run(
    params.observationId,
    params.memorySessionId ?? null,
    params.contentSessionId,
    ...ids
  );

  return Number(result.changes ?? 0);
}

function mapPlatformFilter(platformSource: string | undefined): { clause: string; param: string } | null {
  if (!platformSource) return null;
  return {
    clause: `COALESCE(NULLIF(platform_source, ''), '${DEFAULT_PLATFORM_SOURCE}') = ?`,
    param: normalizePlatformSource(platformSource),
  };
}

/**
 * Layer-4 fetch: full tool bodies for an explicitly filtered set of ids.
 *
 * Accepts BOTH numeric `tool_uses.id` (what `queryToolUses` / the search index
 * hand back) and string `tool_use_id` (what a transcript or an observation ref
 * carries), because callers legitimately hold either one.
 */
export function getToolUsesByIds(
  db: Database,
  ids: Array<number | string>,
  options: { limit?: number; project?: string; platformSource?: string; contentSessionId?: string } = {}
): ToolUseRow[] {
  const numericIds: number[] = [];
  const stringIds: string[] = [];
  for (const id of ids) {
    if (typeof id === 'number' && Number.isInteger(id)) {
      numericIds.push(id);
      continue;
    }
    if (typeof id === 'string' && id.trim().length > 0) {
      // A numeric-looking string is ambiguous; match it on BOTH columns rather
      // than guessing, since tool_use_id values are opaque provider strings.
      const asNumber = Number(id);
      if (Number.isInteger(asNumber) && String(asNumber) === id.trim()) numericIds.push(asNumber);
      stringIds.push(id.trim());
    }
  }

  if (numericIds.length === 0 && stringIds.length === 0) return [];

  const idClauses: string[] = [];
  const params: Array<string | number> = [];
  if (numericIds.length > 0) {
    idClauses.push(`id IN (${numericIds.map(() => '?').join(',')})`);
    params.push(...numericIds);
  }
  if (stringIds.length > 0) {
    idClauses.push(`tool_use_id IN (${stringIds.map(() => '?').join(',')})`);
    params.push(...stringIds);
  }

  const conditions = [`(${idClauses.join(' OR ')})`];

  if (options.project) {
    conditions.push('project = ?');
    params.push(options.project);
  }
  if (options.contentSessionId) {
    conditions.push('content_session_id = ?');
    params.push(options.contentSessionId);
  }
  const platform = mapPlatformFilter(options.platformSource);
  if (platform) {
    conditions.push(platform.clause);
    params.push(platform.param);
  }

  const limitClause = options.limit && options.limit > 0 ? `LIMIT ${Math.floor(options.limit)}` : '';

  return db.prepare(`
    SELECT * FROM tool_uses
    WHERE ${conditions.join(' AND ')}
    ORDER BY created_at_epoch DESC
    ${limitClause}
  `).all(...params) as ToolUseRow[];
}

/**
 * Index-shaped listing for Receipt tallies and for finding ids to hand to
 * `getToolUsesByIds`. Deliberately still returns full rows — callers that want
 * the cheap shape project it themselves — but it is always bounded by a limit.
 */
export function queryToolUses(db: Database, filters: ToolUseQueryFilters = {}): ToolUseRow[] {
  const conditions: string[] = [];
  const params: Array<string | number> = [];

  if (filters.project) {
    conditions.push('project = ?');
    params.push(filters.project);
  }
  if (filters.contentSessionId) {
    conditions.push('content_session_id = ?');
    params.push(filters.contentSessionId);
  }
  if (filters.memorySessionId) {
    conditions.push('memory_session_id = ?');
    params.push(filters.memorySessionId);
  }
  if (typeof filters.sessionDbId === 'number') {
    conditions.push('session_db_id = ?');
    params.push(filters.sessionDbId);
  }
  if (filters.toolName) {
    const names = Array.isArray(filters.toolName) ? filters.toolName : [filters.toolName];
    if (names.length > 0) {
      conditions.push(`tool_name IN (${names.map(() => '?').join(',')})`);
      params.push(...names);
    }
  }
  if (filters.agentId) {
    conditions.push('agent_id = ?');
    params.push(filters.agentId);
  }
  const platform = mapPlatformFilter(filters.platformSource);
  if (platform) {
    conditions.push(platform.clause);
    params.push(platform.param);
  }
  if (typeof filters.dateStart === 'number') {
    conditions.push('created_at_epoch >= ?');
    params.push(filters.dateStart);
  }
  if (typeof filters.dateEnd === 'number') {
    conditions.push('created_at_epoch <= ?');
    params.push(filters.dateEnd);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const order = filters.orderBy === 'date_asc' ? 'ASC' : 'DESC';
  const limit = Math.min(Math.max(Math.floor(filters.limit ?? 50), 1), 500);
  const offset = Math.max(Math.floor(filters.offset ?? 0), 0);

  return db.prepare(`
    SELECT * FROM tool_uses
    ${whereClause}
    ORDER BY created_at_epoch ${order}, id ${order}
    LIMIT ${limit} OFFSET ${offset}
  `).all(...params) as ToolUseRow[];
}

/**
 * Receipt's headline number: usage COUNT by tool, never a dollar figure.
 * `COUNT(DISTINCT tool_use_id)` per the frozen join contract, so a row that got
 * upserted twice still counts once.
 */
export function countToolUses(
  db: Database,
  filters: ToolUseQueryFilters = {}
): Array<{ tool_name: string; uses: number }> {
  const conditions: string[] = [];
  const params: Array<string | number> = [];

  if (filters.project) {
    conditions.push('project = ?');
    params.push(filters.project);
  }
  if (filters.contentSessionId) {
    conditions.push('content_session_id = ?');
    params.push(filters.contentSessionId);
  }
  if (filters.agentId) {
    conditions.push('agent_id = ?');
    params.push(filters.agentId);
  }
  if (typeof filters.dateStart === 'number') {
    conditions.push('created_at_epoch >= ?');
    params.push(filters.dateStart);
  }
  if (typeof filters.dateEnd === 'number') {
    conditions.push('created_at_epoch <= ?');
    params.push(filters.dateEnd);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  return db.prepare(`
    SELECT tool_name, COUNT(DISTINCT tool_use_id) AS uses
    FROM tool_uses
    ${whereClause}
    GROUP BY tool_name
    ORDER BY uses DESC, tool_name ASC
  `).all(...params) as Array<{ tool_name: string; uses: number }>;
}

/** Diagnostic helper used by the worker health/stat surfaces. */
export function toolUsesTableExists(db: Database): boolean {
  const row = db
    .query("SELECT name FROM sqlite_master WHERE type='table' AND name='tool_uses'")
    .get() as { name: string } | null;
  if (!row) {
    logger.debug('DB', 'tool_uses table not present');
    return false;
  }
  return true;
}
