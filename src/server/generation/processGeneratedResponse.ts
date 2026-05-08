// SPDX-License-Identifier: Apache-2.0

import { parseAgentXml, type ParsedObservation, type ParsedSummary } from '../../sdk/parser.js';
import { logger } from '../../utils/logger.js';
import {
  PostgresObservationRepository,
  PostgresObservationSourcesRepository,
  buildObservationGenerationKey,
  type PostgresObservation,
} from '../../storage/postgres/observations.js';
import {
  PostgresObservationGenerationJobEventsRepository,
  PostgresObservationGenerationJobRepository,
  type PostgresObservationGenerationJob,
} from '../../storage/postgres/generation-jobs.js';
import { PostgresAuthRepository } from '../../storage/postgres/auth.js';
import {
  withPostgresTransaction,
  type PostgresPool,
} from '../../storage/postgres/pool.js';
import { stripTags } from '../../utils/tag-stripping.js';

// processGeneratedResponse owns the full "we got XML from a provider →
// persist + link + advance outbox" pipeline. Every side-effect runs inside
// a single Postgres transaction so retries are idempotent:
//
//   - observations.generation_key (UNIQUE per team/project) collapses retry
//     duplicates to a single row.
//   - observation_sources (UNIQUE on observation_id, source_type, source_id)
//     collapses duplicate source links.
//   - observation_generation_jobs.transitionStatus is the lifecycle gate.
//
// The function NEVER touches worker SessionStore tables, NEVER assumes a
// Claude Code transcript shape, and ALWAYS reloads the job before mutating.
// BullMQ payload data is advisory; the outbox row is canonical.

export type ProcessGeneratedResponseOutcome =
  | {
      kind: 'completed';
      jobId: string;
      observations: PostgresObservation[];
      privateContentDetected: boolean;
    }
  | { kind: 'parse_error'; jobId: string; reason: string };

export interface ProcessGeneratedResponseInput {
  pool: PostgresPool;
  job: PostgresObservationGenerationJob;
  rawText: string;
  modelId?: string;
  providerLabel: string;
  workerId?: string;
  // Phase 11 — identity context propagated from the BullMQ payload (and
  // ultimately the API-key that ingested the source row). Persisted on
  // observation_sources.metadata for traceability and re-emitted in the
  // observation.created audit row.
  apiKeyId?: string | null;
  actorId?: string | null;
  sourceAdapter?: string | null;
}

