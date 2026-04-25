import path from 'path';
import { sessionInitHandler } from '../../cli/handlers/session-init.js';
import { fileEditHandler } from '../../cli/handlers/file-edit.js';
import { sessionCompleteHandler } from '../../cli/handlers/session-complete.js';
import { ensureWorkerRunning, workerHttpRequest } from '../../shared/worker-utils.js';
import { DATA_DIR } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';
import { getProjectContext } from '../../utils/project-name.js';
import { writeAgentsMd } from '../../utils/agents-md-utils.js';
import { resolveFieldSpec, resolveFields, matchesRule } from './field-utils.js';
import { expandHomePath } from './config.js';
import type { TranscriptSchema, WatchTarget, SchemaEvent } from './types.js';
import { normalizePlatformSource } from '../../shared/platform-source.js';
import { ingestObservation } from '../worker/http/shared.js';

interface SessionState {
  sessionId: string;
  platformSource: string;
  cwd?: string;
  project?: string;
  lastUserMessage?: string;
  lastAssistantMessage?: string;
  // In-memory pairing for transcript schemas (e.g. Codex) where tool_use
  // carries toolName + toolInput and tool_result only carries tool_use_id +
  // output. Keyed by toolId; consumed and deleted on the matching tool_result.
  pendingTools?: Map<string, { toolName: string; toolInput: unknown }>;
}

export class TranscriptEventProcessor {
  private sessions = new Map<string, SessionState>();

