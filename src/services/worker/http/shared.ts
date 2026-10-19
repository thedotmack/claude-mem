
import { logger } from '../../../utils/logger.js';
import type { SessionManager } from '../SessionManager.js';
import type { DatabaseManager } from '../DatabaseManager.js';
import type { SessionEventBroadcaster } from '../events/SessionEventBroadcaster.js';
import { isCodexInternalPrompt, isInternalProtocolPayload, stripMemoryTags } from '../../../utils/tag-stripping.js';
import { isProjectExcluded } from '../../../utils/project-filter.js';
import { shouldSkipAgentObservation } from '../../../shared/should-skip-agent-observation.js';
import { isToolSkipped } from '../../../shared/is-tool-skipped.js';
import { SettingsDefaultsManager } from '../../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../../shared/paths.js';
import { getProjectContext, isProjectKeySource } from '../../../utils/project-name.js';
import { MEDIA_PROMPT_PLACEHOLDER } from '../../sqlite/prompt-storage.js';
import { USER_PROMPT_DEDUPE_WINDOW_MS } from '../../../shared/user-prompts.js';
import { normalizePlatformSource } from '../../../shared/platform-source.js';
import { PrivacyCheckValidator } from '../validation/PrivacyCheckValidator.js';
import { captureEvent } from '../../telemetry/telemetry.js';
import { classifySkillId, firstPartySkillFromSlashPrompt, skillNameFromToolInput } from '../../telemetry/skill-id.js';
import { isRecursiveMemoryTool, isExplicitMemoryWrite } from '../../../shared/memory-retrieval-tools.js';
import { workStateTool } from '../../../shared/work-state-telemetry.js';
import { recordWorkStatePrivacy, recordWorkStatePrompt, recordWorkStateTool, isPublicWorkStateTurn } from '../../telemetry/work-state.js';

export interface IngestContext {
  sessionManager: SessionManager;
  dbManager: DatabaseManager;
  eventBroadcaster: SessionEventBroadcaster;
  ensureGeneratorRunning?: (sessionDbId: number, source: string) => void | Promise<void>;
}

let ctx: IngestContext | null = null;

/** Prompts past this are cut at the session-init boundary, on a UTF-8 boundary. */
export const MAX_USER_PROMPT_BYTES = 256 * 1024;

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

export interface SessionInitPayload {
  contentSessionId: string;
  /** Already normalized (normalizePlatformSource). */
  platformSource: string;
  prompt?: string;
  /** A host's real user-turn ID, scoped by platform + content session. */
  nativePromptId?: string;
  project?: string;
  projectKeySource?: string;
  customTitle?: string;
  /** The checkout `project` is resolved from when `project` is absent. */
  cwd?: string;
  /**
   * When the producer saw the prompt (hook spool entries only). The prompt is
   * dated then, so the observations spooled after it, which are attributed
   * by their own enqueue time, belong to it. HTTP callers omit it (= now).
   */
  enqueuedAtEpochMs?: number;
  /** Work-state telemetry: when the host saw the prompt (absent for a replay, which the recorders ignore). */
  telemetryPromptEpochMs?: number;
  /** Work-state telemetry: the host's raw platform name. */
  telemetryPlatformSource?: string;
  agentId?: string;
  agentType?: string;
}

/** What session init did. The HTTP route maps each to its JSON reply; the spool drain unlinks every one. */
export type SessionInitOutcome =
  | { status: 'skipped'; reason: 'internal_protocol' | 'internal_system_prompt' | 'project_excluded' }
  | { status: 'skipped'; reason: 'private'; sessionDbId: number; promptNumber: number }
  | {
    status: 'duplicate';
    sessionDbId: number;
    promptNumber: number;
    contextInjected: boolean;
    nativePromptId?: string;
    nativePromptCurrent?: boolean;
  }
  /** The native prompt id was already used for different text: it can never succeed. */
  | { status: 'conflict'; error: string }
  | {
    status: 'initialized';
    sessionDbId: number;
    promptNumber: number;
    contextInjected: boolean;
    nativePromptId?: string;
    nativePromptCurrent?: boolean;
  };

