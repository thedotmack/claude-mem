/**
 * Worker HTTP shared ingest helpers.
 *
 * Per PATHFINDER-2026-04-22 plan 03 phase 0:
 *   `ingestObservation`, `ingestPrompt`, `ingestSummary` are the single
 *   in-process implementation of the worker's three ingest paths. The HTTP
 *   route handlers (cross-process callers) and worker-internal producers
 *   (transcript processor, ResponseProcessor) BOTH delegate here.
 *
 *   No HTTP loopback. No duplicated insert logic. One helper, N callers.
 *
 * Wiring: `WorkerService` registers its `sessionManager`, `dbManager`, and
 * `sessionEventBroadcaster` once at startup via `setIngestContext`. The
 * helpers fail fast if called before registration.
 */

import { logger } from '../../../utils/logger.js';
import type { SessionManager } from '../SessionManager.js';
import type { DatabaseManager } from '../DatabaseManager.js';
import type { SessionEventBroadcaster } from '../events/SessionEventBroadcaster.js';
import type { ParsedSummary } from '../../../sdk/parser.js';
import { stripMemoryTagsFromJson } from '../../../utils/tag-stripping.js';
import { isProjectExcluded } from '../../../utils/project-filter.js';
import { SettingsDefaultsManager } from '../../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../../shared/paths.js';
import { getProjectContext } from '../../../utils/project-name.js';
import { normalizePlatformSource } from '../../../shared/platform-source.js';
import { PrivacyCheckValidator } from '../validation/PrivacyCheckValidator.js';
import { EventEmitter } from 'events';

// ============================================================================
// Event bus — Phase 2 (`summaryStoredEvent`) consumers attach here.
// ============================================================================

/**
 * Event payload emitted exactly once per successful `ingestSummary` call that
 * actually stored a summary row. `messageId` is the pending_messages row id
 * that produced the summary; `sessionId` is the contentSessionId.
 *
 * Currently dormant — the only consumer (the blocking `/api/session/end`
 * endpoint) was removed when the Stop hook went fire-and-forget. Kept for
 * future internal subscribers; emissions are cheap no-ops with no listeners.
 */
export interface SummaryStoredEvent {
  sessionId: string;
  messageId: number;
}

class IngestEventBus extends EventEmitter {
  /**
   * Recent summaryStoredEvent buffer keyed by sessionId. Originally protected
   * the register-after-emit race for the blocking `/api/session/end` handler.
   * Currently unused (handler removed when Stop hook went fire-and-forget);
   * preserved so any future subscriber gets the same race-free contract.
   */
  private readonly recentStored = new Map<string, { event: SummaryStoredEvent; at: number }>();
  private static readonly RECENT_EVENT_TTL_MS = 60_000;

  constructor() {
    super();
    // Disable the default 10-listener warning. With no current consumers
    // this is moot, but kept for parity if future subscribers attach.
    this.setMaxListeners(0);
    this.on('summaryStoredEvent', (evt: SummaryStoredEvent) => {
      this.recentStored.set(evt.sessionId, { event: evt, at: Date.now() });
      this.evictExpiredStored();
    });
  }

  /** Read a recently-emitted summaryStoredEvent (idempotent; TTL-evicted). */
  takeRecentSummaryStored(sessionId: string): SummaryStoredEvent | undefined {
    const entry = this.recentStored.get(sessionId);
    if (!entry) return undefined;
    if (Date.now() - entry.at > IngestEventBus.RECENT_EVENT_TTL_MS) {
      this.recentStored.delete(sessionId);
      return undefined;
    }
    return entry.event;
  }

  private evictExpiredStored(): void {
    const cutoff = Date.now() - IngestEventBus.RECENT_EVENT_TTL_MS;
    for (const [key, entry] of this.recentStored) {
      if (entry.at < cutoff) this.recentStored.delete(key);
    }
  }
}

/**
 * Process-local event bus for ingestion lifecycle events.
 *
 * Single Node EventEmitter — there is no third event-bus in the worker.
 * `SessionManager` already uses Node EventEmitter for queue notifications
 * (`src/services/worker/SessionManager.ts:25`), and
 * `SessionQueueProcessor` consumes EventEmitter events
 * (`src/services/queue/SessionQueueProcessor.ts:18`); this module follows
 * the same pattern at the ingestion layer.
 */
export const ingestEventBus = new IngestEventBus();

// ============================================================================
// Context registration
// ============================================================================

interface IngestContext {
  sessionManager: SessionManager;
  dbManager: DatabaseManager;
  eventBroadcaster: SessionEventBroadcaster;
  /** Optional callback to (re)start the SDK generator after enqueue. */
  ensureGeneratorRunning?: (sessionDbId: number, source: string) => void;
}

