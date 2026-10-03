// Toolkit catalog rows (schema v62).
//
// One row per Toolkit tool: an ordered series of tool calls that agents
// repeated successfully more than 5 times, which the daily Toolkit run turns
// into one reusable, parameterized script. The row is the catalog entry (name,
// parameters, status, and every series signature it covers); the script itself
// lives on disk under `paths.toolkit()`. Near-duplicate series are merged into
// one row: `primary_signature` names the series the tool was built from and
// `member_signatures` lists every series it stands for, the primary included.
//
// v61 is reserved by the unmerged `feat/work-state` branch; this table is v62.
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { logger } from '../../utils/logger.js';
import { SessionSearch } from './SessionSearch.js';

export type ToolkitToolRuntime = 'bash' | 'python' | 'node';
export type ToolkitToolScope = 'global' | 'project';
export type ToolkitToolStatus = 'live' | 'blocked' | 'failed';
export type ToolkitToolRiskLevel = 'low' | 'high';

/** One `--<name>` flag of a generated script; stored as JSON in `parameters`. */
export interface ToolkitToolParameter {
  name: string;
  description: string;
  required: boolean;
  example: string;
}

/**
 * A `toolkit_tools` row exactly as stored. The JSON columns (`parameters`,
 * `member_signatures`, `projects`) stay JSON text, as `ToolUseRow`'s payloads do;
 * callers parse what they need.
 */
export interface ToolkitToolRow {
  id: number;
  name: string | null;
  description: string | null;
  runtime: ToolkitToolRuntime | null;
  parameters: string;
  primary_signature: string;
  member_signatures: string;
  occurrence_count: number;
  session_count: number;
  projects: string;
  scope: ToolkitToolScope;
  project: string | null;
  status: ToolkitToolStatus;
  risk_level: ToolkitToolRiskLevel;
  failure_reason: string | null;
  generation_attempts: number;
  created_at: string;
  created_at_epoch: number;
  updated_at: string;
  updated_at_epoch: number;
}

export interface InsertToolkitToolInput {
  /** Null until a generation attempt has produced a name. */
  name?: string | null;
  description?: string | null;
  runtime?: ToolkitToolRuntime | null;
  parameters?: ToolkitToolParameter[];
  primarySignature: string;
  /** Every series signature this tool covers, the primary included. */
  memberSignatures: string[];
  occurrenceCount: number;
  sessionCount: number;
  projects: string[];
  scope: ToolkitToolScope;
  /** Set when `scope` is 'project'. */
  project?: string | null;
  status: ToolkitToolStatus;
  riskLevel: ToolkitToolRiskLevel;
  failureReason?: string | null;
  generationAttempts?: number;
  createdAtEpoch?: number;
}

/** Fields `updateToolkitTool` sets; an omitted field keeps its stored value, `null` clears it. */
export type UpdateToolkitToolInput = Partial<Omit<InsertToolkitToolInput, 'createdAtEpoch'>>;

export interface ListToolkitToolsFilters {
  status?: ToolkitToolStatus;
  /** Tools usable in this project: the global ones plus the ones scoped to it. */
  project?: string;
}

export interface SearchToolkitToolsOptions {
  query: string;
  /** Without a project only global tools match: a project-scoped tool is offered only in its project. */
  project?: string;
  limit: number;
}

/**
 * v62 DDL. `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS` only, and
 * no foreign keys, by the same house rule as `createToolUsesSchema` (tool-uses.ts):
 * one bad row must never be able to abort the constructor's migration chain (#3378).
 */
