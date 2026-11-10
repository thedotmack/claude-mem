
import { logger } from '../../../utils/logger.js';
import type { SessionManager } from '../SessionManager.js';
import type { DatabaseManager } from '../DatabaseManager.js';
import type { SessionEventBroadcaster } from '../events/SessionEventBroadcaster.js';
import { stripMemoryTags } from '../../../utils/tag-stripping.js';
import { isProjectExcluded } from '../../../utils/project-filter.js';
import { shouldSkipAgentObservation } from '../../../shared/should-skip-agent-observation.js';
import { isToolSkipped } from '../../../shared/is-tool-skipped.js';
import { SettingsDefaultsManager } from '../../../shared/SettingsDefaultsManager.js';
import { isObserverCaptureEnabled } from '../../../shared/observer-capture.js';
import { USER_SETTINGS_PATH } from '../../../shared/paths.js';
import { getProjectContext } from '../../../utils/project-name.js';
import { normalizePlatformSource } from '../../../shared/platform-source.js';
import { PrivacyCheckValidator } from '../validation/PrivacyCheckValidator.js';
import { captureEvent } from '../../telemetry/telemetry.js';
import { classifySkillId, skillNameFromToolInput } from '../../telemetry/skill-id.js';
import { isRecursiveMemoryTool, isExplicitMemoryWrite } from '../../../shared/memory-retrieval-tools.js';
import { workStateTool } from '../../../shared/work-state-telemetry.js';
import { recordWorkStateTool, isPublicWorkStateTurn } from '../../telemetry/work-state.js';
import { AGENT_LIFECYCLE_LIST, agentStopFields } from '../../work-view/agent-lifecycle.mjs';
import { committedMediaEventResult } from '../../media/linkage.js';
import { captureObservationMedia } from '../../media/capture.js';
import type { MediaEventIdentity } from '../../../shared/media-contract.js';
import type { SpooledDeliverablesPayload } from '../../../shared/hook-spool.js';
import { isInsideDeliverablesDir, resolveDeliverablesDir } from '../../../shared/deliverables.js';
import { statSync } from 'fs';
import { isExpiredObserverEvent } from '../../../shared/observer-work-policy.js';

export interface IngestContext {
  sessionManager: SessionManager;
  dbManager: DatabaseManager;
  eventBroadcaster: SessionEventBroadcaster;
  ensureGeneratorRunning?: (sessionDbId: number, source: string) => void | Promise<void>;
}

let ctx: IngestContext | null = null;

// Kimi Code's bookkeeping tools (its todo list, background-task polling and
// cron scheduling) carry no project knowledge. Several share a name with a
// Claude Code tool, so they are skipped for Kimi sessions only, not through
// the global CLAUDE_MEM_SKIP_TOOLS default.
const KIMI_BOOKKEEPING_TOOLS = new Set([
  'SetTodoList',
  'TodoList',
  'TaskList',
  'TaskOutput',
  'TaskStop',
  'CronCreate',
  'CronList',
  'CronDelete',
]);

// Compile each CLAUDE_MEM_SKIP_BASH_PATTERNS value once, not per observation:
// ingestObservation runs on the hot path. A cached `null` marks a value that
// failed to compile, so an invalid regex warns once instead of on every Bash
// command until the setting is fixed.
const bashPatternCache = new Map<string, RegExp | null>();

