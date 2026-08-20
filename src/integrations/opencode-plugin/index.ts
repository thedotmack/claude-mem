import { z } from "zod";
import { SettingsDefaultsManager } from "../../shared/SettingsDefaultsManager.js";
import { getProjectContext } from "../../utils/project-name.js";

/**
 * OpenCode plugin event contract.
 *
 * A plugin is an async function that receives a context object and returns an
 * object whose keys are OpenCode's real hook names. The hooks claude-mem binds
 * to are (authoritative source: plans/08-opencode-integration.md "Fix sequence"
 * step 1 and plans/23-host-integration-contracts.md step 2, cross-checked
 * against OpenCode's documented plugin API):
 *
 *   - `tool.execute.after`                  (input, output) — fires after every tool run
 *   - `chat.message`                        ({}, output)    — fires on each chat message
 *   - `event`                               ({ event })     — generic bus; event.type carries the name
 *   - `experimental.session.compacting`                     — fires when a session compacts
 *   - `experimental.chat.system.transform`                  — injects startup context
 *
 * The generic `event` hook delivers bus events whose discriminant is
 * `event.type`. The only bus event types claude-mem reacts to are
 * `session.deleted` (forget the session mapping) and `session.idle` (best-effort
 * completed-reply capture + summarize). Session creation is driven by user
 * `chat.message`; observation capture is driven by `tool.execute.after` and by
 * listing completed assistant replies on idle/compaction — not by bus events.
 * That is the #2435 fix: the old code subscribed to non-existent bus types
 * (`session.created`, `message.updated`, `session.compacted`, `file.edited`)
 * and therefore captured nothing.
 *
 * REAL_OPENCODE_EVENT_TYPES is the allowlist of bus `event.type` values the
 * plugin is permitted to switch on. The contract test asserts the plugin only
 * references names in this list so a future typo fails CI.
 */
export const REAL_OPENCODE_EVENT_TYPES = [
  "session.idle",
  "session.deleted",
] as const;

type RealOpenCodeEventType = (typeof REAL_OPENCODE_EVENT_TYPES)[number];

/** The hook keys this plugin returns. The contract test asserts these are the real OpenCode hook names. */
export const REGISTERED_OPENCODE_HOOKS = [
  "tool.execute.after",
  "chat.message",
  "event",
  "experimental.session.compacting",
  "experimental.chat.system.transform",
] as const;

interface OpenCodeProject {
  name?: string;
  path?: string;
}

interface OpenCodePart {
  type: string;
  text?: string;
  ignored?: boolean;
}

interface OpenCodeMessageSnapshot {
  info: {
    id: string;
    role: string;
    time?: { completed?: number };
    summary?: boolean;
  };
  parts: OpenCodePart[];
}

interface AssistantDeliveryState {
  sessionID: string;
  messageId: string;
  messageText: string;
  observationComplete: boolean;
  summaryComplete: boolean;
}

interface OpenCodeClient {
  session?: {
    messages?(options: {
      path: { id: string };
      query?: { directory?: string };
    }): Promise<{ data?: OpenCodeMessageSnapshot[] }>;
  };
}

interface OpenCodePluginContext {
  client: OpenCodeClient;
  project: OpenCodeProject;
  directory: string;
  worktree: string;
  serverUrl: URL;
  $: unknown;
}

interface ToolExecuteAfterInput {
  tool: string;
  sessionID: string;
  callID: string;
  args?: Record<string, unknown>;
}

interface ToolExecuteAfterOutput {
  title: string;
  output: string;
  metadata: Record<string, unknown>;
  args?: Record<string, unknown>;
}

interface ChatMessageInput {
  sessionID?: string;
}

interface ChatMessageOutput {
  message: {
    id?: string;
    role?: string;
    sessionID?: string;
  };
  parts: OpenCodePart[];
}

interface SessionCompactingInput {
  sessionID: string;
}

interface BusEvent {
  type: string;
  properties?: {
    sessionID?: string;
    info?: { id?: string };
  };
}

