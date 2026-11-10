import { beforeAll, expect, test } from 'bun:test';
import { CreateAgentEventSchema } from '../../../src/core/schemas/agent-event.js';
import { PostgresServerSessionsRepository } from '../../../src/storage/postgres/server-sessions.js';
import { buildServerGenerationPrompt } from '../../../src/server/generation/providers/shared/prompt-builder.js';
import type { ServerGenerationContext } from '../../../src/server/generation/providers/shared/types.js';
import type { PostgresQueryable } from '../../../src/storage/postgres/utils.js';
import { ModeManager } from '../../../src/services/domain/ModeManager.js';

beforeAll(() => ModeManager.getInstance().loadMode('code'));

for (const [name, payload, evidence] of [
  ['string', 'The deployment completed successfully.', 'The deployment completed successfully.'],
  ['array', [{ step: 'build' }, { step: 'deploy' }], '[{"step":"build"},{"step":"deploy"}]'],
  ['number', 42, '42'],
  ['boolean', false, 'false'],
  ['object', { result: 'deployed' }, '{"result":"deployed"}'],
] as const) {
  test(`session summaries retain the supported ${name} event payload`, async () => {
    const request = CreateAgentEventSchema.parse({
      projectId: 'project', serverSessionId: 'session', sourceType: 'api',
      eventType: 'result', occurredAtEpoch: 1000, payload,
    });
    const client = {
      async query() {
        return { rows: [{
          id: 'event', project_id: 'project', team_id: 'team', server_session_id: 'session',
          source_adapter: 'api', source_event_id: null, idempotency_key: 'event-key',
          event_type: request.eventType, platform_source: null, payload: request.payload, metadata: {},
          occurred_at: new Date(1000), received_at: new Date(2000), created_at: new Date(2000),
        }] };
      },
    } as PostgresQueryable;
    const events = await new PostgresServerSessionsRepository(client).listSessionEvents({
      serverSessionId: 'session', projectId: 'project', teamId: 'team',
    });

    expect(events[0].payload).toEqual(payload);
    const { prompt } = buildServerGenerationPrompt({
      events, job: { sourceType: 'session_summary' }, project: { projectName: 'project' },
    } as ServerGenerationContext);
    expect(prompt).toContain(`      <payload>\n${evidence}\n      </payload>`);
  });
}
