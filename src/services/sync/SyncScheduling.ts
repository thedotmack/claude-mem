import type { CanonicalMutation, ContentKind } from './CanonicalContent.js';

/** SQL fragments only use application-owned identifiers; values stay bound. */
export interface ContentScopeSql {
  kind: string;
  localId: string;
  rev: string;
  project: string;
  memory: string;
  content: string;
  merged: string;
  deleted: string;
}

// Dependency discovery is not the validator/quarantine lane. A later corrupt
// row must stay inert until FIFO processing reaches it, including valid JSON
// whose `mutation` is a string (json_extract would otherwise return unquoted
// text that the next json_extract tries to parse). Nested CASE guards also
// avoid relying on SQLite's evaluation order for AND on invalid JSON.
export const PENDING_MUTATIONS_SQL = `(SELECT id, rev,
  CASE WHEN json_type(candidate, '$.fields') = 'object' AND CASE json_extract(candidate, '$.op')
    WHEN 'set_title' THEN json_type(candidate, '$.target') = 'object'
    WHEN 'set_prompt_session' THEN json_type(candidate, '$.target') = 'object'
    WHEN 'remap_project' THEN json_type(candidate, '$.where') = 'object'
    ELSE 0 END THEN candidate ELSE NULL END AS mutation
  FROM (SELECT id, CAST(rev AS TEXT) AS rev,
    CASE WHEN canonical_body IS NOT NULL THEN CASE WHEN json_valid(canonical_body) THEN
      CASE WHEN json_type(canonical_body, '$.mutation') = 'object'
        THEN json_extract(canonical_body, '$.mutation') END END
      ELSE CASE WHEN json_valid(body) THEN
        CASE WHEN json_type(body) = 'object' THEN body END END
      END AS candidate FROM sync_outbox))`;
export const HEAD_MUTATION_SQL = `(SELECT * FROM ${PENDING_MUTATIONS_SQL} ORDER BY id LIMIT 1)`;

const field = (path: string) => `json_extract(m.mutation, '$.${path}')`;
const equals = (a: string, b: string) => `(${a} IS NOT NULL AND ${a} = ${b})`;
const olderOrEqual = (a: string, b: string) => `(length(${a}) < length(${b}) OR (length(${a}) = length(${b}) AND ${a} <= ${b}))`;

function remapPredicate(s: ContentScopeSql, after: boolean): string {
  const project = after ? `COALESCE(${field('fields.project')}, ${field('where.project')})` : field('where.project');
  const merged = after ? field('fields.merged_into_project') : 'NULL';
  return `(${field('where.project')} IS NULL OR ${s.project} = ${project})
    AND (${field('where.memory_session_id')} IS NULL OR ${s.memory} = ${field('where.memory_session_id')})
    AND (COALESCE(${field('where.merged_into_project_is_null')}, 0) != 1
      OR ${s.merged} IS ${merged})`;
}

/** Content touched before or after an outstanding local mutation. */
export function affectedByMutationSql(s: ContentScopeSql, deviceSql: string): string {
  return `(${s.deleted} = 0 AND CASE ${field('op')}
    WHEN 'set_title' THEN (${equals(field('target.memory_session_id'), s.memory)}
      OR ${equals(field('target.content_session_id'), s.content)})
    WHEN 'set_prompt_session' THEN (${s.kind} = 'prompt'
      AND COALESCE(${field('target.origin_device_id')}, ${deviceSql}) = ${deviceSql}
      AND ${s.localId} = ${field('target.origin_local_id')})
    WHEN 'remap_project' THEN ((${s.kind} IN ('observation', 'summary')
      AND ((${remapPredicate(s, false)}) OR (${remapPredicate(s, true)})))
      OR (${s.kind} IN ('observation', 'summary', 'prompt')
        AND ${field('fields.project')} IS NOT NULL
        AND ${equals(field('where.memory_session_id'), s.memory)}))
    ELSE 0 END)`;
}

/** Only pre-mutation bytes need to reach replicas before a repair/remap. */
export function mutationPrerequisiteSql(s: ContentScopeSql, deviceSql: string): string {
  return `(${s.deleted} = 0 AND CASE ${field('op')}
    WHEN 'set_prompt_session' THEN (${s.kind} = 'prompt'
      AND COALESCE(${field('target.origin_device_id')}, ${deviceSql}) = ${deviceSql}
      AND ${s.localId} = ${field('target.origin_local_id')}
      AND ${olderOrEqual(s.rev, 'm.rev')})
    WHEN 'remap_project' THEN ((${s.kind} IN ('observation', 'summary')
      AND (${remapPredicate(s, false)}) AND ${olderOrEqual(s.rev, 'm.rev')})
      OR (${s.kind} IN ('observation', 'summary', 'prompt')
        AND ${field('fields.project')} IS NOT NULL
        AND ${equals(field('where.memory_session_id'), s.memory)}
        AND ${s.project} != ${field('fields.project')}))
    ELSE 0 END)`;
}

const frozenField = (key: string) => `CASE WHEN json_valid(o.body) THEN json_extract(o.body, '$.payload.${key}') END`;
export const FROZEN_SCOPE: ContentScopeSql = {
  kind: 'o.kind', localId: 'o.origin_local_id', rev: 'o.entity_rev', deleted: 'o.deleted',
  project: frozenField('project'), memory: frozenField('memory_session_id'),
  content: frozenField('content_session_id'), merged: frozenField('merged_into_project'),
};

export function nativeScope(kind: ContentKind): ContentScopeSql {
  if (kind === 'prompt') return {
    kind: "'prompt'", localId: 'CAST(up.id AS TEXT)', rev: 'CAST(up.sync_rev AS TEXT)', deleted: '0',
    project: 's.project', memory: 's.memory_session_id', content: 'up.content_session_id', merged: 'NULL',
  };
  return {
    kind: `'${kind}'`, localId: 'CAST(id AS TEXT)', rev: 'CAST(sync_rev AS TEXT)', deleted: '0',
    project: 'project', memory: kind === 'work_state' ? 'NULL' : 'memory_session_id',
    content: kind === 'work_state' ? 'NULL' : '(SELECT content_session_id FROM sdk_sessions WHERE sdk_sessions.memory_session_id = ' + (kind === 'observation' ? 'observations' : 'session_summaries') + '.memory_session_id LIMIT 1)',
    merged: kind === 'work_state' ? 'NULL' : 'merged_into_project',
  };
}

export interface MutationBlockage {
  id: string;
  op: CanonicalMutation['op'];
  pendingPrerequisites: number;
  oldestPrerequisiteQueuedAt: number | null;
  queuedAt: number;
  observedAt: number;
}