function getBashSkipPattern(pattern: string): RegExp | null {
  const cached = bashPatternCache.get(pattern);
  if (cached !== undefined) return cached;

  let compiled: RegExp | null = null;
  try {
    compiled = new RegExp(pattern);
  } catch (error) {
    logger.warn('INGEST', 'Invalid CLAUDE_MEM_SKIP_BASH_PATTERNS regex — ignoring', {
      pattern,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  bashPatternCache.set(pattern, compiled);
  return compiled;
}

// The shell command CLAUDE_MEM_SKIP_BASH_PATTERNS is matched against. Claude
// Code sends `Bash` + `command` (Cursor and Windsurf adapters normalize to the
// same shape); the Codex transcript watcher sends `exec_command` + `cmd`; on
// Windows the primary shell arrives as `PowerShell` + `command` (issue #4745 —
// without this branch the setting silently did nothing there).
function shellCommandOf(toolName: string, toolInput: unknown): string {
  if (!toolInput || typeof toolInput !== 'object') return '';
  const input = toolInput as { command?: unknown; cmd?: unknown };
  const command =
    toolName === 'Bash' || toolName === 'PowerShell' ? input.command
    : toolName === 'exec_command' ? input.cmd
    : undefined;
  return typeof command === 'string' ? command : '';
}

export function setIngestContext(next: IngestContext): void {
  ctx = next;
}

export function attachIngestGeneratorStarter(
  ensureGeneratorRunning: (sessionDbId: number, source: string) => void | Promise<void>,
): void {
  const context = requireIngestContext();
  context.ensureGeneratorRunning = ensureGeneratorRunning;
  context.sessionManager.setGeneratorStarter?.(ensureGeneratorRunning);
}

export function requireIngestContext(): IngestContext {
  if (!ctx) {
    throw new Error('ingest helpers used before setIngestContext() — wiring bug');
  }
  return ctx;
}

/**
 * Durable callers (the hook spool drain) pass `markHandedOff`: ingest calls it
 * synchronously the moment the request is irrevocably accepted — enqueued in
 * the SessionManager or recorded in the DB — and before any async
 * provider-bound work (ensureGeneratorRunning). Never called when ingest
 * declines, skips, or throws first, so the caller retries exactly those.
 * HTTP routes omit it.
 */
export interface IngestHandoff {
  markHandedOff?: () => void;
}

export type IngestResult =
  | { ok: true; sessionDbId: number; messageId?: number }
  | { ok: true; status: 'skipped'; reason: string }
  | { ok: false; reason: string; status?: number };

/**
 * A skip because the user deleted the session is logged with its reason,
 * never silent: what was kept out, and why it could not be new work.
 */
export function logDeletedSessionSkip(
  what: string,
  why: 'not_newer_than_deletion' | 'session_not_recaptured',
  platformSource: string,
  contentSessionId: string,
  detail: Record<string, unknown> = {},
): void {
  logger.info('INGEST', `Skipped ${what}: its session was deleted (${why})`, {
    reason: 'session_deleted', why, platformSource, contentSessionId, ...detail,
  });
}

export interface ObservationPayload {
  contentSessionId: string;
  toolName: string;
  toolInput?: unknown;
  toolResponse?: unknown;
  cwd?: string;
  platformSource?: string;
  telemetryPlatformSource?: string;
  /** Direct live callbacks retain their original time without changing memory prompt lookup. */
  telemetryToolEpochMs?: number;
  agentId?: string;
  agentType?: string;
  toolUseId?: string;
  mediaEventIdentity?: MediaEventIdentity;
  /**
   * Receipt join keys (frozen 2026-09-06). Both nullable and both pass-through:
   * Claude-Mem never derives them, it only echoes what a stamper supplied, so
   * `tool_uses` can be joined to an OpenRouter spend line. No cost field here —
   * dollars stay on the OR stamp / spend log.
   */
  orGenerationId?: string;
  orSessionId?: string;
  /**
   * When the hook saw the event (hook spool entries only). A spooled event can
   * be ingested long after it happened; its prompt number is the prompt that
   * was current then, not at drain time. HTTP callers omit it (= now).
   */
  enqueuedAtEpochMs?: number;
  /**
   * When the tool use happened at its source: the hook's clock, or the
   * transcript line's own timestamp (null when the line carries none). Only
   * this proves an event in a deleted session is new work after the deletion
   * (SessionStore.isBeforeSessionDeletion); arrival time does not, since a
   * transcript re-read arrives now too.
   */
  eventOccurredAtEpochMs?: number | null;
}

export async function ingestObservation(payload: ObservationPayload, handoff: IngestHandoff = {}): Promise<IngestResult> {
  if (isRecursiveMemoryTool(payload.toolName)) {
    return { ok: true, status: 'skipped', reason: 'memory_retrieval' };
  }
  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
  if (!isObserverCaptureEnabled(settings)) {
    return { ok: true, status: 'skipped', reason: 'observer_disabled' };
  }
  const { sessionManager, dbManager, eventBroadcaster, ensureGeneratorRunning } = requireIngestContext();

  const platformSource = normalizePlatformSource(payload.platformSource);
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : '';
  const projectContext = cwd.trim() ? getProjectContext(cwd) : null;
  // Same fallback as session init: an empty project makes cloud sync quarantine
  // every content line the session produces (#4772).
  const project = projectContext?.primary || 'unknown';

  if (cwd && isProjectExcluded(cwd, settings.CLAUDE_MEM_EXCLUDED_PROJECTS)) {
    return { ok: true, status: 'skipped', reason: 'project_excluded' };
  }

  // Native todo tools are normally excluded from memory generation. Count
  // their bounded identity before that filter, but after project, agent and
  // prompt privacy checks. Do not store their contents or buy an observation.
  const trackedTool = workStateTool(payload.toolName);
  const telemetryAttribution = {
    ...payload,
    platformSource: payload.telemetryPlatformSource ?? payload.platformSource,
    enqueuedAtEpochMs: payload.telemetryToolEpochMs ?? payload.enqueuedAtEpochMs,
  };
  if (trackedTool && !shouldSkipAgentObservation(payload.agentId, payload.agentType, settings).skip) {
    try {
      const telemetryStore = dbManager.getSessionStore();
      const knownSession = telemetryStore.findSessionDbIdByContentSessionId(payload.contentSessionId, platformSource);
      const promptNumber = telemetryStore.getPromptNumberFromUserPrompts(payload.contentSessionId, knownSession ?? undefined, payload.enqueuedAtEpochMs);
      // Missing prompt capture is not evidence that this turn is public.
      const publicPrompt = knownSession === null ? null
        : telemetryStore.getUserPrompt(payload.contentSessionId, promptNumber, knownSession);
      if (publicPrompt?.trim() && isPublicWorkStateTurn(telemetryStore.db, telemetryAttribution)) {
        recordWorkStateTool(telemetryStore.db, telemetryAttribution, payload.toolUseId, payload.toolName, payload.toolResponse);
      }
    } catch { /* A telemetry lookup must not turn a skipped tool into an error. */ }
  }

  if (isToolSkipped(payload.toolName, settings.CLAUDE_MEM_SKIP_TOOLS)) {
    if (payload.toolName === 'Skill') {
      const { skill_id, skill_source } = classifySkillId(
        skillNameFromToolInput(payload.toolName, payload.toolInput),
      );
      captureEvent('skill_invoked', {
        skill_id,
        skill_source,
        skill_trigger: 'tool',
        ide: platformSource,
      });
    }
    return { ok: true, status: 'skipped', reason: 'tool_excluded' };
  }
  if (platformSource === 'kimi' && KIMI_BOOKKEEPING_TOOLS.has(payload.toolName)) {
    return { ok: true, status: 'skipped', reason: 'tool_excluded' };
  }

  const skipBashPatterns = settings.CLAUDE_MEM_SKIP_BASH_PATTERNS.trim();
  const command = skipBashPatterns ? shellCommandOf(payload.toolName, payload.toolInput) : '';
  if (command) {
    // A bad user regex never throws here — getBashSkipPattern returns null, so the
    // command is captured as if no pattern was set.
    const pattern = getBashSkipPattern(skipBashPatterns);
    if (pattern && pattern.test(command)) {
      return { ok: true, status: 'skipped', reason: 'bash_pattern_excluded' };
    }
  }

  // #2736 — defense in depth: the hook handler already filters subagent
  // observations before this HTTP call, but skip again here so any non-hook
  // caller (direct API, future ingestion paths) is filtered before the
  // queueObservation → provider request below.
  const agentSkip = shouldSkipAgentObservation(payload.agentId, payload.agentType, settings);
  if (agentSkip.skip) {
    return { ok: true, status: 'skipped', reason: agentSkip.reason };
  }

  const fileOperationTools = new Set(['Edit', 'Write', 'Read', 'NotebookEdit']);
  if (fileOperationTools.has(payload.toolName) && payload.toolInput && typeof payload.toolInput === 'object') {
    const input = payload.toolInput as { file_path?: string; notebook_path?: string };
    const filePath = input.file_path || input.notebook_path;
    if (filePath && filePath.includes('session-memory')) {
      return { ok: true, status: 'skipped', reason: 'session_memory_meta' };
    }
  }

  const store = dbManager.getSessionStore();

  let sessionDbId: number;
  let promptNumber: number;
  try {
    sessionDbId = store.createSDKSession(payload.contentSessionId, project, '', undefined, platformSource, payload.eventOccurredAtEpochMs);
    if (cwd) store.setSessionCwd(sessionDbId, cwd, projectContext?.keySource);
    promptNumber = store.getPromptNumberFromUserPrompts(payload.contentSessionId, sessionDbId, payload.enqueuedAtEpochMs);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === 'session_deleted') {
      logDeletedSessionSkip('a tool use', 'not_newer_than_deletion', platformSource, payload.contentSessionId, {
        toolName: payload.toolName, toolUseId: payload.toolUseId, eventOccurredAtEpochMs: payload.eventOccurredAtEpochMs ?? null,
      });
      return { ok: true, status: 'skipped', reason: 'session_deleted' };
    }
    logger.error('INGEST', 'Observation session resolution failed', {
      contentSessionId: payload.contentSessionId,
      toolName: payload.toolName,
    }, error instanceof Error ? error : new Error(message));
    return { ok: false, reason: message, status: 500 };
  }

  const privacy = PrivacyCheckValidator.checkUserPromptPrivacy(
    store,
    payload.contentSessionId,
    promptNumber,
    'observation',
    sessionDbId,
    { tool_name: payload.toolName }
  );
  if (!privacy.allow) {
    return { ok: true, status: 'skipped', reason: 'private' };
  }

  if (!trackedTool && privacy.prompt.trim() && isPublicWorkStateTurn(store.db, telemetryAttribution)) {
    recordWorkStateTool(store.db, telemetryAttribution, payload.toolUseId, payload.toolName, payload.toolResponse);
  }

  // Media capture runs only after every tracking/privacy/subagent gate above
  // and before serialization, so neither the tool_uses backup nor the RAM
  // observer text ever holds a recognized image body. Capture is on by
  // default ("Keep images"); disabled capture still replaces bodies with bounded descriptors.
  // Media inference is a separate flag and is not consulted here.
  const mediaCaptureEnabled = settings.CLAUDE_MEM_MEDIA_CAPTURE_ENABLED === 'true';
  const media = await captureObservationMedia({
    enabled: mediaCaptureEnabled,
    sessionDbId,
    contentSessionId: payload.contentSessionId,
    platformSource,
    toolUseId: payload.toolUseId,
    eventIdentity: payload.mediaEventIdentity,
    toolName: payload.toolName,
    toolInput: payload.toolInput,
    toolResponse: payload.toolResponse,
    cwd,
  }, mediaCaptureEnabled ? () => dbManager.getMediaStore() : undefined);
  // Explicit DELETE may commit while media conversion yields. Do not restore
  // its raw tool-use side index or put the stale observation into RAM.
  if (store.isBeforeSessionDeletion(platformSource, payload.contentSessionId, payload.eventOccurredAtEpochMs)) {
    logDeletedSessionSkip('a tool use (deleted during media capture)', 'not_newer_than_deletion', platformSource, payload.contentSessionId, {
      toolName: payload.toolName, toolUseId: payload.toolUseId, eventOccurredAtEpochMs: payload.eventOccurredAtEpochMs ?? null,
    });
    return { ok: true, status: 'skipped', reason: 'session_deleted' };
  }
  const cleanedToolInput = media.toolInput !== undefined
    ? stripMemoryTags(JSON.stringify(media.toolInput))
    : '{}';
  const cleanedToolResponse = media.toolResponse !== undefined
    ? stripMemoryTags(JSON.stringify(media.toolResponse))
    : '{}';

  // Dual-write: the durable `tool_uses` side index (v51) alongside — never
  // instead of — the pending_messages → generator queue below. This is the one
  // choke point both the PostToolUse hook route and the transcript-watch
  // processor already funnel through, so the JSONL spine keeps its own path and
  // no second capture surface exists to drift.
  //
  // Best-effort by construction: an observation must still be generated if the
  // backup index write fails, so a throw here is logged and swallowed. Rows
  // without a tool_use_id are skipped by upsertToolUse (nothing to de-dupe on).
  if (payload.toolUseId) {
    try {
      store.upsertToolUse({
        toolUseId: payload.toolUseId,
        contentSessionId: payload.contentSessionId,
        sessionDbId,
        project,
        platformSource,
        toolName: payload.toolName,
        toolInput: cleanedToolInput,
        toolResponse: cleanedToolResponse,
        cwd: cwd || null,
        promptNumber,
        agentType: typeof payload.agentType === 'string' ? payload.agentType : null,
        agentId: typeof payload.agentId === 'string' ? payload.agentId : null,
        orGenerationId: typeof payload.orGenerationId === 'string' ? payload.orGenerationId : null,
        orSessionId: typeof payload.orSessionId === 'string' ? payload.orSessionId : null,
      });
    } catch (error) {
      // A concurrent SQLite connection can delete the session after the
      // post-capture check. The write trigger closes that final DB race.
      if (error instanceof Error && error.message === 'session_deleted') {
        logDeletedSessionSkip('a tool use (deleted before its raw backup write)', 'not_newer_than_deletion', platformSource, payload.contentSessionId, {
          toolName: payload.toolName, toolUseId: payload.toolUseId, eventOccurredAtEpochMs: payload.eventOccurredAtEpochMs ?? null,
        });
        return { ok: true, status: 'skipped', reason: 'session_deleted' };
      }
      logger.warn('INGEST', 'tool_uses backup write failed (observation still queued)', {
        sessionId: sessionDbId,
        toolName: payload.toolName,
        toolUseId: payload.toolUseId,
      }, error instanceof Error ? error : new Error(String(error)));
    }
  }

  if (isExplicitMemoryWrite(payload.toolName)) {
    // The explicit note is already stored. Its raw receipt above is useful,
    // but observing the echo would duplicate it and buy another provider call.
    return { ok: true, status: 'skipped', reason: 'explicit_memory_write' };
  }

  // Keep the raw side-index upsert above even on a replay: it may add a late
  // tool response. A terminal result marker, unlike that pre-commit raw row,
  // proves the observer result was stored before the worker buffer disappeared.
  if (payload.toolUseId) {
    try {
      if (store.hasCommittedToolUse(platformSource, payload.contentSessionId, payload.toolUseId)) {
        return { ok: true, status: 'skipped', reason: 'already_processed' };
      }
    } catch (error) {
      // A failed lookup cannot tell a replay from new work. Fail toward no
      // spend: a DB fault must never turn a replay into unrequested paid work.
      logger.error('INGEST', 'Committed tool-use lookup failed; observation skipped, not queued', {
        sessionId: sessionDbId,
        toolName: payload.toolName,
      }, error instanceof Error ? error : new Error(String(error)));
      return { ok: true, status: 'skipped', reason: 'committed_lookup_failed' };
    }
  }

  // Replay recovery: a source event whose text outcome, observation rows and
  // image links already committed (media_events.result_state) is never sent
  // to the observer again; the links landed with that commit.
  if (media.eventKey) {
    const committed = committedMediaEventResult(store.db, media.eventKey);
    if (committed) {
      logger.debug('INGEST', 'Replayed media event already has a committed result; not re-queued', {
        sessionId: sessionDbId,
        resultState: committed.resultState,
        observations: committed.observationIds.length,
      });
      return { ok: true, status: 'skipped', reason: 'already_processed' };
    }
  }

  if (payload.enqueuedAtEpochMs !== undefined && isExpiredObserverEvent(payload.enqueuedAtEpochMs)) {
    return { ok: true, status: 'skipped', reason: 'expired_live_capture' };
  }
  const queuedMessageId = sessionManager.queueObservation(sessionDbId, {
    tool_name: payload.toolName,
    tool_input: cleanedToolInput,
    tool_response: cleanedToolResponse,
    prompt_number: promptNumber,
    cwd: cwd || (() => {
      // A host with no checkout (ODS, other HTTP hosts) names its project at
      // session init and never sends a cwd; that is expected. Without a
      // project from init, a missing cwd is a capture fault.
      const sessionProject = store.getSessionById(sessionDbId)?.project;
      const hostHasNoCheckout = !!sessionProject && sessionProject !== 'unknown';
      const log = hostHasNoCheckout ? logger.debug : logger.error;
      log.call(logger, 'INGEST', 'Missing cwd when ingesting observation', {
        sessionId: sessionDbId,
        toolName: payload.toolName,
        project: sessionProject,
      });
      return '';
    })(),
    agentId: typeof payload.agentId === 'string' ? payload.agentId : undefined,
    agentType: typeof payload.agentType === 'string' ? payload.agentType : undefined,
    toolUseId: typeof payload.toolUseId === 'string' ? payload.toolUseId : undefined,
    ...(media.refs.length ? { mediaRefs: media.refs, mediaEventKey: media.eventKey } : {}),
    ...(media.failures.length ? { mediaFailures: media.failures } : {}),
  }, payload.enqueuedAtEpochMs);
  if (queuedMessageId === 0) return { ok: true, status: 'skipped', reason: 'duplicate_or_live_buffer_limit' };
  // Enqueued: the hand-off point. Synchronously, before the generator kick.
  handoff.markHandedOff?.();

  await ensureGeneratorRunning?.(sessionDbId, 'observation');
  eventBroadcaster.broadcastObservationQueued(sessionDbId);

  return { ok: true, sessionDbId };
}


/**
 * Outcome of the session-scoped ingests (summarize, session end). `unknown_session`
 * is distinct from `skipped`: the session's init may simply not have landed yet,
 * so a durable caller (the hook spool drain) keeps the request and retries.
 */
export type SessionIngestOutcome =
  | { status: 'accepted' }
  | { status: 'skipped'; reason: string }
  | { status: 'unknown_session' };

export interface SummarizePayload {
  contentSessionId: string;
  /** Already normalized (normalizePlatformSource). */
  platformSource: string;
  lastAssistantMessage?: string;
  agentId?: string;
  observedModel?: string;
  observedBilling?: string;
  /** The checkout, from hosts that cannot check exclusions themselves. */
  cwd?: string;
  /** When the hook saw the Stop (hook spool entries only); see ObservationPayload. */
  enqueuedAtEpochMs?: number;
}

export async function ingestSummarize(
  payload: SummarizePayload,
  deps: IngestContext = requireIngestContext(),
  handoff: IngestHandoff = {},
): Promise<SessionIngestOutcome> {
  const { sessionManager, dbManager, eventBroadcaster, ensureGeneratorRunning } = deps;
  const { contentSessionId, platformSource, observedModel, observedBilling } = payload;

  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
  if (!isObserverCaptureEnabled(settings)) {
    return { status: 'skipped', reason: 'observer_disabled' };
  }

  if (payload.agentId) {
    return { status: 'skipped', reason: 'subagent_context' };
  }

  const store = dbManager.getSessionStore();

  // Summarize only a session the worker knows. Creating a row here gave every
  // idle turn of a session nothing else recorded (an excluded checkout, a
  // skipped init) an empty-project row and a paid observer call (R5-1).
  // A deleted session has a row again only once new work recreated it.
  const sessionDbId = store.findSessionDbIdByContentSessionId(contentSessionId, platformSource);
  if (sessionDbId === null) {
    if (store.isSessionDeleted(platformSource, contentSessionId)) {
      logDeletedSessionSkip('a summary request', 'session_not_recaptured', platformSource, contentSessionId);
      return { status: 'skipped', reason: 'session_deleted' };
    }
    return { status: 'unknown_session' };
  }

  // An excluded checkout is never summarized, even one excluded after its
  // session began (R5-1). A host that cannot check the user's exclusions
  // itself sends its checkout; without one, the checkout the session was
  // recorded in is checked.
  const requestCwd = typeof payload.cwd === 'string' ? payload.cwd.trim() : '';
  const checkoutCwd = requestCwd || store.getSessionCwd(sessionDbId);
  if (checkoutCwd) {
    if (isProjectExcluded(checkoutCwd, settings.CLAUDE_MEM_EXCLUDED_PROJECTS)) {
      return { status: 'skipped', reason: 'project_excluded' };
    }
  }

  if (observedModel || observedBilling) {
    store.setSessionObservedMetadata(sessionDbId, observedModel, observedBilling);
    const active = sessionManager.getSession(sessionDbId);
    if (active) {
      if (observedModel) active.observedModel = observedModel;
      if (observedBilling) active.observedBilling = observedBilling;
    }
  }

  const promptNumber = store.getPromptNumberFromUserPrompts(contentSessionId, sessionDbId, payload.enqueuedAtEpochMs);

  const privacy = PrivacyCheckValidator.checkUserPromptPrivacy(
    store,
    contentSessionId,
    promptNumber,
    'summarize',
    sessionDbId
  );
  if (!privacy.allow) {
    return { status: 'skipped', reason: 'private' };
  }

  const cleanedLastAssistantMessage = payload.lastAssistantMessage
    ? stripMemoryTags(String(payload.lastAssistantMessage))
    : payload.lastAssistantMessage;
  if (payload.enqueuedAtEpochMs !== undefined && isExpiredObserverEvent(payload.enqueuedAtEpochMs)) {
    return { status: 'skipped', reason: 'expired_live_capture' };
  }
  const queuedMessageId = sessionManager.queueSummarize(sessionDbId, cleanedLastAssistantMessage, promptNumber, payload.enqueuedAtEpochMs);
  if (queuedMessageId === 0) return { status: 'skipped', reason: 'live_buffer_limit' };
  // Enqueued: the hand-off point. Synchronously, before the generator kick.
  handoff.markHandedOff?.();

  await ensureGeneratorRunning?.(sessionDbId, 'summarize');

  eventBroadcaster.broadcastSummarizeQueued();

  return { status: 'accepted' };
}

export interface SessionEndPayload {
  contentSessionId: string;
  /** Already normalized (normalizePlatformSource). */
  platformSource: string;
}

export interface DeliverablesIngestResult {
  status: 'accepted' | 'skipped';
  reason?: 'project_excluded' | 'private' | 'session_deleted';
  stored: number;
  duplicates: number;
  /** Copies this worker cannot open (not a file on its disk inside the deliverables directory): logged, not recorded. */
  unavailable: number;
}

function isRegularFile(path: string): boolean {
  try { return statSync(path).isFile(); } catch { return false; }
}

/**
 * Records the bucket copies a Stop (or SubagentStop) hook made
 * (src/cli/deliverables-capture.ts). The files are already in the bucket; this
 * only writes the rows My Work links, and only for copies on this worker's own
 * disk: a hook on another host names paths this worker cannot open, and a row
 * for one would be a link that never works. A turn whose prompt was entirely
 * <private> records nothing, the rule observations and summaries follow; the
 * hook checks that before copying, this guards every other caller. A copy the
 * hook could not make is logged here too, so a missing deliverable is explained
 * in the worker log.
 */
export function ingestDeliverables(
  payload: SpooledDeliverablesPayload & { enqueuedAtEpochMs?: number },
  dbManager: DatabaseManager = requireIngestContext().dbManager,
  handoff: IngestHandoff = {},
): DeliverablesIngestResult {
  const { contentSessionId, cwd, project, agentId, files, errors } = payload;
  const platformSource = normalizePlatformSource(payload.platformSource);
  const nothing = { stored: 0, duplicates: 0, unavailable: 0 };

  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
  if (cwd && isProjectExcluded(cwd, settings.CLAUDE_MEM_EXCLUDED_PROJECTS)) {
    return { status: 'skipped', reason: 'project_excluded', ...nothing };
  }
  for (const failure of errors ?? []) {
    logger.warn('HOOK', 'A deliverable was not copied into the project bucket', { project, sourcePath: failure.sourcePath, error: failure.error });
  }

  const store = dbManager.getSessionStore();
  const sessionDbId = store.findSessionDbIdByContentSessionId(contentSessionId, platformSource);
  const sessionDeleted = store.isSessionDeleted(platformSource, contentSessionId);
  if (sessionDeleted && sessionDbId === null) {
    logDeletedSessionSkip('a deliverables record', 'session_not_recaptured', platformSource, contentSessionId, { files: files.length });
    return { status: 'skipped', reason: 'session_deleted', ...nothing };
  }
  if (sessionDbId !== null) {
    const promptNumber = store.getPromptNumberFromUserPrompts(contentSessionId, sessionDbId, payload.enqueuedAtEpochMs);
    const privacy = PrivacyCheckValidator.checkUserPromptPrivacy(store, contentSessionId, promptNumber, 'deliverables', sessionDbId);
    if (!privacy.allow) {
      return { status: 'skipped', reason: 'private', ...nothing };
    }
  }

  const deliverablesDir = resolveDeliverablesDir();
  let stored = 0;
  let duplicates = 0;
  let unavailable = 0;
  let beforeDeletion = 0;
  for (const file of files) {
    // A recreated session takes only deliverables made after the deletion.
    if (sessionDeleted && store.isBeforeSessionDeletion(platformSource, contentSessionId, file.occurredAtEpoch)) {
      beforeDeletion++;
      continue;
    }
    if (!isInsideDeliverablesDir(file.bucketPath, deliverablesDir) || !isRegularFile(file.bucketPath)) {
      unavailable++;
      logger.warn('HOOK', 'A deliverable names a bucket copy this worker cannot open; not recorded', { project, bucketPath: file.bucketPath, sourcePath: file.sourcePath, deliverablesDir });
      continue;
    }
    const result = store.recordDeliverable({
      project,
      contentSessionId,
      platformSource,
      agentId: agentId ?? null,
      title: file.title,
      kind: file.kind,
      sourcePath: file.sourcePath,
      bucketPath: file.bucketPath,
      bytes: file.bytes,
      sha256: file.sha256,
      declared: file.declared,
      listName: file.list ?? null,
      field: file.field ?? null,
      toolUseId: file.toolUseId ?? null,
      occurredAtEpoch: file.occurredAtEpoch,
      createdAtEpoch: payload.enqueuedAtEpochMs,
    });
    if (result.inserted) stored++;
    else duplicates++;
  }
  if (beforeDeletion > 0) {
    logDeletedSessionSkip(`${beforeDeletion} deliverable(s)`, 'not_newer_than_deletion', platformSource, contentSessionId);
  }
  // Every row is written: the hand-off point.
  handoff.markHandedOff?.();
  logger.info('HOOK', 'Deliverables recorded', { project, stored, duplicates, unavailable });
  return { status: 'accepted', stored, duplicates, unavailable };
}

export async function ingestSessionEnd(
  payload: SessionEndPayload,
  deps: Pick<IngestContext, 'sessionManager' | 'dbManager'> = requireIngestContext(),
  handoff: IngestHandoff = {},
): Promise<SessionIngestOutcome> {
  const store = deps.dbManager.getSessionStore();
  const sessionDbId = store.findSessionDbIdByContentSessionId(payload.contentSessionId, payload.platformSource);
  if (sessionDbId === null) {
    if (store.isSessionDeleted(payload.platformSource, payload.contentSessionId)) {
      logDeletedSessionSkip('a session end', 'session_not_recaptured', payload.platformSource, payload.contentSessionId);
      return { status: 'skipped', reason: 'session_deleted' };
    }
    return { status: 'unknown_session' };
  }

  await deps.sessionManager.requestSessionWrapup(sessionDbId);
  // Wrap-up requested (no provider-bound work follows here).
  handoff.markHandedOff?.();
  return { status: 'accepted' };
}

export interface AdvisorCallsPayload {
  contentSessionId: string;
  /** Already normalized (normalizePlatformSource). */
  platformSource: string;
  cwd?: string;
  transcriptPath?: string;
  calls: Array<{
    toolUseId: string;
    advice: string;
    advisorModel?: string | null;
    occurredAtEpoch: number;
    lastUserMessage?: string | null;
    transcriptByteOffset?: number | null;
  }>;
}

export type AdvisorCallsIngestResult =
  | { status: 'skipped'; reason: string }
  | { status: 'stored'; stored: number; duplicates: number; privateOnly: number };

export function ingestAdvisorCalls(
  payload: AdvisorCallsPayload,
  dbManager: DatabaseManager = requireIngestContext().dbManager,
  handoff: IngestHandoff = {},
): AdvisorCallsIngestResult {
  const { contentSessionId, platformSource, cwd, transcriptPath, calls } = payload;

  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
  if (cwd && isProjectExcluded(cwd, settings.CLAUDE_MEM_EXCLUDED_PROJECTS)) {
    return { status: 'skipped', reason: 'project_excluded' };
  }

  // Same fallback as session init — an empty project gets quarantined by cloud sync (#4772).
  const project = typeof cwd === 'string' && cwd.trim() ? getProjectContext(cwd).primary : 'unknown';

  const store = dbManager.getSessionStore();
  // Advice given before the user deleted the session stays out; advice from
  // new work in the same conversation is recorded.
  const liveCalls = calls.filter(call => !store.isBeforeSessionDeletion(platformSource, contentSessionId, call.occurredAtEpoch));
  if (liveCalls.length < calls.length) {
    logDeletedSessionSkip(`${calls.length - liveCalls.length} advisor call(s)`, 'not_newer_than_deletion', platformSource, contentSessionId);
    if (liveCalls.length === 0) return { status: 'skipped', reason: 'session_deleted' };
  }
  let sessionDbId: number;
  try {
    sessionDbId = store.createSDKSession(contentSessionId, project, '', undefined, platformSource,
      liveCalls.length > 0 ? Math.max(...liveCalls.map(call => call.occurredAtEpoch)) : undefined);
  } catch (error) {
    if (error instanceof Error && error.message === 'session_deleted') {
      logDeletedSessionSkip('advisor calls (deleted while recording)', 'not_newer_than_deletion', platformSource, contentSessionId);
      return { status: 'skipped', reason: 'session_deleted' };
    }
    throw error;
  }

  let stored = 0;
  let duplicates = 0;
  let privateOnly = 0;
  for (const call of liveCalls) {
    // <private> content never reaches the database, the same rule as
    // prompts and tool payloads. Advice that was entirely private is dropped.
    const advice = stripMemoryTags(call.advice).trim();
    if (!advice) {
      privateOnly++;
      continue;
    }
    const lastUserMessage = call.lastUserMessage ? stripMemoryTags(call.lastUserMessage).trim() || null : null;

    const result = store.recordAdvisorCall({
      sessionDbId,
      contentSessionId,
      project,
      platformSource,
      toolUseId: call.toolUseId,
      advisorModel: call.advisorModel ?? null,
      cwd: cwd ?? null,
      lastUserMessage,
      transcriptPath: transcriptPath ?? null,
      transcriptByteOffset: call.transcriptByteOffset ?? null,
      advice,
      occurredAtEpoch: call.occurredAtEpoch,
    });

    if (result.inserted) {
      stored++;
    } else {
      duplicates++;
    }
  }

  // Every call is recorded (synchronous bun:sqlite writes): the hand-off point.
  handoff.markHandedOff?.();
  logger.debug('WORKER', 'Advisor calls ingested', { contentSessionId, stored, duplicates, privateOnly });
  return { status: 'stored', stored, duplicates, privateOnly };
}

export interface SubagentStopPayload {
  contentSessionId: string;
  platformSource: string;
  agentId: string;
  agentType?: string;
  cwd?: string;
  stoppedAtEpoch: number;
}

/**
 * Claude Code's SubagentStop: save one closed "agent-lifecycle" work-state row
 * saying this subagent stopped at the hook's time. My Work reads it as the
 * subagent's finish; a later tool call or observation from the same agent
 * means it resumed.
 */
export function ingestSubagentStop(
  payload: SubagentStopPayload,
  handoff: IngestHandoff = {},
  dbManager: DatabaseManager = requireIngestContext().dbManager,
): { status: 'stored'; entryId: number } | { status: 'skipped'; reason: string } {
  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
  if (payload.cwd && isProjectExcluded(payload.cwd, settings.CLAUDE_MEM_EXCLUDED_PROJECTS)) {
    return { status: 'skipped', reason: 'project_excluded' };
  }
  const project = typeof payload.cwd === 'string' && payload.cwd.trim() ? getProjectContext(payload.cwd).primary : 'unknown';
  const store = dbManager.getSessionStore();
  if (store.isSessionDeleted(payload.platformSource, payload.contentSessionId)
    && store.findSessionDbIdByContentSessionId(payload.contentSessionId, payload.platformSource) === null) {
    logDeletedSessionSkip('a subagent stop', 'session_not_recaptured', payload.platformSource, payload.contentSessionId);
    return { status: 'skipped', reason: 'session_deleted' };
  }
  const fields = agentStopFields({
    platformSource: normalizePlatformSource(payload.platformSource),
    contentSessionId: payload.contentSessionId,
    agentId: payload.agentId,
    agentType: payload.agentType ?? null,
    stoppedAtEpoch: payload.stoppedAtEpoch,
    stopSource: 'subagent-stop-hook',
  });
  const entryId = dbManager.getSessionStore().appendWorkStateEntry({
    project, listName: AGENT_LIFECYCLE_LIST, fields, createdAtEpoch: payload.stoppedAtEpoch,
  });
  handoff.markHandedOff?.();
  return { status: 'stored', entryId };
}