export async function processGeneratedResponse(
  input: ProcessGeneratedResponseInput,
): Promise<ProcessGeneratedResponseOutcome> {
  const { job, rawText } = input;

  const parsed = parseAgentXml(rawText, job.id);
  if (!parsed.valid) {
    return { kind: 'parse_error', jobId: job.id, reason: 'parser rejected response' };
  }

  // Skip-summary or zero-observation responses are still a success — the
  // provider explicitly decided there's nothing worth recording (e.g.
  // privacy-stripped batch). Mark the job completed with no observations.
  const observationsToWrite = parsed.observations ?? [];
  const skipped = parsed.summary?.skipped === true;
  const privateContentDetected = skipped || observationsToWrite.length === 0;

  return await withPostgresTransaction(input.pool, async (client) => {
    const obsRepo = new PostgresObservationRepository(client);
    const sourcesRepo = new PostgresObservationSourcesRepository(client);
    const jobsRepo = new PostgresObservationGenerationJobRepository(client);
    const eventsLogRepo = new PostgresObservationGenerationJobEventsRepository(client);
    const auditRepo = new PostgresAuthRepository(client);

    // Reload the job inside the transaction. If it was already completed
    // by another worker, return its existing observations idempotently.
    const fresh = await jobsRepo.getByIdForScope({
      id: job.id,
      projectId: job.projectId,
      teamId: job.teamId,
    });
    if (!fresh) {
      throw new Error(`generation job ${job.id} not found in scope`);
    }
    if (fresh.status === 'completed' || fresh.status === 'cancelled' || fresh.status === 'failed') {
      logger.info('SYSTEM', 'generation job already in terminal status; skipping persistence', {
        jobId: fresh.id,
        status: fresh.status,
      });
      return {
        kind: 'completed' as const,
        jobId: fresh.id,
        observations: [],
        privateContentDetected,
      };
    }

    const persisted: PostgresObservation[] = [];
    for (let index = 0; index < observationsToWrite.length; index++) {
      const parsedObservation = observationsToWrite[index]!;
      const content = renderObservationContent(parsedObservation);
      if (!content || content.trim().length === 0) {
        continue;
      }

      // Defense-in-depth: even if the parser slipped a private-tagged
      // string through, scrub before persisting.
      const scrubbed = stripTags(content);
      if (!scrubbed.stripped || scrubbed.stripped.trim().length === 0) {
        continue;
      }

      const generationKey = buildObservationGenerationKey({
        generationJobId: fresh.id,
        parsedObservationIndex: index,
        content: scrubbed.stripped,
      });

      const observation = await obsRepo.create({
        projectId: fresh.projectId,
        teamId: fresh.teamId,
        serverSessionId: fresh.serverSessionId,
        kind: parsedObservation.type ?? 'observation',
        content: scrubbed.stripped,
        generationKey,
        metadata: {
          title: parsedObservation.title,
          subtitle: parsedObservation.subtitle,
          facts: parsedObservation.facts,
          narrative: parsedObservation.narrative,
          concepts: parsedObservation.concepts,
          files_read: parsedObservation.files_read,
          files_modified: parsedObservation.files_modified,
          provider: input.providerLabel,
          model: input.modelId ?? null,
        },
        createdByJobId: fresh.id,
      });
      persisted.push(observation);

      await sourcesRepo.addSource({
        observationId: observation.id,
        projectId: fresh.projectId,
        teamId: fresh.teamId,
        sourceType: fresh.sourceType,
        sourceId: fresh.sourceId,
        agentEventId: fresh.agentEventId ?? null,
        generationJobId: fresh.id,
        metadata: {
          provider: input.providerLabel,
          parsedObservationIndex: index,
          // Phase 11 — denormalize identity context for traceability so an
          // operator can answer "which api key produced this observation?"
          // without joining back through generation_job → outbox → key.
          source_adapter: input.sourceAdapter ?? null,
          actor_id: input.actorId ?? null,
          api_key_id: input.apiKeyId ?? null,
        },
      });

      // Phase 11 — audit each generated observation. Using the SAME
      // generation_job_id reference so the audit chain (event_received →
      // generation_job.queued → generation_job.processing → observation.
      // created → observation.read) can be reconstructed.
      try {
        await auditRepo.createAuditLog({
          teamId: fresh.teamId,
          projectId: fresh.projectId,
          actorId: input.actorId ?? null,
          apiKeyId: input.apiKeyId ?? null,
          action: 'observation.created',
          resourceType: 'observation',
          resourceId: observation.id,
          details: {
            generationJobId: fresh.id,
            sourceType: fresh.sourceType,
            sourceId: fresh.sourceId,
            provider: input.providerLabel,
            model: input.modelId ?? null,
            sourceAdapter: input.sourceAdapter ?? null,
            parsedObservationIndex: index,
          },
        });
      } catch (auditError) {
        logger.warn('SYSTEM', 'audit_log observation.created insert failed', {
          observationId: observation.id,
          error: auditError instanceof Error ? auditError.message : String(auditError),
        });
      }
    }

    // Advance outbox status. Phase 1 transitionStatus enforces legal
    // transitions and tenant scope inside its WHERE clause.
    await jobsRepo.transitionStatus({
      id: fresh.id,
      projectId: fresh.projectId,
      teamId: fresh.teamId,
      status: 'completed',
    });
    await eventsLogRepo.append({
      generationJobId: fresh.id,
      projectId: fresh.projectId,
      teamId: fresh.teamId,
      eventType: 'completed',
      statusAfter: 'completed',
      attempt: fresh.attempts,
      details: {
        provider: input.providerLabel,
        model: input.modelId ?? null,
        observationCount: persisted.length,
        privateContentDetected,
        workerId: input.workerId ?? null,
      },
    });

    // Audit log — best-effort; failure here would already be inside the
    // transaction so any insert error rolls everything back. We accept
    // that to keep the pipeline observable end-to-end.
    try {
      await auditRepo.createAuditLog({
        teamId: fresh.teamId,
        projectId: fresh.projectId,
        actorId: input.actorId ?? null,
        apiKeyId: input.apiKeyId ?? null,
        action: 'generation_job.completed',
        resourceType: 'observation_generation_job',
        resourceId: fresh.id,
        details: {
          generationJobId: fresh.id,
          provider: input.providerLabel,
          model: input.modelId ?? null,
          observationCount: persisted.length,
          observationIds: persisted.map(o => o.id),
          sourceAdapter: input.sourceAdapter ?? null,
        },
      });
    } catch (auditError) {
      // The audit log table may not have a metadata column on older
      // schemas; swallow rather than failing generation.
      logger.warn('SYSTEM', 'audit log insert failed during generation', {
        jobId: fresh.id,
        error: auditError instanceof Error ? auditError.message : String(auditError),
      });
    }

    return {
      kind: 'completed' as const,
      jobId: fresh.id,
      observations: persisted,
      privateContentDetected,
    };
  });
}

