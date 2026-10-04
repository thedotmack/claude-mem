
import { logger } from '../../../utils/logger.js';
import type { SessionManager } from '../SessionManager.js';
import type { DatabaseManager } from '../DatabaseManager.js';
import type { SessionEventBroadcaster } from '../events/SessionEventBroadcaster.js';
import { stripMemoryTags } from '../../../utils/tag-stripping.js';
import { isProjectExcluded } from '../../../utils/project-filter.js';
import { shouldSkipAgentObservation } from '../../../shared/should-skip-agent-observation.js';
import { SettingsDefaultsManager } from '../../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../../shared/paths.js';
import { getProjectContext } from '../../../utils/project-name.js';
import { normalizePlatformSource } from '../../../shared/platform-source.js';
import { PrivacyCheckValidator } from '../validation/PrivacyCheckValidator.js';
import { captureEvent } from '../../telemetry/telemetry.js';
import { classifySkillId, skillNameFromToolInput } from '../../telemetry/skill-id.js';

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
// same shape); the Codex transcript watcher sends `exec_command` + `cmd`.
function shellCommandOf(toolName: string, toolInput: unknown): string {
  if (!toolInput || typeof toolInput !== 'object') return '';
  const input = toolInput as { command?: unknown; cmd?: unknown };
  const command = toolName === 'Bash' ? input.command : toolName === 'exec_command' ? input.cmd : undefined;
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

export interface ObservationPayload {
  contentSessionId: string;
  toolName: string;
  toolInput: unknown;
  toolResponse: unknown;
  cwd?: string;
  platformSource?: string;
  agentId?: string;
  agentType?: string;
  toolUseId?: string;
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
}

export async function ingestObservation(payload: ObservationPayload, handoff: IngestHandoff = {}): Promise<IngestResult> {
  const { sessionManager, dbManager, eventBroadcaster, ensureGeneratorRunning } = requireIngestContext();

  const platformSource = normalizePlatformSource(payload.platformSource);
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : '';
  const projectContext = cwd.trim() ? getProjectContext(cwd) : null;
  const project = projectContext?.primary ?? '';

  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);

  if (cwd && isProjectExcluded(cwd, settings.CLAUDE_MEM_EXCLUDED_PROJECTS)) {
    return { ok: true, status: 'skipped', reason: 'project_excluded' };
  }

  const skipTools = new Set(
    settings.CLAUDE_MEM_SKIP_TOOLS.split(',').map(t => t.trim()).filter(Boolean)
  );
  if (skipTools.has(payload.toolName)) {
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
    sessionDbId = store.createSDKSession(payload.contentSessionId, project, '', undefined, platformSource);
    if (cwd) store.setSessionCwd(sessionDbId, cwd, projectContext?.keySource);
    promptNumber = store.getPromptNumberFromUserPrompts(payload.contentSessionId, sessionDbId, payload.enqueuedAtEpochMs);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
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

  const cleanedToolInput = payload.toolInput !== undefined
    ? stripMemoryTags(JSON.stringify(payload.toolInput))
    : '{}';
  const cleanedToolResponse = payload.toolResponse !== undefined
    ? stripMemoryTags(JSON.stringify(payload.toolResponse))
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
      logger.warn('INGEST', 'tool_uses backup write failed (observation still queued)', {
        sessionId: sessionDbId,
        toolName: payload.toolName,
        toolUseId: payload.toolUseId,
      }, error instanceof Error ? error : new Error(String(error)));
    }
  }

  sessionManager.queueObservation(sessionDbId, {
    tool_name: payload.toolName,
    tool_input: cleanedToolInput,
    tool_response: cleanedToolResponse,
    prompt_number: promptNumber,
    cwd: cwd || (() => {
      logger.error('INGEST', 'Missing cwd when ingesting observation', {
        sessionId: sessionDbId,
        toolName: payload.toolName,
      });
      return '';
    })(),
    agentId: typeof payload.agentId === 'string' ? payload.agentId : undefined,
    agentType: typeof payload.agentType === 'string' ? payload.agentType : undefined,
    toolUseId: typeof payload.toolUseId === 'string' ? payload.toolUseId : undefined,
  });
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

  if (payload.agentId) {
    return { status: 'skipped', reason: 'subagent_context' };
  }

  const store = dbManager.getSessionStore();

  // Summarize only a session the worker knows. Creating a row here gave every
  // idle turn of a session nothing else recorded (an excluded checkout, a
  // skipped init) an empty-project row and a paid observer call (R5-1).
  const sessionDbId = store.findSessionDbIdByContentSessionId(contentSessionId, platformSource);
  if (sessionDbId === null) {
    return { status: 'unknown_session' };
  }

  // An excluded checkout is never summarized, even one excluded after its
  // session began (R5-1). A host that cannot check the user's exclusions
  // itself sends its checkout; without one, the checkout the session was
  // recorded in is checked.
  const requestCwd = typeof payload.cwd === 'string' ? payload.cwd.trim() : '';
  const checkoutCwd = requestCwd || store.getSessionCwd(sessionDbId);
  if (checkoutCwd) {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
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
  sessionManager.queueSummarize(sessionDbId, cleanedLastAssistantMessage, promptNumber);
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

export async function ingestSessionEnd(
  payload: SessionEndPayload,
  deps: Pick<IngestContext, 'sessionManager' | 'dbManager'> = requireIngestContext(),
  handoff: IngestHandoff = {},
): Promise<SessionIngestOutcome> {
  const store = deps.dbManager.getSessionStore();
  const sessionDbId = store.findSessionDbIdByContentSessionId(payload.contentSessionId, payload.platformSource);
  if (sessionDbId === null) {
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

  const project = typeof cwd === 'string' && cwd.trim() ? getProjectContext(cwd).primary : '';

  const store = dbManager.getSessionStore();
  const sessionDbId = store.createSDKSession(contentSessionId, project, '', undefined, platformSource);

  let stored = 0;
  let duplicates = 0;
  let privateOnly = 0;
  for (const call of calls) {
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