export function createToolkitToolsSchema(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS toolkit_tools (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE,                       -- null while status='failed'/'blocked' and never named
      description TEXT,
      runtime TEXT CHECK(runtime IS NULL OR runtime IN ('bash','python','node')),
      parameters TEXT NOT NULL DEFAULT '[]',  -- JSON [{name, description, required, example}]
      primary_signature TEXT NOT NULL UNIQUE,
      member_signatures TEXT NOT NULL DEFAULT '[]',  -- JSON string[] (includes primary)
      occurrence_count INTEGER NOT NULL,
      session_count INTEGER NOT NULL,
      projects TEXT NOT NULL DEFAULT '[]',   -- JSON string[]
      scope TEXT NOT NULL CHECK(scope IN ('global','project')),
      project TEXT,                           -- set when scope='project'
      status TEXT NOT NULL CHECK(status IN ('live','blocked','failed')),
      risk_level TEXT NOT NULL CHECK(risk_level IN ('low','high')),
      failure_reason TEXT,
      generation_attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      updated_at_epoch INTEGER NOT NULL
    )
  `);

  db.run('CREATE INDEX IF NOT EXISTS idx_toolkit_tools_status ON toolkit_tools(status)');
  db.run('CREATE INDEX IF NOT EXISTS idx_toolkit_tools_scope_project ON toolkit_tools(scope, project)');
}

/**
 * Insert a new tool and return its row id. `primary_signature` and `name` are
 * UNIQUE, so inserting a series that already has a row throws: look it up with
 * `findToolkitToolBySignature` first and update that row instead.
 */
export function insertToolkitTool(db: Database, input: InsertToolkitToolInput): number {
  const createdAtEpoch = input.createdAtEpoch ?? Date.now();
  const createdAt = new Date(createdAtEpoch).toISOString();

  // run() + lastInsertRowid, as SessionStore.recordAdvisorCall does for its plain insert.
  const result = db.prepare(`
    INSERT INTO toolkit_tools (
      name, description, runtime, parameters, primary_signature, member_signatures,
      occurrence_count, session_count, projects, scope, project, status, risk_level,
      failure_reason, generation_attempts, created_at, created_at_epoch, updated_at, updated_at_epoch
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.name ?? null,
    input.description ?? null,
    input.runtime ?? null,
    JSON.stringify(input.parameters ?? []),
    input.primarySignature,
    JSON.stringify(input.memberSignatures),
    input.occurrenceCount,
    input.sessionCount,
    JSON.stringify(input.projects),
    input.scope,
    input.project ?? null,
    input.status,
    input.riskLevel,
    input.failureReason ?? null,
    input.generationAttempts ?? 0,
    createdAt,
    createdAtEpoch,
    createdAt,
    createdAtEpoch
  );

  const id = Number(result.lastInsertRowid);
  // The catalog changes with no human in the loop; a debug trail of each write
  // shows how a tool reached its status.
  logger.debug('TOOLKIT', 'Stored toolkit tool', { id, name: input.name ?? null, status: input.status });
  return id;
}

/**
 * Set the given fields on the row with this id and stamp `updated_at`. Returns
 * the row as stored afterwards; throws when no row has the id, because an update
 * that silently touches nothing would hide a lost tool.
 */
export function updateToolkitTool(db: Database, id: number, patch: UpdateToolkitToolInput): ToolkitToolRow {
  const assignments: string[] = [];
  const params: SQLQueryBindings[] = [];
  const assign = (column: string, value: SQLQueryBindings): void => {
    assignments.push(`${column} = ?`);
    params.push(value);
  };

  if (patch.name !== undefined) assign('name', patch.name);
  if (patch.description !== undefined) assign('description', patch.description);
  if (patch.runtime !== undefined) assign('runtime', patch.runtime);
  if (patch.parameters !== undefined) assign('parameters', JSON.stringify(patch.parameters));
  if (patch.primarySignature !== undefined) assign('primary_signature', patch.primarySignature);
  if (patch.memberSignatures !== undefined) assign('member_signatures', JSON.stringify(patch.memberSignatures));
  if (patch.occurrenceCount !== undefined) assign('occurrence_count', patch.occurrenceCount);
  if (patch.sessionCount !== undefined) assign('session_count', patch.sessionCount);
  if (patch.projects !== undefined) assign('projects', JSON.stringify(patch.projects));
  if (patch.scope !== undefined) assign('scope', patch.scope);
  if (patch.project !== undefined) assign('project', patch.project);
  if (patch.status !== undefined) assign('status', patch.status);
  if (patch.riskLevel !== undefined) assign('risk_level', patch.riskLevel);
  if (patch.failureReason !== undefined) assign('failure_reason', patch.failureReason);
  if (patch.generationAttempts !== undefined) assign('generation_attempts', patch.generationAttempts);

  const updatedAtEpoch = Date.now();
  assign('updated_at', new Date(updatedAtEpoch).toISOString());
  assign('updated_at_epoch', updatedAtEpoch);

  const row = db.prepare(`
    UPDATE toolkit_tools
    SET ${assignments.join(', ')}
    WHERE id = ?
    RETURNING *
  `).get(...params, id) as ToolkitToolRow | null;

  if (!row) {
    throw new Error(`toolkit_tools has no row with id ${id}`);
  }
  logger.debug('TOOLKIT', 'Updated toolkit tool', { id, name: row.name, status: row.status });
  return row;
}

