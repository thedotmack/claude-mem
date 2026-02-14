import { writeFile } from "fs/promises";
import { join } from "path";

// Minimal type declarations for the OpenClaw Plugin SDK.
// These match the real OpenClawPluginApi provided by the gateway at runtime.
// See: https://docs.openclaw.ai/plugin

interface PluginLogger {
  debug?: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

interface PluginServiceContext {
  config: Record<string, unknown>;
  workspaceDir?: string;
  stateDir: string;
  logger: PluginLogger;
}

interface PluginCommandContext {
  senderId?: string;
  channel: string;
  isAuthorizedSender: boolean;
  args?: string;
  commandBody: string;
  config: Record<string, unknown>;
}

type PluginCommandResult = string | { text: string } | { text: string; format?: string };

// OpenClaw event types for agent lifecycle
interface BeforeAgentStartEvent {
  prompt?: string;
}

interface ToolResultPersistEvent {
  toolName?: string;
  params?: Record<string, unknown>;
  message?: {
    content?: Array<{ type: string; text?: string }>;
  };
}

interface AgentEndEvent {
  messages?: Array<{
    role: string;
    content: string | Array<{ type: string; text?: string }>;
  }>;
}

interface SessionStartEvent {
  sessionId: string;
  resumedFrom?: string;
}

interface AfterCompactionEvent {
  messageCount: number;
  tokenCount?: number;
  compactedCount: number;
}

interface SessionEndEvent {
  sessionId: string;
  messageCount: number;
  durationMs?: number;
}

interface MessageReceivedEvent {
  from: string;
  content: string;
  timestamp?: number;
  metadata?: Record<string, unknown>;
}

interface EventContext {
  sessionKey?: string;
  workspaceDir?: string;
  agentId?: string;
}

interface MessageContext {
  channelId: string;
  accountId?: string;
  conversationId?: string;
}

type EventCallback<T> = (event: T, ctx: EventContext) => void | Promise<void>;
type MessageEventCallback<T> = (event: T, ctx: MessageContext) => void | Promise<void>;

interface OpenClawPluginApi {
  id: string;
  name: string;
  version?: string;
  source: string;
  config: Record<string, unknown>;
  pluginConfig?: Record<string, unknown>;
  logger: PluginLogger;
  registerService: (service: {
    id: string;
    start: (ctx: PluginServiceContext) => void | Promise<void>;
    stop?: (ctx: PluginServiceContext) => void | Promise<void>;
  }) => void;
  registerCommand: (command: {
    name: string;
    description: string;
    acceptsArgs?: boolean;
    requireAuth?: boolean;
    handler: (ctx: PluginCommandContext) => PluginCommandResult | Promise<PluginCommandResult>;
  }) => void;
  on: ((event: "before_agent_start", callback: EventCallback<BeforeAgentStartEvent>) => void) &
      ((event: "tool_result_persist", callback: EventCallback<ToolResultPersistEvent>) => void) &
      ((event: "agent_end", callback: EventCallback<AgentEndEvent>) => void) &
      ((event: "session_start", callback: EventCallback<SessionStartEvent>) => void) &
      ((event: "session_end", callback: EventCallback<SessionEndEvent>) => void) &
      ((event: "message_received", callback: MessageEventCallback<MessageReceivedEvent>) => void) &
      ((event: "after_compaction", callback: EventCallback<AfterCompactionEvent>) => void) &
      ((event: "gateway_start", callback: EventCallback<Record<string, never>>) => void);
  runtime: {
    channel: Record<string, Record<string, (...args: any[]) => Promise<any>>>;
  };
}

// ============================================================================
// SSE Observation Feed Types
// ============================================================================

interface ObservationSSEPayload {
  id: number;
  memory_session_id: string;
  session_id: string;
  type: string;
  title: string | null;
  subtitle: string | null;
  text: string | null;
  narrative: string | null;
  facts: string | null;
  concepts: string | null;
  files_read: string | null;
  files_modified: string | null;
  project: string | null;
  prompt_number: number;
  created_at_epoch: number;
}

interface SSENewObservationEvent {
  type: "new_observation";
  observation: ObservationSSEPayload;
  timestamp: number;
}

type ConnectionState = "disconnected" | "connected" | "reconnecting";

// ============================================================================
// Plugin Configuration
// ============================================================================

interface ClaudeMemPluginConfig {
  syncMemoryFile?: boolean;
  project?: string;
  workerPort?: number;
  observationFeed?: {
    enabled?: boolean;
    channel?: string;
    to?: string;
    botToken?: string;
  };
}

// ============================================================================
// Constants
// ============================================================================

const MAX_SSE_BUFFER_SIZE = 1024 * 1024; // 1MB
const DEFAULT_WORKER_PORT = 37777;
const MAX_TOOL_RESPONSE_CHARS = 1000;
const SESSION_TRACK_TTL_MS = 6 * 60 * 60 * 1000; // 6h
const MAX_TRACKED_SESSION_SCOPES = 500;
const GLOBAL_SESSION_SCOPE_KEY = "scope:global";

// Agent emoji map for observation feed messages.
// When creating a new OpenClaw agent, add its agentId and emoji here.
const AGENT_EMOJI_MAP: Record<string, string> = {
  "main":          "🦞",
  "openclaw":      "🦞",
  "devops":        "🔧",
  "architect":     "📐",
  "researcher":    "🔍",
  "code-reviewer": "🔎",
  "coder":         "💻",
  "tester":        "🧪",
  "debugger":      "🐛",
  "opsec":         "🛡️",
  "cloudfarm":     "☁️",
  "extractor":     "📦",
};

// Project prefixes that indicate Claude Code sessions (not OpenClaw agents)
const CLAUDE_CODE_EMOJI = "⌨️";
const OPENCLAW_DEFAULT_EMOJI = "🦀";

function normalizeScopePart(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function buildSessionScopeKey(params: {
  sessionKey?: string;
  conversationId?: string;
  channelId?: string;
  agentId?: string;
  sessionId?: string;
  accountId?: string;
  workspaceDir?: string;
}): string {
  const sessionKey = normalizeScopePart(params.sessionKey);
  if (sessionKey) return `session:${sessionKey}`;

  const conversationId = normalizeScopePart(params.conversationId);
  if (conversationId) return `conversation:${conversationId}`;

  const channelId = normalizeScopePart(params.channelId);
  if (channelId) return `channel:${channelId}`;

  const sessionId = normalizeScopePart(params.sessionId);
  if (sessionId) return `session-id:${sessionId}`;

  const agentId = normalizeScopePart(params.agentId);
  if (agentId) return `agent:${agentId}`;

  const accountId = normalizeScopePart(params.accountId);
  if (accountId) return `account:${accountId}`;

  const workspaceDir = normalizeScopePart(params.workspaceDir);
  if (workspaceDir) return `workspace:${workspaceDir}`;

  return GLOBAL_SESSION_SCOPE_KEY;
}

function buildContentSessionId(scopeKey: string): string {
  const safeScope = scopeKey.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "scope";
  return `openclaw-${safeScope}-${Date.now()}`;
}

function getSourceLabel(project: string | null | undefined): string {
  if (!project) return OPENCLAW_DEFAULT_EMOJI;
  // OpenClaw agent projects are formatted as "openclaw-<agentId>"
  if (project.startsWith("openclaw-")) {
    const agentId = project.slice("openclaw-".length);
    const emoji = AGENT_EMOJI_MAP[agentId] || OPENCLAW_DEFAULT_EMOJI;
    return `${emoji} ${agentId}`;
  }
  // OpenClaw project without agent suffix
  if (project === "openclaw") {
    return `🦞 openclaw`;
  }
  // Everything else is from Claude Code (project = working directory name)
  const emoji = CLAUDE_CODE_EMOJI;
  return `${emoji} ${project}`;
}

// ============================================================================
// Worker HTTP Client
// ============================================================================

function workerBaseUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

async function workerPost(
  port: number,
  path: string,
  body: Record<string, unknown>,
  logger: PluginLogger
): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(`${workerBaseUrl(port)}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      logger.warn(`[claude-mem] Worker POST ${path} returned ${response.status}`);
      return null;
    }
    return (await response.json()) as Record<string, unknown>;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`[claude-mem] Worker POST ${path} failed: ${message}`);
    return null;
  }
}

function workerPostFireAndForget(
  port: number,
  path: string,
  body: Record<string, unknown>,
  logger: PluginLogger
): void {
  fetch(`${workerBaseUrl(port)}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`[claude-mem] Worker POST ${path} failed: ${message}`);
  });
}