  async processEntry(
    entry: unknown,
    watch: WatchTarget,
    schema: TranscriptSchema,
    sessionIdOverride?: string | null
  ): Promise<void> {
    for (const event of schema.events) {
      if (!matchesRule(entry, event.match, schema)) continue;
      await this.handleEvent(entry, watch, schema, event, sessionIdOverride ?? undefined);
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
      };
      this.sessions.set(key, session);
    }
    return session;
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
    sessionIdOverride?: string
  ): Promise<void> {
    const sessionId = this.resolveSessionId(entry, watch, schema, event, sessionIdOverride);
    if (!sessionId) {
      logger.debug('TRANSCRIPT', 'Skipping event without sessionId', { event: event.name, watch: watch.name });
      return;
    }

    const session = this.getOrCreateSession(watch, sessionId);
    const cwd = this.resolveCwd(entry, watch, schema, event, session);
    if (cwd) session.cwd = cwd;
    const project = this.resolveProject(entry, watch, schema, event, session);
    if (project) session.project = project;

    const fields = resolveFields(event.fields, entry, { watch, schema, session: session as unknown as Record<string, unknown> });

    switch (event.action) {
      case 'session_context':
        this.applySessionContext(session, fields);
        break;
      case 'session_init':
        await this.handleSessionInit(session, fields);
        if (watch.context?.updateOn?.includes('session_start')) {
          await this.updateContext(session, watch);
        }
        break;
      case 'user_message':
        if (typeof fields.message === 'string') session.lastUserMessage = fields.message;
        if (typeof fields.prompt === 'string') session.lastUserMessage = fields.prompt;
        break;
      case 'assistant_message':
        if (typeof fields.message === 'string') session.lastAssistantMessage = fields.message;
        break;
      case 'tool_use':
        await this.handleToolUse(session, fields);
        break;
      case 'tool_result':
        await this.handleToolResult(session, fields);
        break;
      case 'observation':
        await this.sendObservation(session, fields);
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
  }

  private applySessionContext(session: SessionState, fields: Record<string, unknown>): void {
    const cwd = typeof fields.cwd === 'string' ? fields.cwd : undefined;
    const project = typeof fields.project === 'string' ? fields.project : undefined;
    if (cwd) session.cwd = cwd;
    if (project) session.project = project;
  }

  private async handleSessionInit(session: SessionState, fields: Record<string, unknown>): Promise<void> {
    const prompt = typeof fields.prompt === 'string' ? fields.prompt : '';
    const cwd = session.cwd ?? process.cwd();
    if (prompt) {
      session.lastUserMessage = prompt;
    }

    await sessionInitHandler.execute({
      sessionId: session.sessionId,
      cwd,
      prompt,
      platform: session.platformSource
    });
  }

  private async handleToolUse(session: SessionState, fields: Record<string, unknown>): Promise<void> {
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

    // Two schema shapes to support:
    //   1. Self-contained events (e.g. Claude JSONL): tool_use and tool_result
    //      both carry toolName; tool_use may already include toolResponse.
    //   2. Split events (e.g. Codex): tool_use carries toolName + toolInput,
    //      tool_result carries only toolUseId + output. Neither side alone
    //      has both toolName and toolResponse.
    //
    // For (1) we emit eagerly when toolResponse is present. For (2) we stash
    // toolName/toolInput on the session keyed by toolId so handleToolResult
    // can join them at tool_result time. The DB's
    // UNIQUE(content_session_id, tool_use_id) index collapses any duplicate
    // emissions that arise when both events carry a complete record.
    if (toolName && toolResponse !== undefined) {
      await this.sendObservation(session, {
        toolName,
        toolInput,
        toolResponse,
        toolUseId: toolId,
      });
    } else if (toolName && toolId) {
      if (!session.pendingTools) session.pendingTools = new Map();
      session.pendingTools.set(toolId, { toolName, toolInput });
    }
  }

  private async handleToolResult(session: SessionState, fields: Record<string, unknown>): Promise<void> {
    const toolId = typeof fields.toolId === 'string' ? fields.toolId : undefined;
    let toolName = typeof fields.toolName === 'string' ? fields.toolName : undefined;
    const toolResponse = this.maybeParseJson(fields.toolResponse);
    let toolInput = this.maybeParseJson(fields.toolInput);

    // Consume any pending-tool entry for this toolId regardless of whether the
    // tool_result already carries toolName: in the split-schema path the
    // result always resolves the pending entry, so leaving it behind would
    // grow the map until session end.
    if (toolId && session.pendingTools) {
      const pending = session.pendingTools.get(toolId);
      if (pending) {
        if (!toolName) toolName = pending.toolName;
        if (toolInput === undefined) toolInput = pending.toolInput;
        session.pendingTools.delete(toolId);
      }
    }

    if (toolName) {
      await this.sendObservation(session, {
        toolName,
        toolInput,
        toolResponse,
        toolUseId: toolId,
      });
    } else {
      logger.debug('TRANSCRIPT', 'Dropping tool_result with no resolvable toolName', {
        sessionId: session.sessionId,
        toolId,
      });
    }
  }

  private async sendObservation(session: SessionState, fields: Record<string, unknown>): Promise<void> {
    const toolName = typeof fields.toolName === 'string' ? fields.toolName : undefined;
    if (!toolName) return;

    // PATHFINDER plan 03 phase 7: replace HTTP loopback (worker → its own
    // /api/sessions/observations endpoint) with a direct in-process call to
    // ingestObservation. Same implementation backs the cross-process HTTP
    // route handler (one helper, N callers).
    const result = ingestObservation({
      contentSessionId: session.sessionId,
      cwd: session.cwd ?? process.cwd(),
      toolName,
      toolInput: this.maybeParseJson(fields.toolInput),
      toolResponse: this.maybeParseJson(fields.toolResponse),
      platformSource: session.platformSource,
      toolUseId: typeof fields.toolUseId === 'string' ? fields.toolUseId : undefined,
    });

    if (!result.ok) {
      throw new Error(`ingestObservation failed: ${result.reason}`);
    }
  }

  private async sendFileEdit(session: SessionState, fields: Record<string, unknown>): Promise<void> {
    const filePath = typeof fields.filePath === 'string' ? fields.filePath : undefined;
    if (!filePath) return;

    await fileEditHandler.execute({
      sessionId: session.sessionId,
      cwd: session.cwd ?? process.cwd(),
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
    // Pass through the raw string on parse failure rather than throwing.
    // Throwing from this helper propagates to `handleLine`'s outer catch,
    // which then silently drops the entire transcript line — including any
    // valid sibling fields. A single malformed JSON-shaped field should
    // degrade to opaque-string handling, not lose the whole observation.
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
    await this.queueSummary(session);
    await sessionCompleteHandler.execute({
      sessionId: session.sessionId,
      cwd: session.cwd ?? process.cwd(),
      platform: session.platformSource
    });
    await this.updateContext(session, watch);
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
      platformSource: session.platformSource
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

    const workerReady = await ensureWorkerRunning();
    if (!workerReady) return;

    const cwd = session.cwd ?? watch.workspace;
    if (!cwd) return;

    const context = getProjectContext(cwd);
    const projectsParam = context.allProjects.join(',');

    const contextUrl = `/api/context/inject?projects=${encodeURIComponent(projectsParam)}`;
    const agentsPath = expandHomePath(watch.context.path ?? `${cwd}/AGENTS.md`);

    // Validate resolved path stays within allowed directories (#1934)
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