export interface MarkGenerationFailedInput {
  pool: PostgresPool;
  job: PostgresObservationGenerationJob;
  reason: string;
  classification?: string;
  retryable: boolean;
  workerId?: string;
}

/**
 * Move a generation job to a non-success terminal state. Used when the
 * provider returned an error or invalid XML. Retryable failures move the
 * job back to `queued` so reconciliation can re-enqueue; non-retryable
 * failures move to `failed`.
 */
export async function markGenerationFailed(input: MarkGenerationFailedInput): Promise<void> {
  await withPostgresTransaction(input.pool, async (client) => {
    const jobsRepo = new PostgresObservationGenerationJobRepository(client);
    const eventsLogRepo = new PostgresObservationGenerationJobEventsRepository(client);

    const fresh = await jobsRepo.getByIdForScope({
      id: input.job.id,
      projectId: input.job.projectId,
      teamId: input.job.teamId,
    });
    if (!fresh || fresh.status === 'completed' || fresh.status === 'cancelled') {
      return;
    }

    const canRetry = input.retryable && fresh.attempts < fresh.maxAttempts;
    const target = canRetry ? 'queued' : 'failed';

    await jobsRepo.transitionStatus({
      id: fresh.id,
      projectId: fresh.projectId,
      teamId: fresh.teamId,
      status: target,
      lastError: { reason: input.reason, classification: input.classification ?? null },
      ...(canRetry ? { nextAttemptAt: new Date(Date.now() + retryDelayMs(fresh.attempts)) } : {}),
    });

    await eventsLogRepo.append({
      generationJobId: fresh.id,
      projectId: fresh.projectId,
      teamId: fresh.teamId,
      eventType: canRetry ? 'retry_scheduled' : 'failed',
      statusAfter: target,
      attempt: fresh.attempts,
      details: {
        reason: input.reason,
        classification: input.classification ?? null,
        workerId: input.workerId ?? null,
      },
    });
  });
}

/**
 * Persist a parsed session summary as an observations row with kind='summary'.
 *
 * Wraps the same outbox transition / source-link / audit pipeline as
 * processGeneratedResponse but emits a single 'summary'-kind observation
 * derived from the summary fields. Idempotency is enforced through the same
 * `observations.generation_key` UNIQUE index — re-running the summary job
 * after a restart will collapse to one row.
 */