async function workerGetText(
  port: number,
  path: string,
  logger: PluginLogger
): Promise<string | null> {
  try {
    const response = await fetch(`${workerBaseUrl(port)}${path}`);
    if (!response.ok) {
      logger.warn(`[claude-mem] Worker GET ${path} returned ${response.status}`);
      return null;
    }
    return await response.text();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`[claude-mem] Worker GET ${path} failed: ${message}`);
    return null;
  }
}

// ============================================================================
// SSE Observation Feed
// ============================================================================

function formatObservationMessage(observation: ObservationSSEPayload): string {
  const title = observation.title || "Untitled";
  const source = getSourceLabel(observation.project);
  let message = `${source}\n**${title}**`;
  if (observation.subtitle) {
    message += `\n${observation.subtitle}`;
  }
  return message;
}

// Explicit mapping from channel name to [runtime namespace key, send function name].
// These match the PluginRuntime.channel structure in the OpenClaw SDK.
const CHANNEL_SEND_MAP: Record<string, { namespace: string; functionName: string }> = {
  telegram: { namespace: "telegram", functionName: "sendMessageTelegram" },
  whatsapp: { namespace: "whatsapp", functionName: "sendMessageWhatsApp" },
  discord: { namespace: "discord", functionName: "sendMessageDiscord" },
  slack: { namespace: "slack", functionName: "sendMessageSlack" },
  signal: { namespace: "signal", functionName: "sendMessageSignal" },
  imessage: { namespace: "imessage", functionName: "sendMessageIMessage" },
  line: { namespace: "line", functionName: "sendMessageLine" },
};