function resolveWorkerPort(): string {
  // Canonical resolution: CLAUDE_MEM_WORKER_PORT env override, else the
  // UID-derived default — identical to the rest of the codebase (#2406).
  return SettingsDefaultsManager.get("CLAUDE_MEM_WORKER_PORT");
}

function resolveWorkerHost(): string {
  return SettingsDefaultsManager.get("CLAUDE_MEM_WORKER_HOST");
}

const WORKER_BASE_URL = `http://${resolveWorkerHost()}:${resolveWorkerPort()}`;
const MAX_TOOL_RESPONSE_LENGTH = 1000;
const WORKER_FETCH_TIMEOUT_MS = 5_000;
const OPENCODE_PLATFORM_SOURCE = "opencode";
const MAX_SESSION_MAP_ENTRIES = 1000;
const MAX_PENDING_OVERRUN = MAX_SESSION_MAP_ENTRIES * 2;

const JSON_HEADERS: Record<string, string> = { "Content-Type": "application/json" };

function isQuietWorkerFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("ECONNREFUSED");
}

function isAbortFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = "name" in error ? String(error.name) : "";
  const message = error instanceof Error ? error.message : String(error);
  return name === "AbortError" || message.toLowerCase().includes("aborted");
}

async function workerFetch(
  path: string,
  init: RequestInit,
  timeoutMs?: number,
): Promise<Response | null> {
  const controller = timeoutMs ? new AbortController() : undefined;
  const timer = controller
    ? setTimeout(() => controller.abort(), timeoutMs)
    : undefined;
  try {
    const response = await fetch(`${WORKER_BASE_URL}${path}`, {
      ...init,
      headers: { ...JSON_HEADERS, ...(init.headers ?? {}) },
      signal: controller?.signal ?? init.signal,
    });
    return response;
  } catch (error: unknown) {
    const method = init.method || "GET";
    if (isAbortFailure(error) && timeoutMs) {
      console.warn(
        `[claude-mem] Worker ${method} ${path} timed out after ${timeoutMs}ms`,
      );
    } else if (!isQuietWorkerFailure(error)) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[claude-mem] Worker ${method} ${path} failed: ${message}`);
    }
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function workerPost(
  path: string,
  body: Record<string, unknown>,
): Promise<boolean> {
  const response = await workerFetch(
    path,
    {
      method: "POST",
      body: JSON.stringify(body),
    },
    WORKER_FETCH_TIMEOUT_MS,
  );
  if (!response) return false;
  if (!response.ok) {
    console.warn(`[claude-mem] Worker POST ${path} returned ${response.status}`);
    return false;
  }
  return true;
}

async function workerGetText(path: string, timeoutMs?: number): Promise<string | null> {
  const response = await workerFetch(path, { method: "GET" }, timeoutMs);
  if (!response) return null;
  if (!response.ok) {
    console.warn(`[claude-mem] Worker GET ${path} returned ${response.status}`);
    return null;
  }
  return await response.text();
}

const contentSessionIdsByOpenCodeSessionId = new Map<string, string>();
const assistantDeliveryStateByKey = new Map<string, AssistantDeliveryState>();
const assistantLifecycleTailBySession = new Map<string, Promise<void>>();
const contextBySessionId = new Map<string, string | Promise<string | null>>();

function buildContextProjects(directory: string): { projectName: string; projects: string[] } {
  const projectContext = getProjectContext(directory);
  return {
    projectName: projectContext.primary,
    projects: [...new Set(["opencode", ...projectContext.allProjects])],
  };
}

function deliveryKey(sessionID: string, messageId: string): string {
  return `${sessionID}::${messageId}`;
}

function sessionHasPendingDelivery(sessionID: string): boolean {
  for (const state of assistantDeliveryStateByKey.values()) {
    if (
      state.sessionID === sessionID &&
      (!state.observationComplete || !state.summaryComplete)
    ) {
      return true;
    }
  }
  return false;
}

function forgetSession(sessionID: string): void {
  contentSessionIdsByOpenCodeSessionId.delete(sessionID);
  contextBySessionId.delete(sessionID);
  for (const [key, state] of assistantDeliveryStateByKey) {
    if (state.sessionID === sessionID) {
      assistantDeliveryStateByKey.delete(key);
    }
  }
}

function evictOldestIdleSession(allowPending: boolean): boolean {
  for (const sessionID of contentSessionIdsByOpenCodeSessionId.keys()) {
    if (!allowPending && sessionHasPendingDelivery(sessionID)) continue;
    forgetSession(sessionID);
    return true;
  }
  return false;
}

function getOrCreateContentSessionId(openCodeSessionId: string): string {
  if (!contentSessionIdsByOpenCodeSessionId.has(openCodeSessionId)) {
    while (contentSessionIdsByOpenCodeSessionId.size >= MAX_SESSION_MAP_ENTRIES) {
      if (evictOldestIdleSession(false)) continue;
      if (contentSessionIdsByOpenCodeSessionId.size >= MAX_PENDING_OVERRUN) {
        evictOldestIdleSession(true);
      }
      break;
    }
    contentSessionIdsByOpenCodeSessionId.set(
      openCodeSessionId,
      `opencode-${openCodeSessionId}-${Date.now()}`,
    );
  }
  return contentSessionIdsByOpenCodeSessionId.get(openCodeSessionId)!;
}

function getTextContent(parts: OpenCodePart[] | undefined): string {
  return (parts || [])
    .filter(
      (part) =>
        part.type === "text" &&
        part.ignored !== true &&
        typeof part.text === "string" &&
        part.text.trim().length > 0,
    )
    .map((part) => part.text as string)
    .join("\n");
}

function truncate(text: string): string {
  return text.length > MAX_TOOL_RESPONSE_LENGTH
    ? text.slice(0, MAX_TOOL_RESPONSE_LENGTH)
    : text;
}

function isCompletedAssistant(snapshot: OpenCodeMessageSnapshot): boolean {
  return (
    snapshot.info.role === "assistant" &&
    snapshot.info.summary !== true &&
    typeof snapshot.info.time?.completed === "number"
  );
}

export const ClaudeMemPlugin = async (ctx: OpenCodePluginContext) => {
  const { projectName, projects } = buildContextProjects(ctx.directory);

  console.log(`[claude-mem] OpenCode plugin loading (project: ${projectName})`);

  const deliverAssistantLifecycle = async (
    sessionID: string,
    deliveryState: AssistantDeliveryState,
  ): Promise<void> => {
    const contentSessionId = getOrCreateContentSessionId(sessionID);
    const idempotencyBase = `opencode:${contentSessionId}:${deliveryState.messageId}`;
    if (!deliveryState.observationComplete) {
      deliveryState.observationComplete = await workerPost("/api/sessions/observations", {
        contentSessionId,
        tool_name: "assistant_message",
        tool_input: {},
        tool_response: deliveryState.messageText,
        cwd: ctx.directory,
        platformSource: OPENCODE_PLATFORM_SOURCE,
        toolUseId: `${idempotencyBase}:observation`,
        idempotencyKey: `${idempotencyBase}:observation`,
      });
    }
    if (!deliveryState.summaryComplete) {
      deliveryState.summaryComplete = await workerPost("/api/sessions/summarize", {
        contentSessionId,
        last_assistant_message: deliveryState.messageText,
        platformSource: OPENCODE_PLATFORM_SOURCE,
        toolUseId: `${idempotencyBase}:summarize`,
        idempotencyKey: `${idempotencyBase}:summarize`,
      });
    }
  };

  const upsertAssistantDelivery = (
    sessionID: string,
    messageId: string,
    messageText: string,
  ): AssistantDeliveryState => {
    const key = deliveryKey(sessionID, messageId);
    const existing = assistantDeliveryStateByKey.get(key);
    if (existing) {
      if (messageText) existing.messageText = messageText;
      return existing;
    }
    const created: AssistantDeliveryState = {
      sessionID,
      messageId,
      messageText,
      observationComplete: false,
      summaryComplete: false,
    };
    assistantDeliveryStateByKey.set(key, created);
    return created;
  };

  const captureAssistantLifecycle = async (sessionID: string): Promise<void> => {
    let snapshots: OpenCodeMessageSnapshot[] = [];
    const listMessages = ctx.client.session?.messages;
    if (typeof listMessages === "function") {
      try {
        const response = await listMessages({
          path: { id: sessionID },
          query: { directory: ctx.directory },
        });
        snapshots = response.data || [];
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[claude-mem] OpenCode message list failed for ${sessionID}: ${message}`);
      }
    }

    const completed = snapshots
      .filter(isCompletedAssistant)
      .sort(
        (left, right) =>
          (left.info.time?.completed || 0) - (right.info.time?.completed || 0),
      );

    for (const snapshot of completed) {
      const messageText = getTextContent(snapshot.parts);
      if (!messageText) continue;
      const deliveryState = upsertAssistantDelivery(sessionID, snapshot.info.id, messageText);
      if (!deliveryState.observationComplete || !deliveryState.summaryComplete) {
        await deliverAssistantLifecycle(sessionID, deliveryState);
      }
    }

    for (const state of assistantDeliveryStateByKey.values()) {
      if (
        state.sessionID === sessionID &&
        (!state.observationComplete || !state.summaryComplete) &&
        state.messageText
      ) {
        await deliverAssistantLifecycle(sessionID, state);
      }
    }
  };

  const serializeAssistantLifecycle = async (
    sessionID: string,
    operation: () => Promise<void>,
  ): Promise<void> => {
    const previous = assistantLifecycleTailBySession.get(sessionID) || Promise.resolve();
    const current = previous.then(operation, operation);
    assistantLifecycleTailBySession.set(sessionID, current);
    try {
      await current;
    } finally {
      if (assistantLifecycleTailBySession.get(sessionID) === current) {
        assistantLifecycleTailBySession.delete(sessionID);
      }
    }
  };

  return {
    // Capture every tool execution as an observation. This is the primary
    // capture path (#2419).
    "tool.execute.after": async (
      input: ToolExecuteAfterInput,
      output: ToolExecuteAfterOutput,
    ): Promise<void> => {
      const contentSessionId = getOrCreateContentSessionId(input.sessionID);
      const toolUseId = input.callID
        ? `opencode:${contentSessionId}:tool:${input.callID}`
        : undefined;
      await workerPost("/api/sessions/observations", {
        contentSessionId,
        tool_name: input.tool,
        tool_input: input.args || output.args || {},
        tool_response: truncate(output.output || ""),
        cwd: ctx.directory,
        platformSource: OPENCODE_PLATFORM_SOURCE,
        ...(toolUseId
          ? { toolUseId, idempotencyKey: toolUseId }
          : {}),
      });
    },

    // Capture every user turn as the authoritative session prompt. Assistant
    // replies are persisted from the completed-message list on idle/compaction
    // so partial streaming tokens are not stored as memory.
    "chat.message": async (
      input: ChatMessageInput,
      output: ChatMessageOutput,
    ): Promise<void> => {
      const sessionID = input.sessionID || output.message?.sessionID;
      if (!sessionID) return;

      const role = output.message?.role;
      if (role === "assistant" || role === "system") return;

      const contentSessionId = getOrCreateContentSessionId(sessionID);
      const prompt = getTextContent(output.parts) || "[media prompt]";
      const messageId = output.message?.id;
      const idempotencyKey = messageId
        ? `opencode:${contentSessionId}:init:${messageId}`
        : undefined;

      await workerPost("/api/sessions/init", {
        contentSessionId,
        project: projectName,
        platformSource: OPENCODE_PLATFORM_SOURCE,
        prompt,
        ...(idempotencyKey ? { idempotencyKey } : {}),
      });
    },

    "experimental.session.compacting": async (
      input: SessionCompactingInput,
    ): Promise<void> => {
      await serializeAssistantLifecycle(input.sessionID, () =>
        captureAssistantLifecycle(input.sessionID),
      );
    },

    // Inject directory-scoped project context into every system prompt build.
    "experimental.chat.system.transform": async (
      input: { sessionID?: string },
      output: { system: string[] },
    ): Promise<void> => {
      const cacheKey = input.sessionID || `project:${projectName}`;
      let cached = contextBySessionId.get(cacheKey);
      if (!cached) {
        const projectsParam = projects.join(",");
        while (contextBySessionId.size >= MAX_SESSION_MAP_ENTRIES) {
          const oldestKey = contextBySessionId.keys().next().value;
          if (oldestKey === undefined) break;
          contextBySessionId.delete(oldestKey);
        }
        const request = workerGetText(
          `/api/context/inject?projects=${encodeURIComponent(projectsParam)}&platformSource=${encodeURIComponent(OPENCODE_PLATFORM_SOURCE)}`,
          WORKER_FETCH_TIMEOUT_MS,
        ).then((context) => {
          if (contextBySessionId.get(cacheKey) === request) {
            if (context) {
              contextBySessionId.set(cacheKey, context);
            } else {
              contextBySessionId.delete(cacheKey);
            }
          }
          return context;
        });
        contextBySessionId.set(cacheKey, request);
        cached = request;
      }
      const context = typeof cached === "string" ? cached : await cached;
      if (context) output.system.push(context);
    },

    // Generic bus events. Only `session.idle` and `session.deleted` are real
    // and acted upon (see REAL_OPENCODE_EVENT_TYPES).
    event: async ({ event }: { event: BusEvent }): Promise<void> => {
      const eventType = event?.type as RealOpenCodeEventType | undefined;
      const sessionID = event?.properties?.sessionID || event?.properties?.info?.id;
      if (!sessionID) return;

      switch (eventType) {
        case "session.idle": {
          await serializeAssistantLifecycle(sessionID, () =>
            captureAssistantLifecycle(sessionID),
          );
          break;
        }
        case "session.deleted": {
          await serializeAssistantLifecycle(sessionID, async () => {
            forgetSession(sessionID);
          });
          break;
        }
        default:
          // Ignore all other bus events.
          break;
      }
    },

    tool: {
      claude_mem_search: {
        description:
          "Search claude-mem memory database for past observations, sessions, and context",
        args: {
          query: z.string().describe("Search query for memory observations"),
        },
        async execute(args: Record<string, unknown>): Promise<string> {
          const query = String(args.query || "");
          if (!query) {
            return "Please provide a search query.";
          }

          const text = await workerGetText(
            `/api/search/observations?query=${encodeURIComponent(query)}&limit=10`,
          );

          if (!text) {
            return "claude-mem worker is not running. Start it with: npx claude-mem start";
          }

          return parseSearchResponse(text, query);
        },
      },
    },
  };
};

/**
 * The worker returns Claude-style `{ content: [{ type: 'text', text: '...' }] }`
 * blocks, NOT `{ items: [...] }` (#2406). Concatenate the text blocks and return
 * them verbatim; an empty block list or a "No observations found" body becomes a
 * clear no-results message.
 */
export function parseSearchResponse(text: string, query: string): string {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error: unknown) {
    console.warn(
      "[claude-mem] Failed to parse search results:",
      error instanceof Error ? error.message : String(error),
    );
    return "Failed to parse search results.";
  }

  const content = (data as { content?: Array<{ type?: string; text?: string }> }).content;
  if (!Array.isArray(content) || content.length === 0) {
    return `No results found for "${query}".`;
  }

  const rendered = content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n")
    .trim();

  if (!rendered) {
    return `No results found for "${query}".`;
  }

  return rendered;
}

export default ClaudeMemPlugin;
