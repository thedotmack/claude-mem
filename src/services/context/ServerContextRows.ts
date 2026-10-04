// THE SHARED STORE AS A ROW SOURCE.
//
// In `server` runtime every WRITE goes to the shared store, while session start
// READ the per-machine SQLite file. Both halves already shipped and were never
// joined: the client has carried contextObservations() -> POST /v1/context all
// along and nothing called it. MEASURED 2026-09-17: the local corpus took 1
// observation in 24h against the store's 18,184.
//
// The FIRST attempt at this fix injected the route's pre-joined `context` string
// straight into the hook's output, and that was wrong in a way worth recording: it
// bypassed fitContextToBudget, so the block came back at 52,337 characters against
// the CONTEXT_OUTPUT_LIMIT of 10,000 that #3802 exists to enforce -- and it lost
// the header, the legend, the ids and the savings stats, 13,084 tokens where the
// local block spent 1,787. Replacing the ROW SOURCE instead leaves the renderer,
// the budget fitter, the token counter and the stats exactly as they were: the
// only thing that changes is WHERE the rows came from.

import { logger } from '../../utils/logger.js';
import { SERVER_CONTEXT_MAX_LIMIT } from '../../shared/server-context-limits.js';
import type { ServerRuntimeContext } from '../hooks/runtime-selector.js';
import { SUMMARY_LOOKAHEAD, type ContextConfig, type Observation, type SessionSummary } from './types.js';

export interface ServerContextRows {
  observations: Observation[];
  summaries: SessionSummary[];
}

type ServerRow = Record<string, unknown>;

/**
 * Fetch the newest rows for session start from the server and split them into
 * the local observation and summary shapes.
 *
 * Returns null only when the server could not answer (transport or HTTP error).
 * A successful empty answer is authoritative: it returns empty lists, so the
 * caller renders the empty state instead of reaching for stale local rows.
 *
 * Server summaries are stored as observations with kind='summary', so one
 * recency read returns both. It asks for enough rows to fill the observation
 * count plus the summary count, capped at the route's SERVER_CONTEXT_MAX_LIMIT.
 * That cap also bounds `full` mode, which asks for everything.
 *
 * `config.mainAgentOnly` (CLAUDE_MEM_CONTEXT_MAIN_AGENT_ONLY) asks the server to
 * leave out rows generated from subagent events, as the SQLite read does.
 * `timeoutMs` bounds the request; a hook passes what its host's limit leaves.
 */
export async function fetchServerContextRows(
  runtime: ServerRuntimeContext,
  request: {
    config: ContextConfig;
    project: string;
    folderProjects: string[];
    platformSource: string | undefined;
    timeoutMs?: number;
  },
): Promise<ServerContextRows | null> {
  const { config, project, folderProjects, platformSource, timeoutMs } = request;
  const wanted = config.totalObservationCount + config.sessionCount + SUMMARY_LOOKAHEAD;
  const limit = Math.max(1, Math.min(SERVER_CONTEXT_MAX_LIMIT, wanted));
  if (wanted > SERVER_CONTEXT_MAX_LIMIT) {
    logger.debug('HOOK', 'Server context read capped at the route limit', {
      wanted,
      limit: SERVER_CONTEXT_MAX_LIMIT,
    });
  }

  let rows: ServerRow[];
  try {
    const result = await runtime.client.contextObservations({
      projectId: runtime.projectId,
      // NO `query` KEY. With one the route ranks by FTS; with the key absent it
      // returns the NEWEST, which is what a session-start block is. `query: ''`
      // is not a third option -- the route's schema rejects it (min 1 char).
      limit,
      folderProjects,
      excludeSubagents: config.mainAgentOnly,
      ...(platformSource ? { platformSource } : {}),
    }, timeoutMs === undefined ? {} : { timeoutMs });
    rows = Array.isArray(result?.observations) ? result.observations : [];
  } catch (error) {
    logger.warn('HOOK', '[server-fallback] session-start context unavailable from the server', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }

  const summaryRows = rows.filter(row => row.kind === 'summary');
  const observationRows = rows.filter(row => row.kind !== 'summary');
  return {
    observations: observationRows
      .slice(0, config.totalObservationCount)
      .map(row => toLocalObservationShape(row, project, platformSource)),
    summaries: summaryRows
      .slice(0, config.sessionCount + SUMMARY_LOOKAHEAD)
      .map(row => toLocalSummaryShape(row, project, platformSource)),
  };
}

// A field from the top-level row, else from its metadata, else null. The route
// serializes camelCase columns and generation writes snake_case metadata keys.
function pick(row: ServerRow, ...keys: string[]): unknown {
  const metadata = (row.metadata ?? {}) as ServerRow;
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null) return row[key];
    if (metadata[key] !== undefined && metadata[key] !== null) return metadata[key];
  }
  return null;
}

