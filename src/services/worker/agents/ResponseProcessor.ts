
import { logger } from '../../../utils/logger.js';
import { parseAgentXml, type ParsedObservation, type ParsedSummary } from '../../../sdk/parser.js';
import { classifyObserverOutput, previewOutput } from '../../../sdk/output-classifier.js';
import { verifyCommitHashesInText } from '../../../sdk/commit-verification.js';
import { ingestSummary } from '../http/shared.js';
import { updateCursorContextForProject } from '../../integrations/CursorHooksInstaller.js';
import { notifyTelegram } from '../../integrations/TelegramNotifier.js';
import { updateFolderClaudeMdFiles } from '../../../utils/claude-md-utils.js';
import { getWorkerPort } from '../../../shared/worker-utils.js';
import { SettingsDefaultsManager } from '../../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../../shared/paths.js';
import type { ActiveSession } from '../../worker-types.js';
import type { DatabaseManager } from '../DatabaseManager.js';
import type { SessionManager } from '../SessionManager.js';
import type { WorkerRef, StorageResult } from './types.js';
import { broadcastObservation, broadcastSummary } from './ObservationBroadcaster.js';

/**
 * Consecutive non-XML observer outputs tolerated before we kill and respawn the
 * SDK session (plan-11, #2485). Idle and prose both count; poisoned triggers an
 * immediate respawn regardless of the count.
 */
export const INVALID_OUTPUT_RESPAWN_THRESHOLD = 3;

export async function processAgentResponse(
  text: string,
  session: ActiveSession,
  dbManager: DatabaseManager,
  sessionManager: SessionManager,
  worker: WorkerRef | undefined,
  discoveryTokens: number,
  originalTimestamp: number | null,
  agentName: string,
  projectRoot?: string,
  modelId?: string
): Promise<void> {
  session.lastGeneratorActivity = Date.now();

  if (text) {
    session.conversationHistory.push({ role: 'assistant', content: text });
  }

  const parsed = parseAgentXml(text, session.contentSessionId);

  if (!parsed.valid) {
    // Classify the non-XML output so a dropped batch is VISIBLE, not silent
    // (plan-11, #2485). Attach a preview for diagnostics.
    const outputClass = classifyObserverOutput(text);
    const preview = previewOutput(text);

    session.consecutiveInvalidOutputs = (session.consecutiveInvalidOutputs ?? 0) + 1;

    logger.warn('PARSER', `${agentName} returned non-XML ${outputClass} response — ignoring queued batch`, {
      sessionId: session.sessionDbId,
      outputClass,
      preview,
      consecutiveInvalidOutputs: session.consecutiveInvalidOutputs,
    });

    // Recover from poison (plan-11, #2485): a poisoned closure string means the
    // SDK session is wedged and will keep emitting garbage — respawn immediately.
    // For idle/prose, only respawn after N consecutive invalid outputs so we
    // don't churn the session on benign single-batch misses.
    const mustRespawn =
      outputClass === 'poisoned' ||
      session.consecutiveInvalidOutputs >= INVALID_OUTPUT_RESPAWN_THRESHOLD;

    if (mustRespawn) {
      logger.error('SESSION', `${agentName} session poisoned — killing and respawning, pending messages preserved`, {
        sessionId: session.sessionDbId,
        outputClass,
        consecutiveInvalidOutputs: session.consecutiveInvalidOutputs,
        threshold: INVALID_OUTPUT_RESPAWN_THRESHOLD,
      });
      await sessionManager.respawnPoisonedSession(session.sessionDbId);
      return;
    }

    // Plain-text skip responses are intentionally ignored. Re-queueing them
    // creates an observer loop where the same low-signal batch is retried
    // until the restart guard fires or the provider quota is exhausted.
    await sessionManager.confirmClaimedMessages(session.sessionDbId);
    session.earliestPendingTimestamp = null;
    return;
  }

  // Valid parse — clear the invalid-output counter so transient misses don't
  // accumulate toward a respawn across a healthy session.
  session.consecutiveInvalidOutputs = 0;

  if (!session.memorySessionId) {
    logger.warn('SDK', 'memorySessionId not yet captured; deferring storage until next round', {
      sessionId: session.sessionDbId
    });
    // Reset any claimed-but-undelivered messages back to pending so they don't
    // count as "in progress" and trigger a respawn loop while we wait for the
    // memory session id to appear. The next generator pass will re-claim them.
    await sessionManager.resetProcessingToPending(session.sessionDbId);
    return;
  }

  const { observations, summary } = parsed;
  const summaryForStore = normalizeSummaryForStorage(summary);

  // Verify before persist (plan-11, #2574): the summarizer can fabricate a
  // nonexistent commit hash while keeping files_modified accurate, poisoning
  // future context injection. Cross-check any emitted commit hash against
  // ground truth via `git cat-file -e` in the session's repo and strip
  // fabricated hashes from the persisted text. projectRoot carries the cwd of
  // the most recently observed tool-use.
  if (summaryForStore) {
    const { fabricated } = verifyCommitHashesInText(
      [
        summaryForStore.request,
        summaryForStore.investigated,
        summaryForStore.learned,
        summaryForStore.completed,
        summaryForStore.next_steps,
        summaryForStore.notes,
      ],
      projectRoot,
      session.contentSessionId
    );

    if (fabricated.length > 0) {
      logger.warn('PARSER', `${agentName} summary referenced fabricated commit hash(es); flagging before persist`, {
        sessionId: session.sessionDbId,
        fabricated,
        cwd: projectRoot ?? '(none)',
      });
      stripFabricatedHashesFromSummary(summaryForStore, fabricated);
    }
  }

  const sessionStore = dbManager.getSessionStore();
  sessionStore.ensureMemorySessionIdRegistered(session.sessionDbId, session.memorySessionId, getWorkerPort());

  logger.info('DB', `STORING | sessionDbId=${session.sessionDbId} | memorySessionId=${session.memorySessionId} | obsCount=${observations.length} | hasSummary=${!!summaryForStore}`, {
    sessionId: session.sessionDbId,
    memorySessionId: session.memorySessionId
  });

  const labeledObservations = observations.map(obs => ({
    ...obs,
    agent_type: session.pendingAgentType ?? null,
    agent_id: session.pendingAgentId ?? null
  }));

  let result: ReturnType<typeof sessionStore.storeObservations>;
  try {
    result = sessionStore.storeObservations(
      session.memorySessionId,
      session.project,
      labeledObservations,
      summaryForStore,
      session.lastPromptNumber,
      discoveryTokens,
      originalTimestamp ?? undefined,
      modelId
    );
  } finally {
    session.pendingAgentId = null;
    session.pendingAgentType = null;
  }

  logger.info('DB', `STORED | sessionDbId=${session.sessionDbId} | memorySessionId=${session.memorySessionId} | obsCount=${result.observationIds.length} | obsIds=[${result.observationIds.join(',')}] | summaryId=${result.summaryId || 'none'}`, {
    sessionId: session.sessionDbId,
    memorySessionId: session.memorySessionId
  });

  session.lastSummaryStored = result.summaryId !== null;

  if (summary && (summary.skipped || session.lastSummaryStored)) {
    await ingestSummary({
      kind: 'parsed',
      sessionDbId: session.sessionDbId,
      messageId: -1,
      contentSessionId: session.contentSessionId,
      parsed: summary,
    });
  }

  await sessionManager.confirmClaimedMessages(session.sessionDbId);
  session.earliestPendingTimestamp = null;
  worker?.broadcastProcessingStatus?.();

  void notifyTelegram({
    observations: labeledObservations,
    observationIds: result.observationIds,
    project: session.project,
    memorySessionId: session.memorySessionId,
  });

  await syncAndBroadcastObservations(
    observations,
    result,
    session,
    dbManager,
    worker,
    discoveryTokens,
    agentName,
    projectRoot
  );

  await syncAndBroadcastSummary(
    summary,
    summaryForStore,
    result,
    session,
    dbManager,
    worker,
    discoveryTokens,
    agentName
  );
}