let ctx: IngestContext | null = null;

/**
 * Register the worker-scoped services the ingest helpers depend on.
 * Called once from `WorkerService` constructor.
 */
export function setIngestContext(next: IngestContext): void {
  ctx = next;
}

/**
 * Attach the generator-running callback after `SessionRoutes` has been
 * constructed. `setIngestContext` is called early in `WorkerService` startup
 * (before routes exist), so the callback is wired in as a second step once
 * `SessionRoutes.ensureGeneratorRunning` is available.
 *
 * Without this, transcript-watcher observations queue via
 * `ingestObservation()` but the SDK generator never auto-starts to drain
 * them.
 */
export function attachIngestGeneratorStarter(
  ensureGeneratorRunning: (sessionDbId: number, source: string) => void,
): void {
  requireContext().ensureGeneratorRunning = ensureGeneratorRunning;
}

function requireContext(): IngestContext {
  if (!ctx) {
    throw new Error('ingest helpers used before setIngestContext() — wiring bug');
  }
  return ctx;
}

// ============================================================================
// Result type
// ============================================================================

export type IngestResult =
  | { ok: true; sessionDbId: number; messageId?: number }
  | { ok: true; status: 'skipped'; reason: string }
  | { ok: false; reason: string; status?: number };

// ============================================================================
// Observation
// ============================================================================

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
}

/**
 * Ingest an observation: resolve session, apply project / skip-tool filters,
 * strip privacy tags, persist to pending_messages, ensure the SDK generator
 * is running.
 *
 * Same implementation for cross-process HTTP callers and worker-internal
 * callers (transcript processor, ResponseProcessor side-effects).
 */
export function ingestObservation(payload: ObservationPayload): IngestResult {
  const { sessionManager, dbManager, eventBroadcaster, ensureGeneratorRunning } = requireContext();

  if (!payload.contentSessionId) {
    return { ok: false, reason: 'missing contentSessionId', status: 400 };
  }
  if (!payload.toolName) {
    return { ok: false, reason: 'missing toolName', status: 400 };
  }

  const platformSource = normalizePlatformSource(payload.platformSource);
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : '';
  const project = cwd.trim() ? getProjectContext(cwd).primary : '';

  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);

  // Project exclusion (the same gate the hook handler applies).
  if (cwd && isProjectExcluded(cwd, settings.CLAUDE_MEM_EXCLUDED_PROJECTS)) {
    return { ok: true, status: 'skipped', reason: 'project_excluded' };
  }

  // Skip low-value or meta tools per user settings.
  const skipTools = new Set(
    settings.CLAUDE_MEM_SKIP_TOOLS.split(',').map(t => t.trim()).filter(Boolean)
  );
  if (skipTools.has(payload.toolName)) {
    return { ok: true, status: 'skipped', reason: 'tool_excluded' };
  }

  // Skip meta-observations: file operations on session-memory files.
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
    promptNumber = store.getPromptNumberFromUserPrompts(payload.contentSessionId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('INGEST', 'Observation session resolution failed', {
      contentSessionId: payload.contentSessionId,
      toolName: payload.toolName,
    }, error instanceof Error ? error : new Error(message));
    return { ok: false, reason: message, status: 500 };
  }

  // Privacy: skip if user prompt was entirely private.
  const userPrompt = PrivacyCheckValidator.checkUserPromptPrivacy(
    store,
    payload.contentSessionId,
    promptNumber,
    'observation',
    sessionDbId,
    { tool_name: payload.toolName }
  );
  if (!userPrompt) {
    return { ok: true, status: 'skipped', reason: 'private' };
  }

  const cleanedToolInput = payload.toolInput !== undefined
    ? stripMemoryTagsFromJson(JSON.stringify(payload.toolInput))
    : '{}';
  const cleanedToolResponse = payload.toolResponse !== undefined
    ? stripMemoryTagsFromJson(JSON.stringify(payload.toolResponse))
    : '{}';

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
    // Forward the provider-assigned tool-use id so the
    // UNIQUE(content_session_id, tool_use_id) idempotency index from Plan 01
    // can actually collapse replays. SQLite treats NULL tool_use_id values as
    // distinct, so dropping it here silently defeats the INSERT OR IGNORE.
    toolUseId: typeof payload.toolUseId === 'string' ? payload.toolUseId : undefined,
  });

  ensureGeneratorRunning?.(sessionDbId, 'observation');
  eventBroadcaster.broadcastObservationQueued(sessionDbId);

  return { ok: true, sessionDbId };
}

