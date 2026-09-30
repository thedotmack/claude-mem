// SPDX-License-Identifier: Apache-2.0

import type { GenerateSessionSummaryJob } from '../jobs/types.js';
import { buildServerJobId } from '../jobs/job-id.js';

export interface BuildSummaryJobInput {
  serverSessionId: string;
  teamId: string;
  projectId: string;
  generationJobId: string;
  // Phase 11 — identity context captured at HTTP ingest time so the BullMQ
  // payload carries every audit field. apiKeyId may be null for local-dev
  // enqueues and `actorId` follows the api key's `actor_id` column.
  apiKeyId?: string | null;
  actorId?: string | null;
  sourceAdapter?: string | null;
  // Phase 12 — request correlation id flows into the summary lane too.
  requestId?: string | null;
}

export function buildSummaryJobId(input: {
  serverSessionId: string;
  teamId: string;
  projectId: string;
}): string {
  return buildServerJobId({
    kind: 'summary',
    team_id: input.teamId,
    project_id: input.projectId,
    source_type: 'session_summary',
    source_id: input.serverSessionId,
  });
}

export function buildSummaryJobPayload(input: BuildSummaryJobInput): GenerateSessionSummaryJob {
  return {
    kind: 'summary',
    team_id: input.teamId,
    project_id: input.projectId,
    source_type: 'session_summary',
    source_id: input.serverSessionId,
    generation_job_id: input.generationJobId,
    server_session_id: input.serverSessionId,
    api_key_id: input.apiKeyId ?? null,
    actor_id: input.actorId ?? null,
    source_adapter: input.sourceAdapter ?? 'api',
    request_id: input.requestId ?? null,
  };
}
