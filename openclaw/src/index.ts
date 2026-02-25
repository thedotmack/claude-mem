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

interface FeedEmojiConfig {
  primary?: string;
  claudeCode?: string;
  claudeCodeLabel?: string;
  default?: string;
  agents?: Record<string, string>;
}

interface ClaudeMemPluginConfig {
  syncMemoryFile?: boolean;
  project?: string;
  workerPort?: number;
  observationFeed?: {
    enabled?: boolean;
    channel?: string;
    to?: string;
    botToken?: string;
    emojis?: FeedEmojiConfig;
  };
}

// ============================================================================
// Constants
// ============================================================================

const MAX_SSE_BUFFER_SIZE = 1024 * 1024; // 1MB
const DEFAULT_WORKER_PORT = 37777;

// Emoji pool for deterministic auto-assignment to unknown agents.
// Uses a hash of the agentId to pick a consistent emoji — no persistent state needed.
const EMOJI_POOL = [
  "🔧","📐","🔍","💻","🧪","🐛","🛡️","☁️","📦","🎯",
  "🔮","⚡","🌊","🎨","📊","🚀","🔬","🏗️","📝","🎭",
];

function poolEmojiForAgent(agentId: string): string {
  let hash = 0;
  for (let i = 0; i < agentId.length; i++) {
    hash = ((hash << 5) - hash + agentId.charCodeAt(i)) | 0;
  }
  return EMOJI_POOL[Math.abs(hash) % EMOJI_POOL.length];
}

// Default emoji values — overridden by user config via observationFeed.emojis
const DEFAULT_PRIMARY_EMOJI = "🦞";
const DEFAULT_CLAUDE_CODE_EMOJI = "⌨️";
const DEFAULT_CLAUDE_CODE_LABEL = "Claude Code Session";
const DEFAULT_FALLBACK_EMOJI = "🦀";

function buildGetSourceLabel(
  emojiConfig: FeedEmojiConfig | undefined
): (project: string | null | undefined) => string {
  const primary = emojiConfig?.primary ?? DEFAULT_PRIMARY_EMOJI;
  const claudeCode = emojiConfig?.claudeCode ?? DEFAULT_CLAUDE_CODE_EMOJI;
  const claudeCodeLabel = emojiConfig?.claudeCodeLabel ?? DEFAULT_CLAUDE_CODE_LABEL;
  const fallback = emojiConfig?.default ?? DEFAULT_FALLBACK_EMOJI;
  const pinnedAgents = emojiConfig?.agents ?? {};

  return function getSourceLabel(project: string | null | undefined): string {
    if (!project) return fallback;
    // OpenClaw agent projects are formatted as "openclaw-<agentId>"
    if (project.startsWith("openclaw-")) {
      const agentId = project.slice("openclaw-".length);
      if (!agentId) return `${primary} openclaw`;
      const emoji = pinnedAgents[agentId] || poolEmojiForAgent(agentId);
      return `${emoji} ${agentId}`;
    }
    // OpenClaw project without agent suffix
    if (project === "openclaw") {
      return `${primary} openclaw`;
    }
    // Everything else is a Claude Code session. Keep the project identifier
    // visible so concurrent sessions can be distinguished in the feed.
    const trimmedLabel = claudeCodeLabel.trim();
    if (!trimmedLabel) {
      return `${claudeCode} ${project}`;
    }
    return `${claudeCode} ${trimmedLabel} (${project})`;
  };
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

async function workerGetJson(
  port: number,
  path: string,
  logger: PluginLogger
): Promise<Record<string, unknown> | null> {
  const text = await workerGetText(port, path, logger);
  if (!text) return null;

  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    logger.warn(`[claude-mem] Worker GET ${path} returned non-JSON response`);
    return null;
  }
}

// ============================================================================
// SSE Observation Feed
// ============================================================================