function normalizeSummaryForStorage(summary: ParsedSummary | null): {
  request: string;
  investigated: string;
  learned: string;
  completed: string;
  next_steps: string;
  notes: string | null;
} | null {
  if (!summary) return null;
  if (summary.skipped) return null;

  return {
    request: summary.request || '',
    investigated: summary.investigated || '',
    learned: summary.learned || '',
    completed: summary.completed || '',
    next_steps: summary.next_steps || '',
    notes: summary.notes
  };
}

type StorableSummary = {
  request: string;
  investigated: string;
  learned: string;
  completed: string;
  next_steps: string;
  notes: string | null;
};

/**
 * Replace each fabricated commit hash in the summary's text fields with a
 * `[unverified commit]` marker so the false claim is neither persisted nor
 * silently dropped — it is flagged in place (plan-11, #2574). Mutates in place.
 */
function stripFabricatedHashesFromSummary(summary: StorableSummary, fabricated: string[]): void {
  if (fabricated.length === 0) return;
  const replace = (value: string | null): string | null => {
    if (!value) return value;
    let next = value;
    for (const hash of fabricated) {
      // Word-boundary replace, case-insensitive: hashes were lowercased on extraction.
      next = next.replace(new RegExp(`\\b${hash}\\b`, 'gi'), '[unverified commit]');
    }
    return next;
  };
  summary.request = replace(summary.request) ?? '';
  summary.investigated = replace(summary.investigated) ?? '';
  summary.learned = replace(summary.learned) ?? '';
  summary.completed = replace(summary.completed) ?? '';
  summary.next_steps = replace(summary.next_steps) ?? '';
  summary.notes = replace(summary.notes);
}