async function sendDirectTelegram(
  botToken: string,
  chatId: string,
  text: string,
  logger: PluginLogger
): Promise<void> {
  try {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "Markdown",
      }),
    });
    if (!response.ok) {
      const body = await response.text();
      logger.warn(`[claude-mem] Direct Telegram send failed (${response.status}): ${body}`);
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`[claude-mem] Direct Telegram send error: ${message}`);
  }
}

function sendToChannel(
  api: OpenClawPluginApi,
  channel: string,
  to: string,
  text: string,
  botToken?: string
): Promise<void> {
  // If a dedicated bot token is provided for Telegram, send directly
  if (botToken && channel === "telegram") {
    return sendDirectTelegram(botToken, to, text, api.logger);
  }

  const mapping = CHANNEL_SEND_MAP[channel];
  if (!mapping) {
    api.logger.warn(`[claude-mem] Unsupported channel type: ${channel}`);
    return Promise.resolve();
  }

  const channelApi = api.runtime.channel[mapping.namespace];
  if (!channelApi) {
    api.logger.warn(`[claude-mem] Channel "${channel}" not available in runtime`);
    return Promise.resolve();
  }

  const senderFunction = channelApi[mapping.functionName];
  if (!senderFunction) {
    api.logger.warn(`[claude-mem] Channel "${channel}" has no ${mapping.functionName} function`);
    return Promise.resolve();
  }

  // WhatsApp requires a third options argument with { verbose: boolean }
  const args: unknown[] = channel === "whatsapp"
    ? [to, text, { verbose: false }]
    : [to, text];

  return senderFunction(...args).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    api.logger.error(`[claude-mem] Failed to send to ${channel}: ${message}`);
  });
}