function formatObservationMessage(
  observation: ObservationSSEPayload,
  getSourceLabel: (project: string | null | undefined) => string,
): string {
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
  getSourceLabel: (project: string | null | undefined) => string,
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
              const message = formatObservationMessage(event.observation, getSourceLabel);
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
  const getSourceLabel = buildGetSourceLabel(userConfig.observationFeed?.emojis);

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
  const syncMemoryFile = userConfig.syncMemoryFile !== false; // default true

  function getContentSessionId(sessionKey?: string): string {
    const key = sessionKey || "default";
    if (!sessionIds.has(key)) {
      sessionIds.set(key, `openclaw-${key}-${Date.now()}`);
    }
    return sessionIds.get(key)!;
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
  api.on("session_start", async (_event, ctx) => {
    const contentSessionId = getContentSessionId(ctx.sessionKey);

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
    const sessionKey = ctx.conversationId || ctx.channelId || "default";
    const contentSessionId = getContentSessionId(sessionKey);

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
    const contentSessionId = getContentSessionId(ctx.sessionKey);

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
    // Track workspace dir so tool_result_persist can sync MEMORY.md later
    if (ctx.workspaceDir) {
      workspaceDirsBySessionKey.set(ctx.sessionKey || "default", ctx.workspaceDir);
    }

    // Initialize session in the worker so observations are not skipped
    // (the privacy check requires a stored user prompt to exist)
    const contentSessionId = getContentSessionId(ctx.sessionKey);
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

    // Skip memory_ tools to prevent recursive observation loops
    if (toolName.startsWith("memory_")) return;

    const contentSessionId = getContentSessionId(ctx.sessionKey);

    // Extract result text from all content blocks
    let toolResponseText = "";
    const content = event.message?.content;
    if (Array.isArray(content)) {
      toolResponseText = content
        .filter((block) => (block.type === "tool_result" || block.type === "text") && "text" in block)
        .map((block) => String(block.text))
        .join("\n");
    }

    // Truncate long responses to prevent oversized payloads
    const MAX_TOOL_RESPONSE_LENGTH = 1000;
    if (toolResponseText.length > MAX_TOOL_RESPONSE_LENGTH) {
      toolResponseText = toolResponseText.slice(0, MAX_TOOL_RESPONSE_LENGTH);
    }

    // Fire-and-forget: send observation + sync MEMORY.md in parallel
    workerPostFireAndForget(workerPort, "/api/sessions/observations", {
      contentSessionId,
      tool_name: toolName,
      tool_input: event.params || {},
      tool_response: toolResponseText,
      cwd: "",
    }, api.logger);

    const workspaceDir = ctx.workspaceDir || workspaceDirsBySessionKey.get(ctx.sessionKey || "default");
    if (syncMemoryFile && workspaceDir) {
      syncMemoryToWorkspace(workspaceDir, ctx);
    }
  });

  // ------------------------------------------------------------------
  // Event: agent_end — summarize and complete session
  // ------------------------------------------------------------------
  api.on("agent_end", async (event, ctx) => {
    const contentSessionId = getContentSessionId(ctx.sessionKey);

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
  api.on("session_end", async (_event, ctx) => {
    const key = ctx.sessionKey || "default";
    sessionIds.delete(key);
    workspaceDirsBySessionKey.delete(key);
  });

  // ------------------------------------------------------------------
  // Event: gateway_start — clear session tracking for fresh start
  // ------------------------------------------------------------------
  api.on("gateway_start", async () => {
    workspaceDirsBySessionKey.clear();
    sessionIds.clear();
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
        getSourceLabel,
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

  function summarizeSearchResults(items: unknown[], limit = 5): string {
    if (!Array.isArray(items) || items.length === 0) {
      return "No results found.";
    }

    return items
      .slice(0, limit)
      .map((item, index) => {
        const row = item as Record<string, unknown>;
        const title = String(row.title || row.subtitle || row.text || "Untitled");
        const project = row.project ? ` [${String(row.project)}]` : "";
        return `${index + 1}. ${title}${project}`;
      })
      .join("\n");
  }

  function parseLimit(arg: string | undefined, fallback = 10): number {
    const parsed = Number(arg);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(1, Math.min(50, Math.trunc(parsed)));
  }

  // ------------------------------------------------------------------
  // Command: /claude_mem_feed — status & toggle
  // ------------------------------------------------------------------
  api.registerCommand({
    name: "claude_mem_feed",
    description: "Show or toggle Claude-Mem observation feed status",
    acceptsArgs: true,
    handler: async (ctx) => {
      const feedConfig = userConfig.observationFeed;

      if (!feedConfig) {
        return { text: "Observation feed not configured. Add observationFeed to your plugin config." };
      }

      const arg = ctx.args?.trim();

      if (arg === "on") {
        api.logger.info("[claude-mem] Feed enable requested via command");
        return { text: "Feed enable requested. Update observationFeed.enabled in your plugin config to persist." };
      }

      if (arg === "off") {
        api.logger.info("[claude-mem] Feed disable requested via command");
        return { text: "Feed disable requested. Update observationFeed.enabled in your plugin config to persist." };
      }

      return { text: [
        "Claude-Mem Observation Feed",
        `Enabled: ${feedConfig.enabled ? "yes" : "no"}`,
        `Channel: ${feedConfig.channel || "not set"}`,
        `Target: ${feedConfig.to || "not set"}`,
        `Connection: ${connectionState}`,
      ].join("\n") };
    },
  });

  // ------------------------------------------------------------------
  // Command: /claude-mem-search — query worker search API
  // Usage: /claude-mem-search <query> [limit]
  // ------------------------------------------------------------------
  api.registerCommand({
    name: "claude-mem-search",
    description: "Search Claude-Mem observations by query",
    acceptsArgs: true,
    handler: async (ctx) => {
      const raw = ctx.args?.trim() || "";
      if (!raw) {
        return "Usage: /claude-mem-search <query> [limit]";
      }

      const pieces = raw.split(/\s+/);
      const maybeLimit = pieces[pieces.length - 1];
      const hasTrailingLimit = /^\d+$/.test(maybeLimit);
      const limit = hasTrailingLimit ? parseLimit(maybeLimit, 10) : 10;
      const query = hasTrailingLimit ? pieces.slice(0, -1).join(" ") : raw;

      const data = await workerGetJson(
        workerPort,
        `/api/search/observations?query=${encodeURIComponent(query)}&limit=${limit}`,
        api.logger,
      );

      if (!data) {
        return "Claude-Mem search failed (worker unavailable or invalid response).";
      }

      const items = Array.isArray(data.items) ? data.items : [];
      return [
        `Claude-Mem Search: \"${query}\"`,
        summarizeSearchResults(items, limit),
      ].join("\n");
    },
  });

  // ------------------------------------------------------------------
  // Command: /claude-mem-recent — recent context snapshot
  // Usage: /claude-mem-recent [project] [limit]
  // ------------------------------------------------------------------
  api.registerCommand({
    name: "claude-mem-recent",
    description: "Show recent Claude-Mem context for a project",
    acceptsArgs: true,
    handler: async (ctx) => {
      const raw = ctx.args?.trim() || "";
      const parts = raw ? raw.split(/\s+/) : [];
      const maybeLimit = parts.length > 0 ? parts[parts.length - 1] : "";
      const hasTrailingLimit = /^\d+$/.test(maybeLimit);
      const limit = hasTrailingLimit ? parseLimit(maybeLimit, 3) : 3;
      const project = hasTrailingLimit ? parts.slice(0, -1).join(" ") : raw;

      const params = new URLSearchParams();
      params.set("limit", String(limit));
      if (project) params.set("project", project);

      const data = await workerGetJson(
        workerPort,
        `/api/context/recent?${params.toString()}`,
        api.logger,
      );

      if (!data) {
        return "Claude-Mem recent context failed (worker unavailable or invalid response).";
      }

      const summaries = Array.isArray(data.session_summaries) ? data.session_summaries : [];
      const observations = Array.isArray(data.recent_observations) ? data.recent_observations : [];

      return [
        "Claude-Mem Recent Context",
        `Project: ${project || "(auto)"}`,
        `Session summaries: ${summaries.length}`,
        `Recent observations: ${observations.length}`,
        summarizeSearchResults(observations, Math.min(5, observations.length || 5)),
      ].join("\n");
    },
  });

  // ------------------------------------------------------------------
  // Command: /claude-mem-timeline — search and timeline around best match
  // Usage: /claude-mem-timeline <query> [depthBefore] [depthAfter]
  // ------------------------------------------------------------------
  api.registerCommand({
    name: "claude-mem-timeline",
    description: "Find best memory match and show nearby timeline events",
    acceptsArgs: true,
    handler: async (ctx) => {
      const raw = ctx.args?.trim() || "";
      if (!raw) {
        return "Usage: /claude-mem-timeline <query> [depthBefore] [depthAfter]";
      }

      const parts = raw.split(/\s+/);
      let depthAfter = 5;
      let depthBefore = 5;

      if (parts.length >= 2 && /^\d+$/.test(parts[parts.length - 1])) {
        depthAfter = parseLimit(parts.pop(), 5);
      }
      if (parts.length >= 2 && /^\d+$/.test(parts[parts.length - 1])) {
        depthBefore = parseLimit(parts.pop(), 5);
      }

      const query = parts.join(" ");
      const params = new URLSearchParams({
        query,
        mode: "auto",
        depth_before: String(depthBefore),
        depth_after: String(depthAfter),
      });

      const data = await workerGetJson(
        workerPort,
        `/api/timeline/by-query?${params.toString()}`,
        api.logger,
      );

      if (!data) {
        return "Claude-Mem timeline lookup failed (worker unavailable or invalid response).";
      }

      const timeline = Array.isArray(data.timeline) ? data.timeline : [];
      const anchor = data.anchor ? String(data.anchor) : "(none)";

      return [
        `Claude-Mem Timeline: \"${query}\"`,
        `Anchor: ${anchor}`,
        summarizeSearchResults(timeline, 8),
      ].join("\n");
    },
  });

  // ------------------------------------------------------------------
  // Command: /claude_mem_status — worker health check
  // ------------------------------------------------------------------
  api.registerCommand({
    name: "claude_mem_status",
    description: "Check Claude-Mem worker health and session status",
    handler: async () => {
      const healthText = await workerGetText(workerPort, "/api/health", api.logger);
      if (!healthText) {
        return { text: `Claude-Mem worker unreachable at port ${workerPort}` };
      }

      try {
        const health = JSON.parse(healthText);
        return { text: [
          "Claude-Mem Worker Status",
          `Status: ${health.status || "unknown"}`,
          `Port: ${workerPort}`,
          `Active sessions: ${sessionIds.size}`,
          `Observation feed: ${connectionState}`,
        ].join("\n") };
      } catch {
        return { text: `Claude-Mem worker responded but returned unexpected data` };
      }
    },
  });

  api.logger.info(`[claude-mem] OpenClaw plugin loaded — v1.0.0 (worker: 127.0.0.1:${workerPort})`);
}
