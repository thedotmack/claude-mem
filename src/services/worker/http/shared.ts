
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

export interface SummaryStoredEvent {
  sessionId: string;
  messageId: number;
}

class IngestEventBus extends EventEmitter {
  private readonly recentStored = new Map<string, { event: SummaryStoredEvent; at: number }>();
  private static readonly RECENT_EVENT_TTL_MS = 60_000;

  constructor() {
    super();
    this.setMaxListeners(0);
    this.on('summaryStoredEvent', (evt: SummaryStoredEvent) => {
      this.recentStored.set(evt.sessionId, { event: evt, at: Date.now() });
      this.evictExpiredStored();
    });
  }

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

export const ingestEventBus = new IngestEventBus();

interface IngestContext {
  sessionManager: SessionManager;
  dbManager: DatabaseManager;
  eventBroadcaster: SessionEventBroadcaster;
  ensureGeneratorRunning?: (sessionDbId: number, source: string) => void;
}

let ctx: IngestContext | null = null;

export function setIngestContext(next: IngestContext): void {
  ctx = next;
}

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
}

export function ingestObservation(payload: ObservationPayload): IngestResult {
  const { sessionManager, dbManager, eventBroadcaster, ensureGeneratorRunning } = requireContext();

  const platformSource = normalizePlatformSource(payload.platformSource);
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : '';
  const project = cwd.trim() ? getProjectContext(cwd).primary : '';

  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);

  if (cwd && isProjectExcluded(cwd, settings.CLAUDE_MEM_EXCLUDED_PROJECTS)) {
    return { ok: true, status: 'skipped', reason: 'project_excluded' };
  }

  const skipTools = new Set(
    settings.CLAUDE_MEM_SKIP_TOOLS.split(',').map(t => t.trim()).filter(Boolean)
  );
  if (skipTools.has(payload.toolName)) {
    return { ok: true, status: 'skipped', reason: 'tool_excluded' };
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
    promptNumber = store.getPromptNumberFromUserPrompts(payload.contentSessionId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('INGEST', 'Observation session resolution failed', {
      contentSessionId: payload.contentSessionId,
      toolName: payload.toolName,
    }, error instanceof Error ? error : new Error(message));
    return { ok: false, reason: message, status: 500 };
  }

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
    toolUseId: typeof payload.toolUseId === 'string' ? payload.toolUseId : undefined,
  });

  ensureGeneratorRunning?.(sessionDbId, 'observation');
  eventBroadcaster.broadcastObservationQueued(sessionDbId);

  return { ok: true, sessionDbId };
}

export interface PromptPayload {
  contentSessionId: string;
  prompt: string;
  cwd?: string;
  platformSource?: string;
  promptNumber?: number;
}

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

  if (payload.parsed.skipped) {
    ingestEventBus.emit('summaryStoredEvent', {
      sessionId: payload.contentSessionId,
      messageId: payload.messageId,
    } satisfies SummaryStoredEvent);
    return { ok: true, sessionDbId: payload.sessionDbId, messageId: payload.messageId };
  }

  ingestEventBus.emit('summaryStoredEvent', {
    sessionId: payload.contentSessionId,
    messageId: payload.messageId,
  } satisfies SummaryStoredEvent);

  return { ok: true, sessionDbId: payload.sessionDbId, messageId: payload.messageId };
}