/**
 * Session init (a user prompt), shared by `POST /api/sessions/init` and the
 * hook spool's `session_init` entries. Extracted from
 * SessionRoutes.handleSessionInitByClaudeId unchanged; the hand-off point is
 * the saved user prompt, before the generator kick.
 */
export async function ingestSessionInit(
  payload: SessionInitPayload,
  deps: IngestContext = requireIngestContext(),
  handoff: IngestHandoff = {},
): Promise<SessionInitOutcome> {
  const { sessionManager, dbManager, eventBroadcaster, ensureGeneratorRunning } = deps;
  const { contentSessionId, platformSource } = payload;

  const rawPrompt = typeof payload.prompt === 'string' ? payload.prompt : undefined;
  const customTitle = payload.customTitle || undefined;

  if (rawPrompt && isInternalProtocolPayload(rawPrompt)) {
    logger.debug('HTTP', 'session-init: skipping internal protocol payload before session creation', { contentSessionId });
    return { status: 'skipped', reason: 'internal_protocol' };
  }

  // Codex's own helper threads (task titles, memory consolidation,
  // suggestions) arrive like a user turn; Codex only (see the hook handler).
  if (rawPrompt && platformSource === 'codex' && isCodexInternalPrompt(rawPrompt)) {
    logger.debug('HTTP', 'session-init: skipping a Codex internal helper prompt before session creation', { contentSessionId });
    return { status: 'skipped', reason: 'internal_system_prompt' };
  }

  // A host that runs inside another process (the OpenCode plugin) sends only
  // its checkout: key it here with the resolver observation ingest uses for
  // the same host, so init and capture agree (#3803). A hook that resolved
  // the key itself sends `project` and `projectKeySource`, and those win.
  const checkoutCwd = typeof payload.cwd === 'string' ? payload.cwd : '';
  const checkoutContext = !payload.project && checkoutCwd.trim() ? getProjectContext(checkoutCwd) : null;
  // Such a host cannot check the user's project exclusions either (the CLI
  // hooks do, before they call): skip before any session row exists.
  if (checkoutContext) {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    if (isProjectExcluded(checkoutCwd, settings.CLAUDE_MEM_EXCLUDED_PROJECTS)) {
      return { status: 'skipped', reason: 'project_excluded' };
    }
  }
  const project = payload.project || checkoutContext?.primary || 'unknown';
  const projectKeySource = checkoutContext ? checkoutContext.keySource : payload.projectKeySource;

  const slashSkillId = firstPartySkillFromSlashPrompt(rawPrompt);
  if (slashSkillId) {
    captureEvent('skill_invoked', {
      skill_id: slashSkillId,
      skill_source: 'first_party',
      skill_trigger: 'prompt',
      ide: platformSource,
    });
  }

  let prompt = rawPrompt || MEDIA_PROMPT_PLACEHOLDER;

  const promptByteLength = Buffer.byteLength(prompt, 'utf8');
  if (promptByteLength > MAX_USER_PROMPT_BYTES) {
    logger.warn('HTTP', 'SessionRoutes: oversized prompt truncated at session-init boundary', {
      project,
      contentSessionId,
      promptByteLength,
      maxBytes: MAX_USER_PROMPT_BYTES,
      preview: prompt.slice(0, 200)
    });
    const buf = Buffer.from(prompt, 'utf8');
    let end = MAX_USER_PROMPT_BYTES;
    while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
    prompt = buf.subarray(0, end).toString('utf8');
  }

  logger.info('HTTP', 'SessionRoutes: handleSessionInitByClaudeId called', {
    contentSessionId,
    project,
    platformSource,
    prompt_length: prompt?.length,
    customTitle
  });

  const store = dbManager.getSessionStore();

  const sessionDbId = store.createSDKSession(contentSessionId, project, prompt, customTitle, platformSource);

  // The checkout `project` was resolved from, and how it was derived, so a
  // session that never reports an observation still leaves evidence for
  // worktree adoption (gate P1-2). An unknown key source is not recorded as
  // anything: the next observation's ingest records the checkout itself.
  if (checkoutCwd.trim() && isProjectKeySource(projectKeySource)) {
    store.setSessionCwd(sessionDbId, checkoutCwd, projectKeySource);
  }

  const dbSession = store.getSessionById(sessionDbId);
  const isNewSession = !dbSession?.memory_session_id;
  logger.info('SESSION', `CREATED | contentSessionId=${contentSessionId} → sessionDbId=${sessionDbId} | isNew=${isNewSession} | project=${project}`, {
    sessionId: sessionDbId
  });

  const currentCount = store.getPromptNumberFromUserPrompts(contentSessionId, sessionDbId);
  let promptNumber = currentCount + 1;

  const memorySessionId = dbSession?.memory_session_id || null;
  if (promptNumber > 1) {
    logger.debug('HTTP', `[ALIGNMENT] DB Lookup Proof | contentSessionId=${contentSessionId} → memorySessionId=${memorySessionId || '(not yet captured)'} | prompt#=${promptNumber}`);
  } else {
    logger.debug('HTTP', `[ALIGNMENT] New Session | contentSessionId=${contentSessionId} | prompt#=${promptNumber} | memorySessionId will be captured on first SDK response`);
  }

  const cleanedPrompt = stripMemoryTags(prompt);
  const telemetryAttribution = {
    contentSessionId,
    enqueuedAtEpochMs: payload.telemetryPromptEpochMs,
    platformSource: payload.telemetryPlatformSource,
    agentId: payload.agentId,
    agentType: payload.agentType,
  };

  if (!cleanedPrompt || cleanedPrompt.trim() === '') {
    recordWorkStatePrivacy(store.db, telemetryAttribution, true);
    logger.debug('HOOK', 'Session init - prompt entirely private', {
      sessionId: sessionDbId,
      promptNumber,
      originalLength: prompt.length
    });
    return { status: 'skipped', reason: 'private', sessionDbId, promptNumber };
  }

  const nativePromptId = payload.nativePromptId;
  const normalizedSdkPrompt = cleanedPrompt.startsWith('/') ? cleanedPrompt.substring(1) : cleanedPrompt;
  // A native slash-only ask is still a real turn. Keep its cleaned text
  // when SDK normalization would erase it; legacy normalization is unchanged.
  const sdkPrompt = nativePromptId ? normalizedSdkPrompt || cleanedPrompt : normalizedSdkPrompt;
  let nativeAnchor: { id: number; promptNumber: number; duplicate: boolean } | undefined;
  if (nativePromptId) {
    try {
      nativeAnchor = store.saveNativeUserPrompt(contentSessionId, sessionDbId, nativePromptId, cleanedPrompt, rawPrompt || MEDIA_PROMPT_PLACEHOLDER, payload.enqueuedAtEpochMs);
    } catch (error) {
      if (error instanceof Error && error.message === 'Native prompt identity was reused with different text') {
        return { status: 'conflict', error: error.message };
      }
      throw error;
    }
    promptNumber = nativeAnchor.promptNumber;
  }
  // Is the native turn this request names still the session's current one?
  const nativePromptCurrentFor = (turnPromptNumber: number): boolean =>
    store.getPromptNumberFromUserPrompts(contentSessionId, sessionDbId) === turnPromptNumber
    && (sessionManager.getSession(sessionDbId)?.lastPromptNumber ?? turnPromptNumber) === turnPromptNumber;
  // Legacy callers retain same-text retry protection. Native IDs distinguish
  // intentional repeated prompts without delaying the user's next turn.
  const duplicatePrompt = nativeAnchor
    ? (nativeAnchor.duplicate ? { id: nativeAnchor.id, prompt_number: nativeAnchor.promptNumber } : undefined)
    : store.findRecentDuplicateUserPrompt(contentSessionId, cleanedPrompt, USER_PROMPT_DEDUPE_WINDOW_MS, sessionDbId);

  // A newer public submission reopens coverage even if its text reuses a row.
  // The recorder rejects missing/old timestamps and preserves newer boundaries.
  recordWorkStatePrivacy(store.db, telemetryAttribution, false);

  if (duplicatePrompt) {
    const activeSession = sessionManager.getSession(sessionDbId);
    // The durable claim can survive an initialization failure. Repair only
    // a stale live native turn; cold sessions remain lazy and older retries
    // must never replace a newer prompt's context.
    if (nativeAnchor && activeSession && activeSession.lastPromptNumber < duplicatePrompt.prompt_number) {
      sessionManager.initializeSession(sessionDbId, sdkPrompt, duplicatePrompt.prompt_number, project);
    }
    const contextInjected = activeSession !== undefined;
    logger.debug('SESSION', 'Duplicate user prompt skipped', {
      sessionId: sessionDbId,
      promptNumber: duplicatePrompt.prompt_number,
      duplicatePromptId: duplicatePrompt.id,
      contextInjected
    });
    return {
      status: 'duplicate',
      sessionDbId,
      promptNumber: duplicatePrompt.prompt_number,
      contextInjected,
      ...(nativePromptId ? { nativePromptId, nativePromptCurrent: nativePromptCurrentFor(duplicatePrompt.prompt_number) } : {}),
    };
  }

  // A prompt this route ACCEPTS on a row a previous end already completed
  // means the session carried on, so put it back to active and let the next
  // end stamp the real completion time (#4080).
  //
  // After the privacy and duplicate gates, not before them. Both of those
  // return early without saving a prompt or starting a generator, so a
  // reopen above them would clear the completion of a session nothing is
  // going to finalize again — a retry of an already-saved prompt would leave
  // the row 'active' for good, which is the bug in the other direction
  // (#2373). Only this route reopens at all: the observation and summarize
  // routes can carry trailing traffic from the turn that just ended, where
  // 'completed' is the truth.
  let savedUserPromptId: number;
  if (nativeAnchor) {
    savedUserPromptId = nativeAnchor.id;
  } else {
    store.reopenCompletedSession(sessionDbId);
    savedUserPromptId = store.saveUserPrompt(contentSessionId, promptNumber, cleanedPrompt, sessionDbId, undefined, undefined, payload.enqueuedAtEpochMs);
  }
  // Saved: the hand-off point. Synchronously, before the generator kick.
  handoff.markHandedOff?.();

  recordWorkStatePrompt(store.db, telemetryAttribution, savedUserPromptId);

  // Fire-and-forget cloud sync nudge, beside the write itself so every
  // saved prompt nudges — including cursor sessions, which skip the
  // non-cursor branch below entirely.
  dbManager.getCloudSync()?.notify();

  const contextInjected = sessionManager.getSession(sessionDbId) !== undefined;

  logger.debug('SESSION', 'User prompt saved', {
    sessionId: sessionDbId,
    promptNumber,
    contextInjected
  });

  if (platformSource !== 'cursor') {
    const session = sessionManager.initializeSession(sessionDbId, sdkPrompt, promptNumber, project);

    // The row this request saved, by id. A newest-by-timestamp lookup can
    // return a neighbouring turn saved in the same millisecond.
    const savedUserPrompt = store.getUserPromptById(savedUserPromptId);

    if (savedUserPrompt) {
      eventBroadcaster.broadcastNewPrompt({
        id: savedUserPrompt.id,
        content_session_id: savedUserPrompt.content_session_id,
        project: savedUserPrompt.project,
        platform_source: savedUserPrompt.platform_source,
        prompt_number: savedUserPrompt.prompt_number,
        prompt_text: savedUserPrompt.prompt_text,
        created_at_epoch: savedUserPrompt.created_at_epoch
      });

      const chromaStart = Date.now();
      const promptText = savedUserPrompt.prompt_text;
      dbManager.getChromaSync()?.syncUserPrompt(
        savedUserPrompt.id,
        savedUserPrompt.memory_session_id,
        savedUserPrompt.project,
        promptText,
        savedUserPrompt.prompt_number,
        savedUserPrompt.created_at_epoch,
        savedUserPrompt.platform_source
      ).then(() => {
        const chromaDuration = Date.now() - chromaStart;
        const truncatedPrompt = promptText.length > 60
          ? promptText.substring(0, 60) + '...'
          : promptText;
        logger.debug('CHROMA', 'User prompt synced', {
          promptId: savedUserPrompt.id,
          duration: `${chromaDuration}ms`,
          prompt: truncatedPrompt
        });
      }).catch((error) => {
        logger.error('CHROMA', 'User prompt sync failed, continuing without vector search', {
          promptId: savedUserPrompt.id,
          prompt: promptText.length > 60 ? promptText.substring(0, 60) + '...' : promptText
        }, error);
      });
    }

    await ensureGeneratorRunning?.(sessionDbId, 'init');

    eventBroadcaster.broadcastSessionStarted(sessionDbId, session.project);
  } else {
    // Cursor creates its observer lazily, but accepted prompts still update an existing session.
    if (sessionManager.getSession(sessionDbId)) {
      sessionManager.initializeSession(sessionDbId, sdkPrompt, promptNumber, project);
    }
    logger.debug('HTTP', 'session-init: Skipping SDK agent init for Cursor platform', { sessionDbId, promptNumber });
  }

  return {
    status: 'initialized',
    sessionDbId,
    promptNumber,
    contextInjected,
    ...(nativePromptId ? { nativePromptId, nativePromptCurrent: nativePromptCurrentFor(promptNumber) } : {}),
  };
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
  /**
   * The project to file the observation under when `cwd` is absent (the wire
   * gateway's `<agentId>-unattributed`). A cwd always wins: its project is
   * resolved from the checkout.
   */
  project?: string;
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
  if (isRecursiveMemoryTool(payload.toolName)) {
    return { ok: true, status: 'skipped', reason: 'memory_retrieval' };
  }
  const { sessionManager, dbManager, eventBroadcaster, ensureGeneratorRunning } = requireIngestContext();

  const platformSource = normalizePlatformSource(payload.platformSource);
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : '';
  const projectContext = cwd.trim() ? getProjectContext(cwd) : null;
  const explicitProject = !projectContext && typeof payload.project === 'string' ? payload.project.trim() : '';
  // Same fallback as session init: an empty project makes cloud sync quarantine
  // every content line the session produces (#4772).
  const project = projectContext?.primary || explicitProject || 'unknown';

  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);

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

  // A tool use that already produced an observation is done. The queue's own
  // dedupe (SessionMessageBuffer) lasts one worker lifetime, so without this
  // a replay after a restart (a re-sent spool entry, the wire gateway's
  // capture after its own restart) would be observed twice.
  if (payload.toolUseId && store.isToolUseLinkedToObservation(payload.contentSessionId, payload.toolUseId)) {
    return { ok: true, status: 'skipped', reason: 'tool_use_already_observed' };
  }

  if (!trackedTool && privacy.prompt.trim() && isPublicWorkStateTurn(store.db, telemetryAttribution)) {
    recordWorkStateTool(store.db, telemetryAttribution, payload.toolUseId, payload.toolName, payload.toolResponse);
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

  if (isExplicitMemoryWrite(payload.toolName)) {
    // The explicit note is already stored. Its raw receipt above is useful,
    // but observing the echo would duplicate it and buy another provider call.
    return { ok: true, status: 'skipped', reason: 'explicit_memory_write' };
  }

  sessionManager.queueObservation(sessionDbId, {
    tool_name: payload.toolName,
    tool_input: cleanedToolInput,
    tool_response: cleanedToolResponse,
    prompt_number: promptNumber,
    // An explicit project stands in for the missing checkout on purpose.
    cwd: (cwd || explicitProject) ? cwd : (() => {
      logger.error('INGEST', 'Missing cwd when ingesting observation', {
        sessionId: sessionDbId,
        toolName: payload.toolName,
      });
      return '';
    })(),
    agentId: typeof payload.agentId === 'string' ? payload.agentId : undefined,
    agentType: typeof payload.agentType === 'string' ? payload.agentType : undefined,
    toolUseId: typeof payload.toolUseId === 'string' ? payload.toolUseId : undefined,
  }, payload.enqueuedAtEpochMs);
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
  sessionManager.queueSummarize(sessionDbId, cleanedLastAssistantMessage, promptNumber, payload.enqueuedAtEpochMs);
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

  // Same fallback as session init — an empty project gets quarantined by cloud sync (#4772).
  const project = typeof cwd === 'string' && cwd.trim() ? getProjectContext(cwd).primary : 'unknown';

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