async function connectToSSEStream(
  api: OpenClawPluginApi,
  port: number,
  channel: string,
  to: string,
  abortController: AbortController,
  setConnectionState: (state: ConnectionState) => void,
  botToken?: string
): Promise<void> {
  let backoffMs = 1000;
  const maxBackoffMs = 30000;

  while (!abortController.signal.aborted) {
    try {
      setConnectionState("reconnecting");
      api.logger.info(`[claude-mem] Connecting to SSE stream at ${workerBaseUrl(port)}/stream`);

      const response = await fetch(`${workerBaseUrl(port)}/stream`, {
        signal: abortController.signal,
        headers: { Accept: "text/event-stream" },
      });

      if (!response.ok) {
        throw new Error(`SSE stream returned HTTP ${response.status}`);
      }

      if (!response.body) {
        throw new Error("SSE stream response has no body");
      }

      setConnectionState("connected");
      backoffMs = 1000;
      api.logger.info("[claude-mem] Connected to SSE stream");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        if (buffer.length > MAX_SSE_BUFFER_SIZE) {
          api.logger.warn("[claude-mem] SSE buffer overflow, clearing buffer");
          buffer = "";
        }

        const frames = buffer.split("\n\n");
        buffer = frames.pop() || "";

        for (const frame of frames) {
          // SSE spec: concatenate all data: lines with \n
          const dataLines = frame
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trim());
          if (dataLines.length === 0) continue;

          const jsonStr = dataLines.join("\n");
          if (!jsonStr) continue;

          try {
            const parsed = JSON.parse(jsonStr);
            if (parsed.type === "new_observation" && parsed.observation) {
              const event = parsed as SSENewObservationEvent;
              const message = formatObservationMessage(event.observation);
              await sendToChannel(api, channel, to, message, botToken);
            }
          } catch (parseError: unknown) {
            const errorMessage = parseError instanceof Error ? parseError.message : String(parseError);
            api.logger.warn(`[claude-mem] Failed to parse SSE frame: ${errorMessage}`);
          }
        }
      }
    } catch (error: unknown) {
      if (abortController.signal.aborted) {
        break;
      }
      setConnectionState("reconnecting");
      const errorMessage = error instanceof Error ? error.message : String(error);
      api.logger.warn(`[claude-mem] SSE stream error: ${errorMessage}. Reconnecting in ${backoffMs / 1000}s`);
    }

    if (abortController.signal.aborted) break;

    await new Promise((resolve) => setTimeout(resolve, backoffMs));
    backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
  }

  setConnectionState("disconnected");
}

// ============================================================================
// Plugin Entry Point
// ============================================================================

