// SPDX-License-Identifier: Apache-2.0

import type { JobsOptions } from 'bullmq';
import type {
  GenerateObservationsForEventJob,
  GenerateSessionSummaryJob,
} from '../jobs/types.js';
import { buildServerJobId } from '../jobs/job-id.js';
import type { PostgresAgentEvent } from '../../storage/postgres/agent-events.js';
import type { PostgresObservationGenerationJob } from '../../storage/postgres/generation-jobs.js';

// SessionGenerationPolicy decides WHEN to enqueue work for the BullMQ event
// and summary lanes. It is configurable via:
//   - CLAUDE_MEM_SERVER_SESSION_POLICY env var (per-process default)
//   - per-call override (per-team settings can plug in here later)
//
// Three policies are supported:
//   - 'per-event'      (default): enqueue immediately on every event POST.
//                       Matches Phase 4/5 behavior.
//   - 'debounce':       enqueue with `delay`; when a new event arrives within
//                       the window, replace the delayed job (deterministic
//                       BullMQ jobId means re-add(jobId, ...) overwrites the
//                       waiting entry, and removeOnComplete/Fail keep things
//                       tidy). Outbox row is canonical so durability is safe.
//   - 'end-of-session': only enqueue summary jobs at /v1/sessions/:id/end.
//                       Per-event posts skip BullMQ entirely; the outbox row
//                       remains in `queued` state and startup reconciliation
//                       will publish it later (or it can be cancelled).
//
// Anti-pattern guard: the policy MUST NOT use ActiveSession-style cached
// state. Inputs are always reloaded by the caller from Postgres before this
// fires.

export type ServerSessionGenerationPolicy = 'per-event' | 'debounce' | 'end-of-session';

const DEFAULT_DEBOUNCE_MS = 5000;

export interface SessionGenerationPolicyOptions {
  policy?: ServerSessionGenerationPolicy;
  debounceWindowMs?: number;
}

export function resolveSessionGenerationPolicy(
  options: SessionGenerationPolicyOptions = {},
): { policy: ServerSessionGenerationPolicy; debounceWindowMs: number } {
  const envPolicy = (process.env.CLAUDE_MEM_SERVER_SESSION_POLICY ?? '').trim().toLowerCase();
  const policy: ServerSessionGenerationPolicy = options.policy
    ?? (envPolicy === 'debounce' || envPolicy === 'end-of-session' || envPolicy === 'per-event'
      ? envPolicy
      : 'per-event');
  const debounceWindowMs = options.debounceWindowMs
    ?? (Number.parseInt(process.env.CLAUDE_MEM_SERVER_SESSION_DEBOUNCE_MS ?? '', 10)
      || DEFAULT_DEBOUNCE_MS);
  return {
    policy,
    debounceWindowMs: Number.isFinite(debounceWindowMs) && debounceWindowMs > 0
      ? debounceWindowMs
      : DEFAULT_DEBOUNCE_MS,
  };
}

export interface EnqueueEventDecisionInput {
  event: PostgresAgentEvent;
  outbox: PostgresObservationGenerationJob;
  // Phase 11 — identity context captured at HTTP ingest time so the BullMQ
  // payload carries every audit field. apiKeyId may be null for local-dev
  // enqueues and `actorId` follows the api key's `actor_id` column.
  apiKeyId?: string | null;
  actorId?: string | null;
  sourceAdapter?: string | null;
  // Phase 12 — request correlation id minted at the HTTP boundary.
  requestId?: string | null;
}

export interface EnqueueEventDecision {
  shouldEnqueue: boolean;
  jobId: string;
  payload: GenerateObservationsForEventJob;
  jobsOptions?: JobsOptions;
  reason: 'per-event' | 'debounce' | 'end-of-session-skip';
}

export function buildEnqueueEventDecision(
  input: EnqueueEventDecisionInput,
  options: SessionGenerationPolicyOptions = {},
): EnqueueEventDecision {
  const resolved = resolveSessionGenerationPolicy(options);
  const jobId = input.outbox.bullmqJobId ?? buildServerJobId({
    kind: 'event',
    team_id: input.event.teamId,
    project_id: input.event.projectId,
    source_type: 'agent_event',
    source_id: input.event.id,
  });
  const payload: GenerateObservationsForEventJob = {
    kind: 'event',
    team_id: input.outbox.teamId,
    project_id: input.outbox.projectId,
    source_type: 'agent_event',
    source_id: input.event.id,
    generation_job_id: input.outbox.id,
    agent_event_id: input.event.id,
    api_key_id: input.apiKeyId ?? null,
    actor_id: input.actorId ?? null,
    source_adapter: input.sourceAdapter ?? input.event.sourceAdapter ?? 'api',
    request_id: input.requestId ?? null,
  };

  if (resolved.policy === 'end-of-session') {
    return { shouldEnqueue: false, jobId, payload, reason: 'end-of-session-skip' };
  }

  if (resolved.policy === 'debounce') {
    return {
      shouldEnqueue: true,
      jobId,
      payload,
      jobsOptions: { delay: resolved.debounceWindowMs },
      reason: 'debounce',
    };
  }

  return { shouldEnqueue: true, jobId, payload, reason: 'per-event' };
}

// Minimal queue surface used by scheduleDebouncedEventJob. Declared as an
// interface (instead of `Pick<ServerJobQueue<...>, ...>`) so the parameter
// accepts ServerJobQueue<ServerGenerationJobPayload> at the call site without
// triggering invariant TPayload type errors. The ServerJobQueue.add signature
// is structurally compatible — it requires `payload: TPayload`, and we only
// hand in narrowed payloads.
export interface DebounceableEventQueue {
  add(jobId: string, payload: GenerateObservationsForEventJob, options?: JobsOptions): Promise<void>;
  remove(jobId: string): Promise<void>;
  getJob(jobId: string): Promise<unknown>;
}

/**
 * Apply a debounce decision to a BullMQ queue. If a delayed job already exists
 * for this deterministic id, BullMQ's `add(jobId, ...)` will be a no-op, so we
 * proactively remove it first so the new event's delay window starts fresh.
 *
 * This implements the "if a new event arrives within window, replace the
 * delayed job" requirement.
 */
export async function scheduleDebouncedEventJob(
  queue: DebounceableEventQueue,
  decision: EnqueueEventDecision,
): Promise<void> {
  if (!decision.shouldEnqueue) return;
  if (decision.reason === 'debounce') {
    try {
      const existing = await queue.getJob(decision.jobId);
      if (existing) {
        await queue.remove(decision.jobId);
      }
    } catch {
      // best-effort; if remove fails because the job already moved to active
      // we just let `add` no-op or fail through to the caller's error handler
    }
  }
  await queue.add(decision.jobId, decision.payload, decision.jobsOptions);
}

export interface BuildSummaryJobInput {
  serverSessionId: string;
  teamId: string;
  projectId: string;
  generationJobId: string;
  // Phase 11 — same identity context the event-payload builder receives.
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