function asText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  return value == null ? null : String(value);
}

// `facts`, `concepts`, `files_read` and `files_modified` are JSON *strings* in the
// local schema (the writer calls JSON.stringify on each), so they are stringified
// here too -- handing the renderer raw arrays would change what the token counter
// measures and silently skew the savings stats.
function asJsonText(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function createdAtEpoch(row: ServerRow): number {
  return Number(pick(row, 'createdAtEpoch', 'created_at_epoch')) || Date.now();
}

// The row shape mirrors the local SELECT field for field. `kind` on the server
// carries the real observation type (discovery, bugfix, change, feature,
// decision, ...), which is what `type` must be for the emoji and the type
// histogram -- NOT the literal "observation". The id is the server's own id, so
// a reference in the rendered block names the row it came from.
export function toLocalObservationShape(
  row: ServerRow,
  project: string,
  platformSource: string | undefined,
): Observation {
  const epoch = createdAtEpoch(row);
  const content = asText(row.content) ?? '';
  const firstLine = content.split('\n', 1)[0] ?? '';
  return {
    id: asText(row.id) ?? '',
    memory_session_id: asText(pick(row, 'serverSessionId', 'memory_session_id')) ?? '',
    platform_source: platformSource ?? '',
    type: asText(pick(row, 'kind', 'type')) ?? 'discovery',
    title: asText(pick(row, 'title')) ?? firstLine,
    subtitle: asText(pick(row, 'subtitle')),
    narrative: asText(pick(row, 'narrative')) ?? (content || null),
    facts: asJsonText(pick(row, 'facts')),
    concepts: asJsonText(pick(row, 'concepts')),
    files_read: asJsonText(pick(row, 'files_read', 'filesRead')),
    files_modified: asJsonText(pick(row, 'files_modified', 'filesModified')),
    discovery_tokens: null,
    created_at: new Date(epoch).toISOString(),
    created_at_epoch: epoch,
    project: asText(pick(row, 'project')) ?? project,
  };
}

// A server summary is a kind='summary' observation whose metadata carries the
// summary fields (processSessionSummaryResponse).
export function toLocalSummaryShape(
  row: ServerRow,
  project: string,
  platformSource: string | undefined,
): SessionSummary {
  const epoch = createdAtEpoch(row);
  return {
    id: asText(row.id) ?? '',
    memory_session_id: asText(pick(row, 'serverSessionId', 'memory_session_id')) ?? '',
    platform_source: platformSource ?? '',
    request: asText(pick(row, 'request')),
    investigated: asText(pick(row, 'investigated')),
    learned: asText(pick(row, 'learned')),
    completed: asText(pick(row, 'completed')),
    next_steps: asText(pick(row, 'next_steps', 'nextSteps')),
    notes: asText(pick(row, 'notes')),
    created_at: new Date(epoch).toISOString(),
    created_at_epoch: epoch,
    project: asText(pick(row, 'project')) ?? project,
  };
}
