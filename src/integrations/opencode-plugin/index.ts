import { z } from "zod";
import { SettingsDefaultsManager } from "../../shared/SettingsDefaultsManager.js";
import { getProjectContext } from "../../utils/project-name.js";

/**
 * OpenCode plugin event contract.
 *
 * A plugin is an async function that receives a context object and returns an
 * object whose keys are OpenCode's real hook names. The hooks claude-mem binds
 * to are (authoritative source: plans/08-opencode-integration.md "Fix sequence"
 * step 1, cross-checked against OpenCode's documented plugin API):
 *
 *   - `tool.execute.after`            (input, output) — fires after every tool run
 *   - `chat.message`                  ({}, output)    — fires on each chat message
 *   - `event`                         ({ event })     — generic bus; event.type carries the name
 *   - `experimental.session.compacting`               — fires when a session compacts
 *
 * The generic `event` hook delivers bus events whose discriminant is
 * `event.type`. The only bus event types claude-mem reacts to are
 * `session.deleted` (forget the session mapping) and `session.idle` (best-effort
 * summarize). Session creation/observation capture is driven by the dedicated
 * `tool.execute.after` / `chat.message` hooks above, not by bus events — that is
 * the #2435 fix: the old code subscribed to non-existent bus types
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
  messageId: string;
  observationComplete: boolean;
  summaryComplete: boolean;
}

interface OpenCodeClient {
  session: {
    messages(options: {
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
  args: Record<string, unknown>;
}

interface ToolExecuteAfterOutput {
  title: string;
  output: string;
  metadata: Record<string, unknown>;
}

interface ChatMessageInput {
  sessionID: string;
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
const WORKER_GET_TIMEOUT_MS = 5_000;
const OPENCODE_PLATFORM_SOURCE = "opencode";

const JSON_HEADERS: Record<string, string> = { "Content-Type": "application/json" };

async function workerPost(
  path: string,
  body: Record<string, unknown>,
): Promise<boolean> {
  try {
    const response = await fetch(`${WORKER_BASE_URL}${path}`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      console.warn(`[claude-mem] Worker POST ${path} returned ${response.status}`);
      return false;
    }
    return true;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[claude-mem] Worker POST ${path} failed: ${message}`);
    return false;
  }
}

async function workerGetText(path: string, timeoutMs?: number): Promise<string | null> {
  const controller = timeoutMs ? new AbortController() : undefined;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
  try {
    const response = await fetch(`${WORKER_BASE_URL}${path}`, {
      headers: JSON_HEADERS,
      signal: controller?.signal,
    });
    if (!response.ok) {
      console.warn(`[claude-mem] Worker GET ${path} returned ${response.status}`);
      return null;
    }
    return await response.text();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("ECONNREFUSED")) {
      console.warn(`[claude-mem] Worker GET ${path} failed: ${message}`);
    }
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const contentSessionIdsByOpenCodeSessionId = new Map<string, string>();
const assistantDeliveryStateBySessionId = new Map<string, AssistantDeliveryState>();

const MAX_SESSION_MAP_ENTRIES = 1000;

const contextBySessionId = new Map<string, string>();

function buildContextProjects(directory: string): { projectName: string; projects: string[] } {
  const projectContext = getProjectContext(directory);
  return {
    projectName: projectContext.primary,
    projects: [...new Set([...projectContext.allProjects, "opencode"])],
  };
}

function getOrCreateContentSessionId(openCodeSessionId: string): string {
  if (!contentSessionIdsByOpenCodeSessionId.has(openCodeSessionId)) {
    while (contentSessionIdsByOpenCodeSessionId.size >= MAX_SESSION_MAP_ENTRIES) {
      const oldestKey = contentSessionIdsByOpenCodeSessionId.keys().next().value;
      if (oldestKey !== undefined) {
        contentSessionIdsByOpenCodeSessionId.delete(oldestKey);
        assistantDeliveryStateBySessionId.delete(oldestKey);
        contextBySessionId.delete(oldestKey);
      } else {
        break;
      }
    }
    contentSessionIdsByOpenCodeSessionId.set(
      openCodeSessionId,
      `opencode-${openCodeSessionId}-${Date.now()}`,
    );
  }
  return contentSessionIdsByOpenCodeSessionId.get(openCodeSessionId)!;
}

function getTextContent(parts: OpenCodePart[]): string {
  return parts
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

export const ClaudeMemPlugin = async (ctx: OpenCodePluginContext) => {
  const { projectName, projects } = buildContextProjects(ctx.directory);

  console.log(`[claude-mem] OpenCode plugin loading (project: ${projectName})`);

  const captureAssistantLifecycle = async (sessionID: string): Promise<void> => {
    let snapshots: OpenCodeMessageSnapshot[];
    try {
      const response = await ctx.client.session.messages({
        path: { id: sessionID },
        query: { directory: ctx.directory },
      });
      snapshots = response.data || [];
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[claude-mem] OpenCode message list failed for ${sessionID}: ${message}`);
      return;
    }

    const latestAssistant = snapshots
      .filter(
        (snapshot) =>
          snapshot.info.role === "assistant" &&
          snapshot.info.summary !== true &&
          typeof snapshot.info.time?.completed === "number",
      )
      .sort(
        (left, right) =>
          (right.info.time?.completed || 0) - (left.info.time?.completed || 0),
      )[0];
    if (!latestAssistant) return;

    let deliveryState = assistantDeliveryStateBySessionId.get(sessionID);
    if (
      deliveryState?.messageId === latestAssistant.info.id &&
      deliveryState.observationComplete &&
      deliveryState.summaryComplete
    ) {
      return;
    }

    const messageText = getTextContent(latestAssistant.parts);
    if (!messageText) return;

    const contentSessionId = getOrCreateContentSessionId(sessionID);
    if (!deliveryState || deliveryState.messageId !== latestAssistant.info.id) {
      deliveryState = {
        messageId: latestAssistant.info.id,
        observationComplete: false,
        summaryComplete: false,
      };
      assistantDeliveryStateBySessionId.set(sessionID, deliveryState);
    }

    if (!deliveryState.observationComplete) {
      deliveryState.observationComplete = await workerPost("/api/sessions/observations", {
        contentSessionId,
        tool_name: "assistant_message",
        tool_input: {},
        tool_response: messageText,
        cwd: ctx.directory,
        platformSource: OPENCODE_PLATFORM_SOURCE,
      });
    }
    if (!deliveryState.summaryComplete) {
      deliveryState.summaryComplete = await workerPost("/api/sessions/summarize", {
        contentSessionId,
        last_assistant_message: messageText,
        platformSource: OPENCODE_PLATFORM_SOURCE,
      });
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
      await workerPost("/api/sessions/observations", {
        contentSessionId,
        tool_name: input.tool,
        tool_input: input.args || {},
        tool_response: truncate(output.output || ""),
        cwd: ctx.directory,
        platformSource: OPENCODE_PLATFORM_SOURCE,
      });
    },

    // Capture every user turn as the authoritative session prompt.
    "chat.message": async (
      input: ChatMessageInput,
      output: ChatMessageOutput,
    ): Promise<void> => {
      const contentSessionId = getOrCreateContentSessionId(input.sessionID);
      const prompt = getTextContent(output.parts) || "[media prompt]";

      await workerPost("/api/sessions/init", {
        contentSessionId,
        project: projectName,
        platformSource: OPENCODE_PLATFORM_SOURCE,
        prompt,
      });
    },

    "experimental.session.compacting": async (
      input: SessionCompactingInput,
    ): Promise<void> => {
      await captureAssistantLifecycle(input.sessionID);
    },

    // Inject directory-scoped project context into every system prompt build.
    "experimental.chat.system.transform": async (
      input: { sessionID?: string },
      output: { system: string[] },
    ): Promise<void> => {
      const cacheKey = input.sessionID || `project:${projectName}`;
      let context = contextBySessionId.get(cacheKey);
      if (!context) {
        const projectsParam = projects.join(",");
        context =
          (await workerGetText(
            `/api/context/inject?projects=${encodeURIComponent(projectsParam)}`,
            WORKER_GET_TIMEOUT_MS,
          )) || undefined;
        if (context) {
          while (contextBySessionId.size >= MAX_SESSION_MAP_ENTRIES) {
            const oldestKey = contextBySessionId.keys().next().value;
            if (oldestKey === undefined) break;
            contextBySessionId.delete(oldestKey);
          }
          contextBySessionId.set(cacheKey, context);
        }
      }
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
          await captureAssistantLifecycle(sessionID);
          break;
        }
        case "session.deleted": {
          contentSessionIdsByOpenCodeSessionId.delete(sessionID);
          assistantDeliveryStateBySessionId.delete(sessionID);
          contextBySessionId.delete(sessionID);
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
