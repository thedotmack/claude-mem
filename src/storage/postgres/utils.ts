// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from 'crypto';
import type { QueryResult, QueryResultRow } from 'pg';

export type JsonObject = Record<string, unknown>;
export type JsonValue = unknown;

export interface PostgresQueryable {
  query<T extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<T>>;
}

export function newId(): string {
  return randomUUID();
}

export function toJsonObject(value: unknown): JsonObject {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as JsonObject;
  }
  return {};
}

export function toJsonArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function toEpoch(value: Date | string | number): number {
  if (typeof value === 'number') {
    return value;
  }
  return new Date(value).getTime();
}

export function toDate(value: Date | string | number | null | undefined): Date | null {
  if (value == null) {
    return null;
  }
  return value instanceof Date ? value : new Date(value);
}

export async function queryOne<T extends QueryResultRow>(
  client: PostgresQueryable,
  text: string,
  values: unknown[] = []
): Promise<T | null> {
  const result = await client.query<T>(text, values);
  return result.rows[0] ?? null;
}

export async function assertProjectOwnership(
  client: PostgresQueryable,
  projectId: string,
  teamId: string
): Promise<void> {
  const row = await queryOne<{ id: string }>(
    client,
    'SELECT id FROM projects WHERE id = $1 AND team_id = $2',
    [projectId, teamId]
  );
  if (!row) {
    throw new Error('project_id must belong to team_id');
  }
}

export async function assertSessionOwnership(
  client: PostgresQueryable,
  serverSessionId: string,
  projectId: string,
  teamId: string
): Promise<void> {
  const row = await queryOne<{ id: string }>(
    client,
    'SELECT id FROM server_sessions WHERE id = $1 AND project_id = $2 AND team_id = $3',
    [serverSessionId, projectId, teamId]
  );
  if (!row) {
    throw new Error('server_session_id must belong to project_id and team_id');
  }
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

export function deterministicKey(parts: readonly unknown[]): string {
  const fingerprint = createHash('sha256')
    .update(canonicalJson(parts))
    .digest('hex');
  return fingerprint;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.keys(record)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = sortJson(record[key]);
        return acc;
      }, {});
  }
  return value;
}