export default function claudeMemPlugin(api: OpenClawPluginApi): void {
  const userConfig = (api.pluginConfig || {}) as ClaudeMemPluginConfig;
  const workerPort = userConfig.workerPort || DEFAULT_WORKER_PORT;
  const baseProjectName = userConfig.project || "openclaw";

  function getProjectName(ctx: EventContext): string {
    if (ctx.agentId) {
      return `openclaw-${ctx.agentId}`;
    }
    return baseProjectName;
  }

  // ------------------------------------------------------------------
  // Session tracking for observation I/O
  // ------------------------------------------------------------------
  const sessionIds = new Map<string, string>();
  const workspaceDirsBySessionKey = new Map<string, string>();
  const sessionLastTouchedAt = new Map<string, number>();
  const sessionTouchOrder = new Map<string, number>();
  let nextSessionTouchOrder = 0;
  const runtimeSessionIdToScopeKey = new Map<string, string>();
  let hasLoggedGlobalScopeFallback = false;
  const syncMemoryFile = userConfig.syncMemoryFile !== false; // default true

  function clearSessionScope(scopeKey: string): void {
    sessionIds.delete(scopeKey);
    workspaceDirsBySessionKey.delete(scopeKey);
    sessionLastTouchedAt.delete(scopeKey);
    sessionTouchOrder.delete(scopeKey);
    for (const [runtimeSessionId, mappedScopeKey] of runtimeSessionIdToScopeKey) {
      if (mappedScopeKey === scopeKey) {
        runtimeSessionIdToScopeKey.delete(runtimeSessionId);
      }
    }
  }

  function pruneSessionTracking(now: number = Date.now()): void {
    for (const [scopeKey, lastTouched] of sessionLastTouchedAt) {
      if (now - lastTouched > SESSION_TRACK_TTL_MS) {
        clearSessionScope(scopeKey);
      }
    }

    if (sessionLastTouchedAt.size > MAX_TRACKED_SESSION_SCOPES) {
      const oldestScopes = [...sessionLastTouchedAt.keys()]
        .sort((a, b) => {
          const aTouched = sessionLastTouchedAt.get(a) ?? 0;
          const bTouched = sessionLastTouchedAt.get(b) ?? 0;
          if (aTouched !== bTouched) {
            return aTouched - bTouched;
          }
          const aOrder = sessionTouchOrder.get(a) ?? 0;
          const bOrder = sessionTouchOrder.get(b) ?? 0;
          return aOrder - bOrder;
        })
        .slice(0, sessionLastTouchedAt.size - MAX_TRACKED_SESSION_SCOPES);

      for (const scopeKey of oldestScopes) {
        clearSessionScope(scopeKey);
      }
    }
  }

  function touchSessionScope(scopeKey: string, now: number = Date.now()): void {
    sessionLastTouchedAt.set(scopeKey, now);
    nextSessionTouchOrder += 1;
    sessionTouchOrder.set(scopeKey, nextSessionTouchOrder);
  }

  function rememberRuntimeSessionScope(sessionId: string | undefined, scopeKey: string): void {
    const normalizedSessionId = normalizeScopePart(sessionId);
    if (!normalizedSessionId) return;
    runtimeSessionIdToScopeKey.set(normalizedSessionId, scopeKey);
  }

  function resolveSessionEndScopeKeys(event: SessionEndEvent, ctx: EventContext): string[] {
    const scopeKeys = new Set<string>();
    scopeKeys.add(resolveEventScopeKey(ctx, event.sessionId));

    const normalizedSessionId = normalizeScopePart(event.sessionId);
    if (normalizedSessionId) {
      const mappedScopeKey = runtimeSessionIdToScopeKey.get(normalizedSessionId);
      if (mappedScopeKey) {
        scopeKeys.add(mappedScopeKey);
      }
    }

    return [...scopeKeys];
  }

  function resolveEventScopeKey(ctx: EventContext, eventSessionId?: string): string {
    return buildSessionScopeKey({
      sessionKey: ctx.sessionKey,
      agentId: ctx.agentId,
      sessionId: eventSessionId,
      workspaceDir: ctx.workspaceDir,
    });
  }

  function resolveMessageScopeKey(ctx: MessageContext): string {
    return buildSessionScopeKey({
      conversationId: ctx.conversationId,
      channelId: ctx.channelId,
      accountId: ctx.accountId,
    });
  }

  function getContentSessionId(scopeKey: string, sourceEvent: string): string {
    const now = Date.now();
    pruneSessionTracking(now);
    touchSessionScope(scopeKey, now);

    if (scopeKey === GLOBAL_SESSION_SCOPE_KEY && !hasLoggedGlobalScopeFallback) {
      hasLoggedGlobalScopeFallback = true;
      api.logger.warn(`[claude-mem] Session scope fallback to "${GLOBAL_SESSION_SCOPE_KEY}" during ${sourceEvent}; missing identifiers may cause unrelated events to share memory context`);
    }

    if (!sessionIds.has(scopeKey)) {
      sessionIds.set(scopeKey, buildContentSessionId(scopeKey));
    }

    // Enforce hard cap after touching/creating this scope.
    pruneSessionTracking(now);

    return sessionIds.get(scopeKey)!;
  }

  async function syncMemoryToWorkspace(workspaceDir: string, ctx?: EventContext): Promise<void> {
    // Include both the base project and agent-scoped project (e.g. "openclaw" + "openclaw-main")
    const projects = [baseProjectName];
    const agentProject = ctx ? getProjectName(ctx) : null;
    if (agentProject && agentProject !== baseProjectName) {
      projects.push(agentProject);
    }
    const contextText = await workerGetText(
      workerPort,
      `/api/context/inject?projects=${encodeURIComponent(projects.join(","))}`,
      api.logger
    );
    if (contextText && contextText.trim().length > 0) {
      try {
        await writeFile(join(workspaceDir, "MEMORY.md"), contextText, "utf-8");
        api.logger.info(`[claude-mem] MEMORY.md synced to ${workspaceDir}`);
      } catch (writeError: unknown) {
        const msg = writeError instanceof Error ? writeError.message : String(writeError);
        api.logger.warn(`[claude-mem] Failed to write MEMORY.md: ${msg}`);
      }
    }
  }

  // ------------------------------------------------------------------
  // Event: session_start — init claude-mem session (fires on /new, /reset)
  // ------------------------------------------------------------------
  api.on("session_start", async (event, ctx) => {
    const sessionScopeKey = resolveEventScopeKey(ctx, event.sessionId);
    rememberRuntimeSessionScope(event.sessionId, sessionScopeKey);
    const contentSessionId = getContentSessionId(sessionScopeKey, "session_start");

    await workerPost(workerPort, "/api/sessions/init", {
      contentSessionId,
      project: getProjectName(ctx),
      prompt: "",
    }, api.logger);

    api.logger.info(`[claude-mem] Session initialized: ${contentSessionId}`);
  });

  // ------------------------------------------------------------------
  // Event: message_received — capture inbound user prompts from channels
  // ------------------------------------------------------------------
  api.on("message_received", async (event, ctx) => {
    const sessionScopeKey = resolveMessageScopeKey(ctx);
    const contentSessionId = getContentSessionId(sessionScopeKey, "message_received");

    await workerPost(workerPort, "/api/sessions/init", {
      contentSessionId,
      project: baseProjectName,
      prompt: event.content || "[media prompt]",
    }, api.logger);
  });

  // ------------------------------------------------------------------
  // Event: after_compaction — re-init session after context compaction
  // ------------------------------------------------------------------
  api.on("after_compaction", async (_event, ctx) => {
    const sessionScopeKey = resolveEventScopeKey(ctx);
    const contentSessionId = getContentSessionId(sessionScopeKey, "after_compaction");

    await workerPost(workerPort, "/api/sessions/init", {
      contentSessionId,
      project: getProjectName(ctx),
      prompt: "",
    }, api.logger);

    api.logger.info(`[claude-mem] Session re-initialized after compaction: ${contentSessionId}`);
  });

  // ------------------------------------------------------------------
  // Event: before_agent_start — init session + sync MEMORY.md + track workspace
  // ------------------------------------------------------------------
  api.on("before_agent_start", async (event, ctx) => {
    const sessionScopeKey = resolveEventScopeKey(ctx);

    // Track workspace dir so tool_result_persist can sync MEMORY.md later
    if (ctx.workspaceDir) {
      workspaceDirsBySessionKey.set(sessionScopeKey, ctx.workspaceDir);
      touchSessionScope(sessionScopeKey);
    }

    // Initialize session in the worker so observations are not skipped
    // (the privacy check requires a stored user prompt to exist)
    const contentSessionId = getContentSessionId(sessionScopeKey, "before_agent_start");
    await workerPost(workerPort, "/api/sessions/init", {
      contentSessionId,
      project: getProjectName(ctx),
      prompt: event.prompt || "agent run",
    }, api.logger);

    // Sync MEMORY.md before agent runs (provides context to agent)
    if (syncMemoryFile && ctx.workspaceDir) {
      await syncMemoryToWorkspace(ctx.workspaceDir, ctx);
    }
  });

  // ------------------------------------------------------------------
  // Event: tool_result_persist — record tool observations + sync MEMORY.md
  // ------------------------------------------------------------------
  api.on("tool_result_persist", (event, ctx) => {
    api.logger.info(`[claude-mem] tool_result_persist fired: tool=${event.toolName ?? "unknown"} agent=${ctx.agentId ?? "none"} session=${ctx.sessionKey ?? "none"}`);
    const toolName = event.toolName;
    if (!toolName) return;
    if (toolName.startsWith("memory_")) return;

    const sessionScopeKey = resolveEventScopeKey(ctx);
    const contentSessionId = getContentSessionId(sessionScopeKey, "tool_result_persist");

    // Extract result text from all content blocks
    let toolResponseText = "";
    const content = event.message?.content;
    if (Array.isArray(content)) {
      toolResponseText = content
        .filter((block) => (block.type === "tool_result" || block.type === "text") && "text" in block)
        .map((block) => String(block.text))
        .join("\n");
    }
    if (toolResponseText.length > MAX_TOOL_RESPONSE_CHARS) {
      toolResponseText = toolResponseText.slice(0, MAX_TOOL_RESPONSE_CHARS);
    }

    // Fire-and-forget: send observation + sync MEMORY.md in parallel
    workerPostFireAndForget(workerPort, "/api/sessions/observations", {
      contentSessionId,
      tool_name: toolName,
      tool_input: event.params || {},
      tool_response: toolResponseText,
      cwd: "",
    }, api.logger);

    const workspaceDir = ctx.workspaceDir || workspaceDirsBySessionKey.get(sessionScopeKey);
    if (syncMemoryFile && workspaceDir) {
      syncMemoryToWorkspace(workspaceDir, ctx);
    }
  });

  // ------------------------------------------------------------------
  // Event: agent_end — summarize and complete session
  // ------------------------------------------------------------------
  api.on("agent_end", async (event, ctx) => {
    const sessionScopeKey = resolveEventScopeKey(ctx);
    const contentSessionId = getContentSessionId(sessionScopeKey, "agent_end");

    // Extract last assistant message for summarization
    let lastAssistantMessage = "";
    if (Array.isArray(event.messages)) {
      for (let i = event.messages.length - 1; i >= 0; i--) {
        const message = event.messages[i];
        if (message?.role === "assistant") {
          if (typeof message.content === "string") {
            lastAssistantMessage = message.content;
          } else if (Array.isArray(message.content)) {
            lastAssistantMessage = message.content
              .filter((block) => block.type === "text")
              .map((block) => block.text || "")
              .join("\n");
          }
          break;
        }
      }
    }

    // Await summarize so the worker receives it before complete.
    // This also gives in-flight tool_result_persist observations time to arrive
    // (they use fire-and-forget and may still be in transit).
    await workerPost(workerPort, "/api/sessions/summarize", {
      contentSessionId,
      last_assistant_message: lastAssistantMessage,
    }, api.logger);

    workerPostFireAndForget(workerPort, "/api/sessions/complete", {
      contentSessionId,
    }, api.logger);
  });

  // ------------------------------------------------------------------
  // Event: session_end — clean up session tracking to prevent unbounded growth
  // ------------------------------------------------------------------
  api.on("session_end", async (event, ctx) => {
    const scopeKeys = resolveSessionEndScopeKeys(event, ctx);
    for (const scopeKey of scopeKeys) {
      clearSessionScope(scopeKey);
    }
  });

  // ------------------------------------------------------------------
  // Event: gateway_start — clear session tracking for fresh start
  // ------------------------------------------------------------------
  api.on("gateway_start", async () => {
    workspaceDirsBySessionKey.clear();
    sessionIds.clear();
    sessionLastTouchedAt.clear();
    sessionTouchOrder.clear();
    nextSessionTouchOrder = 0;
    runtimeSessionIdToScopeKey.clear();
    hasLoggedGlobalScopeFallback = false;
    api.logger.info("[claude-mem] Gateway started — session tracking reset");
  });

  // ------------------------------------------------------------------
  // Service: SSE observation feed → messaging channels
  // ------------------------------------------------------------------
  let sseAbortController: AbortController | null = null;
  let connectionState: ConnectionState = "disconnected";
  let connectionPromise: Promise<void> | null = null;

  api.registerService({
    id: "claude-mem-observation-feed",
    start: async (_ctx) => {
      if (sseAbortController) {
        sseAbortController.abort();
        if (connectionPromise) {
          await connectionPromise;
          connectionPromise = null;
        }
      }

      const feedConfig = userConfig.observationFeed;

      if (!feedConfig?.enabled) {
        api.logger.info("[claude-mem] Observation feed disabled");
        return;
      }

      if (!feedConfig.channel || !feedConfig.to) {
        api.logger.warn("[claude-mem] Observation feed misconfigured — channel or target missing");
        return;
      }

      api.logger.info(`[claude-mem] Observation feed starting — channel: ${feedConfig.channel}, target: ${feedConfig.to}`);

      sseAbortController = new AbortController();
      connectionPromise = connectToSSEStream(
        api,
        workerPort,
        feedConfig.channel,
        feedConfig.to,
        sseAbortController,
        (state) => { connectionState = state; },
        feedConfig.botToken
      );
    },
    stop: async (_ctx) => {
      if (sseAbortController) {
        sseAbortController.abort();
        sseAbortController = null;
      }
      if (connectionPromise) {
        await connectionPromise;
        connectionPromise = null;
      }
      connectionState = "disconnected";
      api.logger.info("[claude-mem] Observation feed stopped — SSE connection closed");
    },
  });

  // ------------------------------------------------------------------
  // Command: /claude-mem-feed — status & toggle
  // ------------------------------------------------------------------
  api.registerCommand({
    name: "claude-mem-feed",
    description: "Show or toggle Claude-Mem observation feed status",
    acceptsArgs: true,
    handler: async (ctx) => {
      const feedConfig = userConfig.observationFeed;

      if (!feedConfig) {
        return "Observation feed not configured. Add observationFeed to your plugin config.";
      }

      const arg = ctx.args?.trim();

      if (arg === "on") {
        api.logger.info("[claude-mem] Feed enable requested via command");
        return "Feed enable requested. Update observationFeed.enabled in your plugin config to persist.";
      }

      if (arg === "off") {
        api.logger.info("[claude-mem] Feed disable requested via command");
        return "Feed disable requested. Update observationFeed.enabled in your plugin config to persist.";
      }

      return [
        "Claude-Mem Observation Feed",
        `Enabled: ${feedConfig.enabled ? "yes" : "no"}`,
        `Channel: ${feedConfig.channel || "not set"}`,
        `Target: ${feedConfig.to || "not set"}`,
        `Connection: ${connectionState}`,
      ].join("\n");
    },
  });

  // ------------------------------------------------------------------
  // Command: /claude-mem-status — worker health check
  // ------------------------------------------------------------------
  api.registerCommand({
    name: "claude-mem-status",
    description: "Check Claude-Mem worker health and session status",
    handler: async () => {
      const healthText = await workerGetText(workerPort, "/api/health", api.logger);
      if (!healthText) {
        return `Claude-Mem worker unreachable at port ${workerPort}`;
      }

      try {
        const health = JSON.parse(healthText);
        return [
          "Claude-Mem Worker Status",
          `Status: ${health.status || "unknown"}`,
          `Port: ${workerPort}`,
          `Active sessions: ${sessionIds.size}`,
          `Observation feed: ${connectionState}`,
        ].join("\n");
      } catch {
        return `Claude-Mem worker responded but returned unexpected data`;
      }
    },
  });

  api.logger.info(`[claude-mem] OpenClaw plugin loaded — v1.0.0 (worker: 127.0.0.1:${workerPort})`);
}