export async function processSessionSummaryResponse(
  input: ProcessGeneratedResponseInput,
): Promise<ProcessGeneratedResponseOutcome> {
  const { job, rawText } = input;

  if (job.sourceType !== 'session_summary') {
    return { kind: 'parse_error', jobId: job.id, reason: 'session summary processor invoked on non-summary job' };
  }

  const parsed = parseAgentXml(rawText, job.id);
  if (!parsed.valid) {
    return { kind: 'parse_error', jobId: job.id, reason: 'parser rejected summary response' };
  }

  const summary = parsed.summary ?? null;
  const skipped = summary?.skipped === true;
  const summaryContent = summary ? renderSummaryContent(summary) : '';
  const privateContentDetected = skipped || summaryContent.trim().length === 0;

  return await withPostgresTransaction(input.pool, async (client) => {
    const obsRepo = new PostgresObservationRepository(client);
    const sourcesRepo = new PostgresObservationSourcesRepository(client);
    const jobsRepo = new PostgresObservationGenerationJobRepository(client);
    const eventsLogRepo = new PostgresObservationGenerationJobEventsRepository(client);
    const auditRepo = new PostgresAuthRepository(client);

    const fresh = await jobsRepo.getByIdForScope({
      id: job.id,
      projectId: job.projectId,
      teamId: job.teamId,
    });
    if (!fresh) {
      throw new Error(`session summary generation job ${job.id} not found in scope`);
    }
    if (fresh.status === 'completed' || fresh.status === 'cancelled' || fresh.status === 'failed') {
      logger.info('SYSTEM', 'session summary job already in terminal status; skipping persistence', {
        jobId: fresh.id,
        status: fresh.status,
      });
      return {
        kind: 'completed' as const,
        jobId: fresh.id,
        observations: [],
        privateContentDetected,
      };
    }

    const persisted: PostgresObservation[] = [];
    if (!privateContentDetected) {
      const scrubbed = stripTags(summaryContent);
      const scrubbedContent = scrubbed.stripped ?? '';
      if (scrubbedContent.trim().length > 0) {
        const generationKey = buildObservationGenerationKey({
          generationJobId: fresh.id,
          parsedObservationIndex: 0,
          content: scrubbedContent,
        });
        const observation = await obsRepo.create({
          projectId: fresh.projectId,
          teamId: fresh.teamId,
          serverSessionId: fresh.serverSessionId,
          kind: 'summary',
          content: scrubbedContent,
          generationKey,
          metadata: {
            request: summary?.request ?? null,
            investigated: summary?.investigated ?? null,
            learned: summary?.learned ?? null,
            completed: summary?.completed ?? null,
            next_steps: summary?.next_steps ?? null,
            notes: summary?.notes ?? null,
            provider: input.providerLabel,
            model: input.modelId ?? null,
          },
          createdByJobId: fresh.id,
        });
        persisted.push(observation);

        await sourcesRepo.addSource({
          observationId: observation.id,
          projectId: fresh.projectId,
          teamId: fresh.teamId,
          sourceType: 'session_summary',
          sourceId: fresh.sourceId,
          generationJobId: fresh.id,
          metadata: {
            provider: input.providerLabel,
            parsedObservationIndex: 0,
            source_adapter: input.sourceAdapter ?? null,
            actor_id: input.actorId ?? null,
            api_key_id: input.apiKeyId ?? null,
          },
        });

        // Phase 11 — observation.created audit for the summary observation.
        try {
          await auditRepo.createAuditLog({
            teamId: fresh.teamId,
            projectId: fresh.projectId,
            actorId: input.actorId ?? null,
            apiKeyId: input.apiKeyId ?? null,
            action: 'observation.created',
            resourceType: 'observation',
            resourceId: observation.id,
            details: {
              generationJobId: fresh.id,
              sourceType: 'session_summary',
              sourceId: fresh.sourceId,
              provider: input.providerLabel,
              model: input.modelId ?? null,
              sourceAdapter: input.sourceAdapter ?? null,
              kind: 'summary',
            },
          });
        } catch (auditError) {
          logger.warn('SYSTEM', 'audit_log observation.created (summary) insert failed', {
            observationId: observation.id,
            error: auditError instanceof Error ? auditError.message : String(auditError),
          });
        }
      }
    }

    await jobsRepo.transitionStatus({
      id: fresh.id,
      projectId: fresh.projectId,
      teamId: fresh.teamId,
      status: 'completed',
    });
    await eventsLogRepo.append({
      generationJobId: fresh.id,
      projectId: fresh.projectId,
      teamId: fresh.teamId,
      eventType: 'completed',
      statusAfter: 'completed',
      attempt: fresh.attempts,
      details: {
        provider: input.providerLabel,
        model: input.modelId ?? null,
        observationCount: persisted.length,
        privateContentDetected,
        workerId: input.workerId ?? null,
        sourceType: 'session_summary',
      },
    });

    try {
      await auditRepo.createAuditLog({
        teamId: fresh.teamId,
        projectId: fresh.projectId,
        actorId: input.actorId ?? null,
        apiKeyId: input.apiKeyId ?? null,
        action: 'generation_job.completed',
        resourceType: 'observation_generation_job',
        resourceId: fresh.id,
        details: {
          generationJobId: fresh.id,
          provider: input.providerLabel,
          model: input.modelId ?? null,
          observationCount: persisted.length,
          observationIds: persisted.map(o => o.id),
          sourceAdapter: input.sourceAdapter ?? null,
          sourceType: 'session_summary',
        },
      });
    } catch (auditError) {
      logger.warn('SYSTEM', 'audit log insert failed during summary generation', {
        jobId: fresh.id,
        error: auditError instanceof Error ? auditError.message : String(auditError),
      });
    }

    return {
      kind: 'completed' as const,
      jobId: fresh.id,
      observations: persisted,
      privateContentDetected,
    };
  });
}

function renderSummaryContent(summary: ParsedSummary): string {
  const parts: string[] = [];
  if (summary.request) parts.push(`Request: ${summary.request}`);
  if (summary.investigated) parts.push(`Investigated: ${summary.investigated}`);
  if (summary.learned) parts.push(`Learned: ${summary.learned}`);
  if (summary.completed) parts.push(`Completed: ${summary.completed}`);
  if (summary.next_steps) parts.push(`Next steps: ${summary.next_steps}`);
  if (summary.notes) parts.push(`Notes: ${summary.notes}`);
  return parts.join('\n\n').trim();
}

function renderObservationContent(observation: ParsedObservation): string {
  const parts: string[] = [];
  if (observation.title) parts.push(observation.title);
  if (observation.subtitle) parts.push(observation.subtitle);
  if (observation.narrative) parts.push(observation.narrative);
  if (observation.facts && observation.facts.length > 0) {
    parts.push(observation.facts.map(f => `- ${f}`).join('\n'));
  }
  return parts.join('\n\n').trim();
}

function retryDelayMs(attempts: number): number {
  // Exponential backoff: 5s, 25s, 125s, capped at 10 minutes.
  const base = 5000 * Math.pow(5, Math.max(0, attempts));
  return Math.min(base, 10 * 60 * 1000);
}
