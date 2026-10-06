import path from 'path';
import { recordSessionPrompt } from '../../cli/handlers/session-init.js';
import { fileEditHandler } from '../../cli/handlers/file-edit.js';
import { ensureWorkerRunning, workerHttpRequest } from '../../shared/worker-utils.js';
import { DATA_DIR } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';
import { getProjectContext } from '../../utils/project-name.js';
import { writeAgentsMd } from '../../utils/agents-md-utils.js';
import { getValueByPath, resolveFieldSpec, resolveFields, matchesRule } from './field-utils.js';
import { expandHomePath, shouldSuppressNativeCodexAgentsContext } from './config.js';
import type { TranscriptSchema, WatchTarget, SchemaEvent } from './types.js';
import { normalizePlatformSource } from '../../shared/platform-source.js';
import { ingestObservation } from '../worker/http/shared.js';

const AGENT_ID_IN_PATH =
  /agent-transcripts[/\\]([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[/\\]|$)/i;

/** Prefer the explicit watch field; fall back to `agent-transcripts/<uuid>/` in the path. */
export function resolveWatchAgentId(watch: WatchTarget): string | undefined {
  const explicit = typeof watch.agentId === 'string' ? watch.agentId.trim() : '';
  if (explicit && explicit !== '*') return explicit;
  const match = watch.path.match(AGENT_ID_IN_PATH);
  return match?.[1];
}

/**
 * The worker did not record a transcript turn's user prompt. The watcher
 * checkpoints at the start of that turn's line (or zstd frame) and retries it
 * from there, so the turn is replayed rather than its observations being filed
 * under no prompt, and nothing before it is sent twice.
 */
export class TranscriptAnchorError extends Error {
  constructor(sessionId: string, cause: unknown) {
    super(`session init failed for transcript session ${sessionId}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'TranscriptAnchorError';
    this.cause = cause;
  }
}

/** An observation declined before the worker accepted it must retain its line. */
export class TranscriptObservationError extends Error {
  constructor(sessionId: string, cause: unknown) {
    super(`observation not accepted for transcript session ${sessionId}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'TranscriptObservationError';
    this.cause = cause;
  }
}

interface PendingTool {
  toolName: string;
  toolInput?: unknown;
}

interface SessionState {
  sessionId: string;
  platformSource: string;
  cwd?: string;
  project?: string;
  lastUserMessage?: string;
  lastAssistantMessage?: string;
  pendingTools?: Map<string, PendingTool>;
  isSubagent?: boolean;
}

/**
 * What the watcher keeps per transcript file across restarts: the working
 * directory its session last reported. Some hosts write it once, on the
 * session's first line (DeepSeek Harness), so a watcher that resumes mid-file
 * would otherwise never learn it. The processor reads it as a fallback and
 * updates it whenever the session reports one.
 */
export interface TranscriptFileContext {
  /** A cross-file source must still be the watched file whose snapshot was registered. */
  isCurrent?: () => boolean;
  cwd?: string;
  pendingToolFileIdentity?: string;
  pendingTools?: Record<string, Record<string, { toolName: string; toolInput?: unknown }>>;
}

/** How many subagent rollouts the processor remembers past their last turn. */
const MAX_REMEMBERED_SUBAGENT_SESSIONS = 4096;

export class TranscriptEventProcessor {
  private sessions = new Map<string, SessionState>();
  /** Ownership is in-memory only; durable snapshots below contain each file's tools. */
  private fileContexts = new Set<TranscriptFileContext>();
  private fileSessionKeys = new WeakMap<TranscriptFileContext, Set<string>>();
  registerFileContext(file: TranscriptFileContext): void { this.fileContexts.add(file); }

  private pendingToolOwners = new WeakMap<PendingTool, TranscriptFileContext>();
  /**
   * Session keys of confirmed subagent rollouts. Codex ends a session per
   * turn but marks the rollout only on its first line, so the marker has to
   * outlive the turn state session_end drops. Oldest forgotten first.
   */
  private subagentSessionKeys = new Set<string>();

  /** A replaced transcript cannot lend its outstanding tools to a new file. */
  resetFileContext(file: TranscriptFileContext): void {
    const keys = new Set([...Object.keys(file.pendingTools ?? {}), ...(this.fileSessionKeys.get(file) ?? [])]);
    for (const key of keys) {
      const tools = file.pendingTools?.[key] ?? {};
      const session = this.sessions.get(key);
      for (const [id, tool] of Object.entries(tools)) {
        if (session?.pendingTools?.get(id) === tool) session.pendingTools.delete(id);
      }
      if (session && session.cwd === file.cwd) session.cwd = undefined;
    }
    this.fileContexts.delete(file);
    this.fileSessionKeys.delete(file);
    file.pendingTools = {};
    file.cwd = undefined;
  }

  async processEntry(
    entry: unknown,
    watch: WatchTarget,
    schema: TranscriptSchema,
    sessionIdOverride?: string | null,
    file?: TranscriptFileContext
  ): Promise<void> {
    if (file) this.registerFileContext(file);
    for (const event of schema.events) {
      if (!matchesRule(entry, event.match, schema)) continue;
      await this.handleEvent(entry, watch, schema, event, sessionIdOverride ?? undefined, file);
    }
  }

  private getSessionKey(watch: WatchTarget, sessionId: string): string {
    return `${watch.name}:${sessionId}`;
  }

  private getOrCreateSession(watch: WatchTarget, sessionId: string): SessionState {
    const key = this.getSessionKey(watch, sessionId);
    let session = this.sessions.get(key);
    if (!session) {
      session = {
        sessionId,
        platformSource: normalizePlatformSource(watch.name),
        ...(this.subagentSessionKeys.has(key) ? { isSubagent: true } : {}),
      };
      this.sessions.set(key, session);
    }
    return session;
  }

  private rememberSubagentSession(key: string): void {
    this.subagentSessionKeys.delete(key);
    this.subagentSessionKeys.add(key);
    if (this.subagentSessionKeys.size > MAX_REMEMBERED_SUBAGENT_SESSIONS) {
      const oldest = this.subagentSessionKeys.values().next().value;
      if (oldest !== undefined) this.subagentSessionKeys.delete(oldest);
    }
  }

  /**
   * Learn a rollout's session context (cwd, subagent marker) from its first
   * line without ingesting anything. A tail that resumes past that line (a
   * worker restart, or startAtEnd on a rollout already running) never reads
   * it otherwise, and a subagent-only watch would drop the whole rollout.
   */
  async primeSessionContext(
    entry: unknown,
    watch: WatchTarget,
    schema: TranscriptSchema,
    sessionIdOverride?: string | null,
    file?: TranscriptFileContext
  ): Promise<void> {
    for (const event of schema.events) {
      if (event.action !== 'session_context' || !matchesRule(entry, event.match, schema)) continue;
      await this.handleEvent(entry, watch, schema, event, sessionIdOverride ?? undefined, file);
    }
  }

  private resolveSessionId(
    entry: unknown,
    watch: WatchTarget,
    schema: TranscriptSchema,
    event: SchemaEvent,
    sessionIdOverride?: string
  ): string | null {
    const ctx = { watch, schema } as any;
    const fieldSpec = event.fields?.sessionId ?? (schema.sessionIdPath ? { path: schema.sessionIdPath } : undefined);
    const resolved = resolveFieldSpec(fieldSpec, entry, ctx);
    if (typeof resolved === 'string' && resolved.trim()) return resolved;
    if (typeof resolved === 'number') return String(resolved);
    if (sessionIdOverride && sessionIdOverride.trim()) return sessionIdOverride;
    return null;
  }

  private resolveCwd(
    entry: unknown,
    watch: WatchTarget,
    schema: TranscriptSchema,
    event: SchemaEvent,
    session: SessionState
  ): string | undefined {
    const ctx = { watch, schema, session } as any;
    const fieldSpec = event.fields?.cwd ?? (schema.cwdPath ? { path: schema.cwdPath } : undefined);
    const resolved = resolveFieldSpec(fieldSpec, entry, ctx);
    if (typeof resolved === 'string' && resolved.trim()) return resolved;
    if (watch.workspace) return watch.workspace;
    return session.cwd;
  }

  private resolveProject(
    entry: unknown,
    watch: WatchTarget,
    schema: TranscriptSchema,
    event: SchemaEvent,
    session: SessionState
  ): string | undefined {
    const ctx = { watch, schema, session } as any;
    const fieldSpec = event.fields?.project ?? (schema.projectPath ? { path: schema.projectPath } : undefined);
    const resolved = resolveFieldSpec(fieldSpec, entry, ctx);
    if (typeof resolved === 'string' && resolved.trim()) return resolved;
    if (watch.project) return watch.project;
    if (session.cwd) return getProjectContext(session.cwd).primary;
    return session.project;
  }

  private async handleEvent(
    entry: unknown,
    watch: WatchTarget,
    schema: TranscriptSchema,
    event: SchemaEvent,
    sessionIdOverride?: string,
    file?: TranscriptFileContext
  ): Promise<void> {
    const sessionId = this.resolveSessionId(entry, watch, schema, event, sessionIdOverride);
    if (!sessionId) {
      logger.debug('TRANSCRIPT', 'Skipping event without sessionId', { event: event.name, watch: watch.name });
      return;
    }

    const session = this.getOrCreateSession(watch, sessionId);
    const sessionKey = this.getSessionKey(watch, sessionId);
    if (file) {
      const keys = this.fileSessionKeys.get(file) ?? new Set<string>();
      keys.add(sessionKey);
      this.fileSessionKeys.set(file, keys);
    }
    if (file?.pendingTools?.[sessionKey]) {
      session.pendingTools ??= new Map();
      for (const [id, tool] of Object.entries(file.pendingTools[sessionKey])) {
        this.pendingToolOwners.set(tool, file);
        if (!session.pendingTools.has(id)) session.pendingTools.set(id, tool);
      }
    }
    // After a restart the watcher resumes mid-file, past the line that carried
    // the session's working directory: start from the one saved for the file.
    if (!session.cwd && file?.cwd) session.cwd = file.cwd;
    const cwd = this.resolveCwd(entry, watch, schema, event, session);
    if (cwd) session.cwd = cwd;
    const project = this.resolveProject(entry, watch, schema, event, session);
    if (project) session.project = project;

    // Codex writes the subagent marker on the first (session_meta) line, as an
    // object; learn it from whichever line carries it so later ingest events
    // can be gated. Its presence is the test, not its contents.
    if (watch.subagentSource && !session.isSubagent) {
      const marker = getValueByPath(entry, watch.subagentSource.path);
      if (marker !== undefined && marker !== null) {
        session.isSubagent = true;
        this.rememberSubagentSession(this.getSessionKey(watch, sessionId));
      }
    }

    // When native hooks own top-level sessions, ingest only confirmed subagent
    // rollouts. session_context still runs so a later marker line can flip the
    // session on; session_end still runs so the suppressed session is dropped
    // from the map instead of lingering.
    if (
      watch.subagentOnly &&
      !session.isSubagent &&
      event.action !== 'session_context' &&
      event.action !== 'session_end'
    ) {
      return;
    }

    const fields = resolveFields(event.fields, entry, { watch, schema, session: session as unknown as Record<string, unknown> });

    if (event.action === 'session_context') this.applySessionContext(session, fields);
    // Whatever directory the session now has is the file's, for the next restart.
    if (file && session.cwd) file.cwd = session.cwd;

    try {
      switch (event.action) {
        case 'session_context':
          break;
        case 'session_init':
          await this.handleSessionInit(session, fields);
          if (watch.context?.updateOn?.includes('session_start')) {
            await this.updateContext(session, watch);
          }
          break;
        case 'user_message': {
          // A user turn is anchored like a hook-captured prompt. Kept only in
          // memory, it left the session at prompt 0, so the observer got a
          // continuation with no user request and the batch was dropped (#3653).
          const prompt = this.resolveMessageText(fields.message) ?? this.resolveMessageText(fields.prompt);
          if (prompt) await this.anchorUserPrompt(session, prompt);
          break;
        }
        case 'assistant_message':
          session.lastAssistantMessage = this.resolveMessageText(fields.message) ?? session.lastAssistantMessage;
          break;
        case 'tool_use':
          await this.handleToolUse(session, watch, fields, file);
          break;
        case 'tool_result':
          await this.handleToolResult(session, watch, fields, file);
          break;
        case 'observation':
          await this.sendObservation(session, watch, fields);
          break;
        case 'file_edit':
          await this.sendFileEdit(session, fields);
          break;
        case 'session_end':
          await this.handleSessionEnd(session, watch);
          break;
        default:
          break;
      }
    } finally {
      if (file) {
        const pending: Record<string, PendingTool> = event.action === 'session_end' ? {} : { ...file.pendingTools?.[sessionKey] };
        for (const [id, tool] of session.pendingTools ?? []) {
          if (this.pendingToolOwners.get(tool) === file) pending[id] = tool;
        }
        file.pendingTools = { ...file.pendingTools, [sessionKey]: pending };
        if (Object.keys(pending).length === 0) delete file.pendingTools[sessionKey];
      }
    }
  }

  private applySessionContext(session: SessionState, fields: Record<string, unknown>): void {
    const cwd = typeof fields.cwd === 'string' ? fields.cwd : undefined;
    const project = typeof fields.project === 'string' ? fields.project : undefined;
    if (cwd) session.cwd = cwd;
    if (project) session.project = project;
  }

  /**
   * Normalize a message field to text. Transcripts that store messages as
   * content-block arrays (e.g. DeepSeek Harness assistant messages with
   * reasoning/text blocks) are joined by newline; strings pass through.
   */
  private resolveMessageText(value: unknown): string | undefined {
    if (typeof value === 'string') return value;
    if (!Array.isArray(value)) return undefined;
    const parts: string[] = [];
    for (const block of value) {
      if (block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string') {
        parts.push((block as { text: string }).text);
      }
    }
    return parts.length > 0 ? parts.join('\n') : undefined;
  }

  private async handleSessionInit(session: SessionState, fields: Record<string, unknown>): Promise<void> {
    const prompt = typeof fields.prompt === 'string' ? fields.prompt : '';
    await this.anchorUserPrompt(session, prompt);
  }

  /**
   * Record the turn's user prompt through the init path the hooks use, so the
   * worker has a user_prompts row for it. A prompt the worker did not record
   * (unreachable, a 429/5xx reply, no budget) throws TranscriptAnchorError:
   * the watcher then checkpoints at this turn's line and retries it, instead
   * of its observations being filed under no prompt.
   */
  private async anchorUserPrompt(session: SessionState, prompt: string): Promise<void> {
    if (prompt) {
      session.lastUserMessage = prompt;
    }
    const cwd = session.cwd;
    if (!cwd) {
      this.skipWithoutCwd(session, 'user prompt');
      return;
    }

    try {
      await recordSessionPrompt({
        sessionId: session.sessionId,
        cwd,
        prompt,
        platform: session.platformSource
      });
    } catch (error: unknown) {
      throw new TranscriptAnchorError(session.sessionId, error);
    }
  }

  /**
   * A turn of a session whose working directory is not known yet is skipped.
   * The worker's own directory is not a stand-in: it would key the prompt or
   * observation to the worker's own data dir (`.claude-mem`) and check project
   * exclusions against it. Once the session or its file reports a directory,
   * its turns go through.
   */
  private skipWithoutCwd(session: SessionState, what: string): void {
    logger.debug('TRANSCRIPT', `Skipping a ${what}: the session has no known working directory yet`, {
      sessionId: session.sessionId,
    });
  }

  private async handleToolUse(session: SessionState, watch: WatchTarget, fields: Record<string, unknown>, file?: TranscriptFileContext): Promise<void> {
    const toolId = typeof fields.toolId === 'string' ? fields.toolId : undefined;
    const toolName = typeof fields.toolName === 'string' ? fields.toolName : undefined;
    const toolInput = this.maybeParseJson(fields.toolInput);
    const toolResponse = this.maybeParseJson(fields.toolResponse);

    if (toolName === 'apply_patch' && typeof toolInput === 'string') {
      const files = this.parseApplyPatchFiles(toolInput);
      for (const filePath of files) {
        await this.sendFileEdit(session, {
          filePath,
          edits: [{ type: 'apply_patch', patch: toolInput }]
        });
      }
    }

    if (toolName && toolResponse !== undefined) {
      await this.sendObservation(session, watch, {
        toolName,
        toolInput,
        toolResponse,
        toolUseId: toolId,
      });
    } else if (toolName && toolId) {
      if (!session.pendingTools) session.pendingTools = new Map();
      const tool: PendingTool = { toolName, toolInput };
      if (file) this.pendingToolOwners.set(tool, file);
      session.pendingTools.set(toolId, tool);
    }
  }

  private async handleToolResult(session: SessionState, watch: WatchTarget, fields: Record<string, unknown>, file?: TranscriptFileContext): Promise<void> {
    const toolId = typeof fields.toolId === 'string' ? fields.toolId : undefined;
    let toolName = typeof fields.toolName === 'string' ? fields.toolName : undefined;
    const toolResponse = this.maybeParseJson(fields.toolResponse);
    let toolInput = this.maybeParseJson(fields.toolInput);

    const fileTools = file?.pendingTools?.[this.getSessionKey(watch, session.sessionId)];
    const cached = toolId ? session.pendingTools?.get(toolId) : undefined;
    let owner = file;
    let pending = file
      ? (toolId ? fileTools?.[toolId] : undefined) ?? (cached && this.pendingToolOwners.get(cached) === file ? cached : undefined)
      : cached;
    if (!pending && file && toolId) {
      const candidates = Array.from(this.fileContexts).flatMap(context => {
        if (context.isCurrent?.() === false) return [];
        const tool = context.pendingTools?.[this.getSessionKey(watch, session.sessionId)]?.[toolId];
        return tool ? [{ context, tool }] : [];
      });
      if (candidates.length === 1) {
        owner = candidates[0].context;
        pending = candidates[0].tool;
      }
    }
    if (pending) {
      if (!toolName) toolName = pending.toolName;
      if (toolInput === undefined) toolInput = pending.toolInput;
    }

    if (toolName) {
      await this.sendObservation(session, watch, {
        toolName,
        toolInput,
        toolResponse,
        toolUseId: toolId,
      });
      if (toolId) {
        if (session.pendingTools && session.pendingTools.get(toolId) === pending) session.pendingTools.delete(toolId);
        const ownerTools = owner?.pendingTools?.[this.getSessionKey(watch, session.sessionId)];
        if (ownerTools) delete ownerTools[toolId];
      }
    } else {
      logger.debug('TRANSCRIPT', 'Dropping tool_result with no resolvable toolName', {
        sessionId: session.sessionId,
        toolId,
      });
    }
  }

  private async sendObservation(session: SessionState, watch: WatchTarget, fields: Record<string, unknown>): Promise<void> {
    const toolName = typeof fields.toolName === 'string' ? fields.toolName : undefined;
    if (!toolName) return;
    if (!session.cwd) {
      this.skipWithoutCwd(session, 'observation');
      return;
    }

    let accepted = false;
    try {
      const result = await ingestObservation({
        contentSessionId: session.sessionId,
        cwd: session.cwd,
        toolName,
        toolInput: this.maybeParseJson(fields.toolInput),
        toolResponse: this.maybeParseJson(fields.toolResponse),
        platformSource: session.platformSource,
        toolUseId: typeof fields.toolUseId === 'string' ? fields.toolUseId : undefined,
        agentId: resolveWatchAgentId(watch),
      }, { markHandedOff: () => { accepted = true; } });
      if (!result.ok) throw new Error(result.reason);
    } catch (error) {
      // A generator kick can fail after queueObservation accepted the event.
      // That event is already owned by the worker and must not be replayed.
      if (accepted) {
        logger.warn('TRANSCRIPT', 'Observation accepted before generator kick failed', {
          sessionId: session.sessionId,
        }, error instanceof Error ? error : undefined);
        return;
      }
      throw new TranscriptObservationError(session.sessionId, error);
    }
  }

  private async sendFileEdit(session: SessionState, fields: Record<string, unknown>): Promise<void> {
    const filePath = typeof fields.filePath === 'string' ? fields.filePath : undefined;
    if (!filePath) return;
    if (!session.cwd) {
      this.skipWithoutCwd(session, 'file edit');
      return;
    }

    await fileEditHandler.execute({
      sessionId: session.sessionId,
      cwd: session.cwd,
      filePath,
      edits: Array.isArray(fields.edits) ? fields.edits : undefined,
      platform: session.platformSource
    });
  }

  private maybeParseJson(value: unknown): unknown {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    if (!trimmed) return value;
    if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return value;
    try {
      return JSON.parse(trimmed);
    } catch (error) {
      logger.debug('TRANSCRIPT', 'Field looked like JSON but did not parse; using raw string', {
        preview: trimmed.slice(0, 120),
      }, error instanceof Error ? error : undefined);
      return value;
    }
  }

  private parseApplyPatchFiles(patch: string): string[] {
    const files: string[] = [];
    const lines = patch.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('*** Update File: ')) {
        files.push(trimmed.replace('*** Update File: ', '').trim());
      } else if (trimmed.startsWith('*** Add File: ')) {
        files.push(trimmed.replace('*** Add File: ', '').trim());
      } else if (trimmed.startsWith('*** Delete File: ')) {
        files.push(trimmed.replace('*** Delete File: ', '').trim());
      } else if (trimmed.startsWith('*** Move to: ')) {
        files.push(trimmed.replace('*** Move to: ', '').trim());
      } else if (trimmed.startsWith('+++ ')) {
        const path = trimmed.replace('+++ ', '').replace(/^b\//, '').trim();
        if (path && path !== '/dev/null') files.push(path);
      }
    }
    return Array.from(new Set(files));
  }

  private async handleSessionEnd(session: SessionState, watch: WatchTarget): Promise<void> {
    // A suppressed top-level session reaches here only to be cleaned up; its
    // summary and context belong to the native hooks, not the transcript watch.
    if (!watch.subagentOnly || session.isSubagent) {
      await this.queueSummary(session);
      await this.updateContext(session, watch);
    }
    session.pendingTools?.clear();
    const key = this.getSessionKey(watch, session.sessionId);
    this.sessions.delete(key);
  }

  private async queueSummary(session: SessionState): Promise<void> {
    const workerReady = await ensureWorkerRunning();
    if (!workerReady) return;

    const lastAssistantMessage = session.lastAssistantMessage ?? '';
    const requestBody = JSON.stringify({
      contentSessionId: session.sessionId,
      last_assistant_message: lastAssistantMessage,
      platformSource: session.platformSource,
      // Lets the worker skip a session in an excluded project; sent only when known.
      ...(session.cwd ? { cwd: session.cwd } : {}),
    });

    try {
      await workerHttpRequest('/api/sessions/summarize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: requestBody
      });
    } catch (error: unknown) {
      logger.warn('TRANSCRIPT', 'Summary request failed', {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async updateContext(session: SessionState, watch: WatchTarget): Promise<void> {
    if (!watch.context) return;
    if (watch.context.mode !== 'agents') return;
    if (shouldSuppressNativeCodexAgentsContext(watch)) return;

    const workerReady = await ensureWorkerRunning();
    if (!workerReady) return;

    const cwd = session.cwd ?? watch.workspace;
    if (!cwd) return;

    const context = getProjectContext(cwd);
    const projectsParam = context.allProjects.join(',');

    const contextUrl = `/api/context/inject?projects=${encodeURIComponent(projectsParam)}&platformSource=${encodeURIComponent(session.platformSource)}`;
    const agentsPath = expandHomePath(watch.context.path ?? `${cwd}/AGENTS.md`);

    const resolvedAgentsPath = path.resolve(agentsPath);
    const allowedRoots = [path.resolve(cwd), path.resolve(DATA_DIR)];
    const isPathSafe = allowedRoots.some(root => resolvedAgentsPath.startsWith(root + path.sep) || resolvedAgentsPath === root);
    if (!isPathSafe) {
      logger.warn('SECURITY', 'Rejected path traversal attempt in watch.context.path', {
        original: watch.context.path,
        resolved: resolvedAgentsPath,
        allowedRoots
      });
      return;
    }

    let response: Awaited<ReturnType<typeof workerHttpRequest>>;
    try {
      response = await workerHttpRequest(contextUrl);
    } catch (error: unknown) {
      logger.warn('TRANSCRIPT', 'Failed to fetch AGENTS.md context', {
        error: error instanceof Error ? error.message : String(error)
      });
      return;
    }

    if (!response.ok) return;

    const content = (await response.text()).trim();
    if (!content) return;

    writeAgentsMd(agentsPath, content);
    logger.debug('TRANSCRIPT', 'Updated AGENTS.md context', { agentsPath, watch: watch.name });
  }
}