/**
 * The tool that covers `signature`: as its primary series, or as any member
 * series merged into it (matched through `json_each(member_signatures)`). When
 * more than one row lists it, the row whose primary it is wins, then the oldest.
 */
export function findToolkitToolBySignature(db: Database, signature: string): ToolkitToolRow | null {
  return db.prepare(`
    SELECT * FROM toolkit_tools
    WHERE primary_signature = ?
       OR EXISTS (SELECT 1 FROM json_each(toolkit_tools.member_signatures) WHERE json_each.value = ?)
    ORDER BY primary_signature = ? DESC, id ASC
    LIMIT 1
  `).get(signature, signature, signature) as ToolkitToolRow | null;
}

export function getToolkitToolByName(db: Database, name: string): ToolkitToolRow | null {
  return db.prepare('SELECT * FROM toolkit_tools WHERE name = ?').get(name) as ToolkitToolRow | null;
}

/** Every tool matching the filters, most-used first. No filters lists the whole catalog. */
export function listToolkitTools(db: Database, filters: ListToolkitToolsFilters = {}): ToolkitToolRow[] {
  const conditions: string[] = [];
  const params: SQLQueryBindings[] = [];

  if (filters.status) {
    conditions.push('status = ?');
    params.push(filters.status);
  }
  if (filters.project) {
    conditions.push("(scope = 'global' OR project = ?)");
    params.push(filters.project);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  return db.prepare(`
    SELECT * FROM toolkit_tools
    ${whereClause}
    ORDER BY occurrence_count DESC, id ASC
  `).all(...params) as ToolkitToolRow[];
}

/**
 * Live tools usable in `project` (global ones, plus the ones scoped to it) whose
 * name or description contains every word of `query`, most-used first. LIKE is
 * case-insensitive for ASCII; `%`, `_` and `\` in a word match literally. A blank
 * query matches every live tool in scope. Only the first
 * `SessionSearch.MAX_SUBSTRING_TERMS` distinct words are used.
 */
export function searchToolkitTools(db: Database, options: SearchToolkitToolsOptions): ToolkitToolRow[] {
  if (!Number.isInteger(options.limit) || options.limit < 1) {
    throw new Error(`searchToolkitTools: limit must be a positive integer, got ${options.limit}`);
  }

  const conditions: string[] = ["status = 'live'"];
  const params: SQLQueryBindings[] = [];

  if (options.project) {
    conditions.push("(scope = 'global' OR project = ?)");
    params.push(options.project);
  } else {
    conditions.push("scope = 'global'");
  }

  // Per-word AND of (name OR description) with escaped wildcards, copied from
  // SessionSearch.buildSubstringClause (src/services/sqlite/SessionSearch.ts),
  // term cap included: past ~980 ANDed words SQLite throws "Expression tree is
  // too large", and a query with more distinct words than the cap could not
  // match a tool by its full AND anyway, so its leading words are kept.
  const words = [...new Set(options.query.match(/\S+/g) ?? [])].slice(0, SessionSearch.MAX_SUBSTRING_TERMS);
  for (const word of words) {
    const pattern = `%${word.replace(/[\\%_]/g, '\\$&')}%`;
    conditions.push("(name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')");
    params.push(pattern, pattern);
  }

  params.push(options.limit);

  return db.prepare(`
    SELECT * FROM toolkit_tools
    WHERE ${conditions.join(' AND ')}
    ORDER BY occurrence_count DESC, id ASC
    LIMIT ?
  `).all(...params) as ToolkitToolRow[];
}