// ============================================================================
// Summary (queue side — agent processes the request asynchronously)
// ============================================================================

export interface PromptPayload {
  contentSessionId: string;
  /** The user prompt text (must not contain stripped tags). */
  prompt: string;
  cwd?: string;
  platformSource?: string;
  promptNumber?: number;
}

/**
 * Ingest a user prompt. Used by the SessionStart / UserPromptSubmit hooks and
 * by transcript-driven session inits. Wraps `SessionStore.appendUserPrompt`
 * so cross-process and in-process callers share the same path.
 */
export function ingestPrompt(payload: PromptPayload): IngestResult {
  const { dbManager } = requireContext();

  if (!payload.contentSessionId) {
    return { ok: false, reason: 'missing contentSessionId', status: 400 };
  }
  if (typeof payload.prompt !== 'string') {
    return { ok: false, reason: 'missing prompt text', status: 400 };
  }

  const platformSource = normalizePlatformSource(payload.platformSource);
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : '';
  const project = cwd.trim() ? getProjectContext(cwd).primary : '';

  try {
    const store = dbManager.getSessionStore();
    const sessionDbId = store.createSDKSession(payload.contentSessionId, project, payload.prompt, undefined, platformSource);
    return { ok: true, sessionDbId };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: message, status: 500 };
  }
}

// ============================================================================
// Summary
// ============================================================================

/**
 * Two shapes of ingest:
 *   - "queue a summarize request" (cross-process hook trigger): goes via
 *     `SessionManager.queueSummarize` so the SDK agent will produce the XML
 *     payload on its next iteration.
 *   - "the SDK agent already produced the parsed summary": goes via
 *     `ingestSummary({ parsed, sessionDbId, messageId })`. Stored synchronously,
 *     emits `summaryStoredEvent` for the blocking endpoint in plan 05.
 */
export type SummaryPayload =
  | {
      kind: 'queue';
      contentSessionId: string;
      lastAssistantMessage?: string;
      platformSource?: string;
      cwd?: string;
    }
  | {
      kind: 'parsed';
      sessionDbId: number;
      messageId: number;
      contentSessionId: string;
      parsed: ParsedSummary;
    };

export function ingestSummary(payload: SummaryPayload): IngestResult {
  // The 'parsed' branch is a pure post-store notification — it only touches
  // the module-scope event bus, not the database/session manager. Resolving
  // requireContext() before the branch split breaks unit tests that drive
  // ResponseProcessor with a mocked sessionManager but no setIngestContext.
  // Only the 'queue' branch needs the worker-internal context.
  if (payload.kind === 'queue') {
    const { sessionManager, dbManager, ensureGeneratorRunning } = requireContext();

    if (!payload.contentSessionId) {
      return { ok: false, reason: 'missing contentSessionId', status: 400 };
    }

    const platformSource = normalizePlatformSource(payload.platformSource);
    const cwd = typeof payload.cwd === 'string' ? payload.cwd : '';
    const project = cwd.trim() ? getProjectContext(cwd).primary : '';

    let sessionDbId: number;
    try {
      sessionDbId = dbManager.getSessionStore().createSDKSession(payload.contentSessionId, project, '', undefined, platformSource);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, reason: message, status: 500 };
    }

    sessionManager.queueSummarize(sessionDbId, payload.lastAssistantMessage);
    ensureGeneratorRunning?.(sessionDbId, 'summarize');

    return { ok: true, sessionDbId };
  }

  // kind === 'parsed' — the SDK agent has produced a summary; store via
  // session store and emit the summaryStoredEvent for blocking consumers.
  // Skipped summaries (`<skip_summary/>`) are recorded as a successful no-op:
  // they have no content to persist, but consumers should still be unblocked.
  if (payload.parsed.skipped) {
    ingestEventBus.emit('summaryStoredEvent', {
      sessionId: payload.contentSessionId,
      messageId: payload.messageId,
    } satisfies SummaryStoredEvent);
    return { ok: true, sessionDbId: payload.sessionDbId, messageId: payload.messageId };
  }

  // The actual storage of the parsed summary remains co-transactional with
  // the observation batch in `processAgentResponse`. By the time this branch
  // is reached the row is already persisted; this call is the canonical
  // post-store notification path so every producer fires the event the same
  // way (Plan 03 Phase 2 + greploop fix — sole emitter of summaryStoredEvent).
  ingestEventBus.emit('summaryStoredEvent', {
    sessionId: payload.contentSessionId,
    messageId: payload.messageId,
  } satisfies SummaryStoredEvent);

  return { ok: true, sessionDbId: payload.sessionDbId, messageId: payload.messageId };
}
