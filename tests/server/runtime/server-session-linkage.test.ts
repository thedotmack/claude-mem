// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'bun:test';
import { ServerV1PostgresRoutes } from '../../../src/server/routes/v1/ServerV1PostgresRoutes.js';
import { DisabledServerQueueManager } from '../../../src/server/runtime/types.js';
import type { CreatePostgresAgentEventInput } from '../../../src/storage/postgres/agent-events.js';
import type { PostgresPool } from '../../../src/storage/postgres/pool.js';

describe('ServerV1PostgresRoutes content session linkage', () => {
  it('applies cached platform-scoped contentSessionId lookups to batch inputs', async () => {
    const calls: Array<{ text: string; values?: unknown[] }> = [];
    const pool = {
      async query(text: string, values?: unknown[]) {
        calls.push({ text, values });
        const key = JSON.stringify(values);
        const rowsByKey = new Map<string, Array<{ id: string }>>([
          [JSON.stringify(['shared-content', 'project-1', 'team-1', true, 'cursor']), [{ id: 'cursor-session' }]],
          [JSON.stringify(['shared-content', 'project-1', 'team-1', true, 'codex']), [{ id: 'codex-session' }]],
        ]);
        return {
          command: 'SELECT',
          rowCount: rowsByKey.get(key)?.length ?? 0,
          oid: 0,
          fields: [],
          rows: rowsByKey.get(key) ?? [],
        };
      },
    } as unknown as PostgresPool;
    const routes = new ServerV1PostgresRoutes({
      pool,
      queueManager: new DisabledServerQueueManager('unit test'),
    });
    const inputs = [
      createInput({ platformSource: 'cursor', payload: { index: 1 } }),
      createInput({ platformSource: 'cursor', payload: { index: 2 } }),
      createInput({ platformSource: 'codex', payload: { index: 3 } }),
      createInput({ contentSessionId: 'missing-content', platformSource: 'cursor', payload: { index: 4 } }),
    ];

    await (routes as unknown as {
      applyContentSessionLinks(
        inputs: CreatePostgresAgentEventInput[],
        rawBodies: unknown[],
        teamId: string,
      ): Promise<void>;
    }).applyContentSessionLinks(
      inputs,
      [
        { platformSource: 'Cursor' },
        { platformSource: 'cursor-cli' },
        { platformSource: 'Codex CLI' },
        { platformSource: 'cursor' },
      ],
      'team-1',
    );

    expect(inputs.map(input => input.serverSessionId ?? null)).toEqual([
      'cursor-session',
      'cursor-session',
      'codex-session',
      null,
    ]);
    expect(calls).toHaveLength(3);
    expect(calls.map(call => call.values)).toEqual([
      ['shared-content', 'project-1', 'team-1', true, 'cursor'],
      ['shared-content', 'project-1', 'team-1', true, 'codex'],
      ['missing-content', 'project-1', 'team-1', true, 'cursor'],
    ]);
  });

  it('distinguishes omitted platformSource from explicit null for contentSessionId lookup', async () => {
    const calls: Array<{ values?: unknown[] }> = [];
    const pool = {
      async query(_text: string, values?: unknown[]) {
        calls.push({ values });
        const key = JSON.stringify(values);
        const rowsByKey = new Map<string, Array<{ id: string }>>([
          [JSON.stringify(['shared-content', 'project-1', 'team-1', true, null]), [{ id: 'legacy-session' }]],
          [JSON.stringify(['shared-content', 'project-1', 'team-1', false, null]), [{ id: 'latest-any-platform-session' }]],
        ]);
        return {
          command: 'SELECT',
          rowCount: rowsByKey.get(key)?.length ?? 0,
          oid: 0,
          fields: [],
          rows: rowsByKey.get(key) ?? [],
        };
      },
    } as unknown as PostgresPool;
    const routes = new ServerV1PostgresRoutes({
      pool,
      queueManager: new DisabledServerQueueManager('unit test'),
    });
    const inputs = [
      createInput({ platformSource: null, payload: { index: 1 } }),
      createInput({ platformSource: null, payload: { index: 2 } }),
    ];

    await (routes as unknown as {
      applyContentSessionLinks(
        inputs: CreatePostgresAgentEventInput[],
        rawBodies: unknown[],
        teamId: string,
      ): Promise<void>;
    }).applyContentSessionLinks(
      inputs,
      [
        { platformSource: null },
        {},
      ],
      'team-1',
    );

    expect(inputs.map(input => input.serverSessionId ?? null)).toEqual([
      'legacy-session',
      'latest-any-platform-session',
    ]);
    expect(calls.map(call => call.values)).toEqual([
      ['shared-content', 'project-1', 'team-1', true, null],
      ['shared-content', 'project-1', 'team-1', false, null],
    ]);
  });
});

function createInput(overrides: Partial<CreatePostgresAgentEventInput> = {}): CreatePostgresAgentEventInput {
  return {
    projectId: 'project-1',
    teamId: 'team-1',
    contentSessionId: 'shared-content',
    sourceAdapter: 'api',
    eventType: 'tool_use',
    platformSource: null,
    payload: {},
    occurredAt: new Date('2026-06-29T19:00:00.000Z'),
    ...overrides,
  };
}