async function syncAndBroadcastObservations(
  observations: ParsedObservation[],
  result: StorageResult,
  session: ActiveSession,
  dbManager: DatabaseManager,
  worker: WorkerRef | undefined,
  discoveryTokens: number,
  agentName: string,
  projectRoot?: string
): Promise<void> {
  // Dedupe observation IDs before sync/broadcast: storeObservations may collapse
  // multiple parsed observations onto the same row via content_hash, producing
  // duplicate IDs. Syncing them 1:1 triggers repeated Chroma "IDs already exist"
  // reconciles. See issue #2240.
  const uniqueObservationIds = [...new Set(result.observationIds)];

  for (const obsId of uniqueObservationIds) {
    const observationIndex = result.observationIds.indexOf(obsId);
    const obs = observations[observationIndex];
    if (!obs) {
      logger.warn('DB', `${agentName} storage returned observation id without matching parsed observation`, {
        sessionId: session.sessionDbId,
        obsId,
        observationIndex
      });
      continue;
    }
    const chromaStart = Date.now();

    dbManager.getChromaSync()?.syncObservation(
      obsId,
      session.contentSessionId,
      session.project,
      obs,
      session.lastPromptNumber,
      result.createdAtEpoch,
      discoveryTokens
    ).then(() => {
      const chromaDuration = Date.now() - chromaStart;
      logger.debug('CHROMA', 'Observation synced', {
        obsId,
        duration: `${chromaDuration}ms`,
        type: obs.type,
        title: obs.title || '(untitled)'
      });
    }).catch((error) => {
      logger.error('CHROMA', `${agentName} chroma sync failed, continuing without vector search`, {
        obsId,
        type: obs.type,
        title: obs.title || '(untitled)'
      }, error);
    });

    broadcastObservation(worker, {
      id: obsId,
      memory_session_id: session.memorySessionId,
      session_id: session.contentSessionId,
      platform_source: session.platformSource,
      type: obs.type,
      title: obs.title,
      subtitle: obs.subtitle,
      text: null,
      narrative: obs.narrative || null,
      facts: JSON.stringify(obs.facts || []),
      concepts: JSON.stringify(obs.concepts || []),
      files_read: JSON.stringify(obs.files_read || []),
      files_modified: JSON.stringify(obs.files_modified || []),
      project: session.project,
      prompt_number: session.lastPromptNumber,
      created_at_epoch: result.createdAtEpoch
    });
  }

  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
  const settingValue: unknown = settings.CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED;
  const folderClaudeMdEnabled = settingValue === 'true' || settingValue === true;

  if (folderClaudeMdEnabled) {
    const allFilePaths: string[] = [];
    for (const obs of observations) {
      allFilePaths.push(...(obs.files_modified || []));
      allFilePaths.push(...(obs.files_read || []));
    }

    if (allFilePaths.length > 0) {
      updateFolderClaudeMdFiles(
        allFilePaths,
        session.project,
        getWorkerPort(),
        projectRoot
      ).catch(error => {
        logger.warn('FOLDER_INDEX', 'CLAUDE.md update failed (non-critical)', { project: session.project }, error as Error);
      });
    }
  }
}

async function syncAndBroadcastSummary(
  summary: ParsedSummary | null,
  summaryForStore: { request: string; investigated: string; learned: string; completed: string; next_steps: string; notes: string | null } | null,
  result: StorageResult,
  session: ActiveSession,
  dbManager: DatabaseManager,
  worker: WorkerRef | undefined,
  discoveryTokens: number,
  agentName: string
): Promise<void> {
  if (!summaryForStore || !result.summaryId) {
    return;
  }

  const chromaStart = Date.now();

  dbManager.getChromaSync()?.syncSummary(
    result.summaryId,
    session.contentSessionId,
    session.project,
    summaryForStore,
    session.lastPromptNumber,
    result.createdAtEpoch,
    discoveryTokens
  ).then(() => {
    const chromaDuration = Date.now() - chromaStart;
    logger.debug('CHROMA', 'Summary synced', {
      summaryId: result.summaryId,
      duration: `${chromaDuration}ms`,
      request: summaryForStore.request || '(no request)'
    });
  }).catch((error) => {
    logger.error('CHROMA', `${agentName} chroma sync failed, continuing without vector search`, {
      summaryId: result.summaryId,
      request: summaryForStore.request || '(no request)'
    }, error);
  });

  broadcastSummary(worker, {
    id: result.summaryId,
    session_id: session.contentSessionId,
    platform_source: session.platformSource,
    request: summaryForStore!.request,
    investigated: summaryForStore!.investigated,
    learned: summaryForStore!.learned,
    completed: summaryForStore!.completed,
    next_steps: summaryForStore!.next_steps,
    notes: summaryForStore!.notes,
    project: session.project,
    prompt_number: session.lastPromptNumber,
    created_at_epoch: result.createdAtEpoch
  });

  updateCursorContextForProject(session.project, getWorkerPort()).catch(error => {
    logger.warn('CURSOR', 'Context update failed (non-critical)', { project: session.project }, error as Error);
  });
}
