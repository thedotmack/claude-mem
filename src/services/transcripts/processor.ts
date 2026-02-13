import { sessionInitHandler } from '../../cli/handlers/session-init.js';
import { observationHandler } from '../../cli/handlers/observation.js';
import { fileEditHandler } from '../../cli/handlers/file-edit.js';
import { sessionCompleteHandler } from '../../cli/handlers/session-complete.js';
import { ensureWorkerRunning, getWorkerPort } from '../../shared/worker-utils.js';
import { logger } from '../../utils/logger.js';
import { getProjectContext, getProjectName } from '../../utils/project-name.js';
import { writeAgentsMd } from '../../utils/agents-md-utils.js';
import { resolveFieldSpec, resolveFields, matchesRule } from './field-utils.js';
import { expandHomePath } from './config.js';
import type { TranscriptSchema, WatchTarget, SchemaEvent } from './types.js';

interface SessionState {
  sessionId: string;
  cwd?: string;
  project?: string;
  lastUserMessage?: string;
  lastAssistantMessage?: string;
  pendingTools: Map<string, { name?: string; input?: unknown }>;
}

interface PendingTool {
  id?: string;
  name?: string;
  input?: unknown;
  response?: unknown;
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
        pendingTools: new Map()
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
    if (session.cwd) return getProjectName(session.cwd);
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

    const fields = resolveFields(event.fields, entry, { watch, schema, session });

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
      platform: 'transcript'
    });
  }

  private async handleToolUse(session: SessionState, fields: Record<string, unknown>): Promise<void> {
    const toolId = typeof fields.toolId === 'string' ? fields.toolId : undefined;
    const toolName = typeof fields.toolName === 'string' ? fields.toolName : undefined;
    const toolInput = this.maybeParseJson(fields.toolInput);
    const toolResponse = this.maybeParseJson(fields.toolResponse);

    const pending: PendingTool = { id: toolId, name: toolName, input: toolInput, response: toolResponse };

    if (toolId) {
      session.pendingTools.set(toolId, { name: pending.name, input: pending.input });
    }

    if (toolName === 'apply_patch' && typeof toolInput === 'string') {
      const files = this.parseApplyPatchFiles(toolInput);
      for (const filePath of files) {
        await this.sendFileEdit(session, {
          filePath,
          edits: [{ type: 'apply_patch', patch: toolInput }]
        });
      }
    }

    if (toolResponse !== undefined && toolName) {
      await this.sendObservation(session, {
        toolName,
        toolInput,
        toolResponse
      });
    }
  }

  private async handleToolResult(session: SessionState, fields: Record<string, unknown>): Promise<void> {
    const toolId = typeof fields.toolId === 'string' ? fields.toolId : undefined;
    const toolName = typeof fields.toolName === 'string' ? fields.toolName : undefined;
    const toolResponse = this.maybeParseJson(fields.toolResponse);

    let toolInput: unknown = this.maybeParseJson(fields.toolInput);
    let name = toolName;

    if (toolId && session.pendingTools.has(toolId)) {
      const pending = session.pendingTools.get(toolId)!;
      toolInput = pending.input ?? toolInput;
      name = name ?? pending.name;
      session.pendingTools.delete(toolId);
    }

    if (name) {
      await this.sendObservation(session, {
        toolName: name,
        toolInput,
        toolResponse
      });
    }
  }

  private async sendObservation(session: SessionState, fields: Record<string, unknown>): Promise<void> {
    const toolName = typeof fields.toolName === 'string' ? fields.toolName : undefined;
    if (!toolName) return;

    await observationHandler.execute({
      sessionId: session.sessionId,
      cwd: session.cwd ?? process.cwd(),
      toolName,
      toolInput: this.maybeParseJson(fields.toolInput),
      toolResponse: this.maybeParseJson(fields.toolResponse),
      platform: 'transcript'
    });
  }

  private async sendFileEdit(session: SessionState, fields: Record<string, unknown>): Promise<void> {
    const filePath = typeof fields.filePath === 'string' ? fields.filePath : undefined;
    if (!filePath) return;

    await fileEditHandler.execute({
      sessionId: session.sessionId,
      cwd: session.cwd ?? process.cwd(),
      filePath,
      edits: Array.isArray(fields.edits) ? fields.edits : undefined,
      platform: 'transcript'
    });
  }

  private maybeParseJson(value: unknown): unknown {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    if (!trimmed) return value;
    if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return value;
    try {
      return JSON.parse(trimmed);
    } catch {
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
      platform: 'transcript'
    });
    await this.updateContext(session, watch);
    session.pendingTools.clear();
    const key = this.getSessionKey(watch, session.sessionId);
    this.sessions.delete(key);
  }

  private async queueSummary(session: SessionState): Promise<void> {
    const workerReady = await ensureWorkerRunning();
    if (!workerReady) return;

    const port = getWorkerPort();
    const lastAssistantMessage = session.lastAssistantMessage ?? '';

    try {
      await fetch(`http://127.0.0.1:${port}/api/sessions/summarize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contentSessionId: session.sessionId,
          last_assistant_message: lastAssistantMessage
        })
      });
    } catch (error) {
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
    const port = getWorkerPort();

    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/api/context/inject?projects=${encodeURIComponent(projectsParam)}`
      );
      if (!response.ok) return;

      const content = (await response.text()).trim();
      if (!content) return;

      const agentsPath = expandHomePath(watch.context.path ?? `${cwd}/AGENTS.md`);
      writeAgentsMd(agentsPath, content);
      logger.debug('TRANSCRIPT', 'Updated AGENTS.md context', { agentsPath, watch: watch.name });
    } catch (error) {
      logger.warn('TRANSCRIPT', 'Failed to update AGENTS.md context', {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
}
