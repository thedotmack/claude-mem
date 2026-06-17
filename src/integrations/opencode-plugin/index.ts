import { z } from "zod";
import { SettingsDefaultsManager } from "../../shared/SettingsDefaultsManager.js";

/**
 * OpenCode plugin event contract.
 *
 * A plugin is an async function that receives a context object and returns an
 * object whose keys are OpenCode's real hook names. The hooks claude-mem binds
 * to are cross-checked against OpenCode's documented plugin API:
 *
 *   - `tool.execute.after`            (input, output) — fires after every tool run
 *   - `event`                         ({ event })     — generic bus; event.type carries the name
 *   - `experimental.session.compacting`               — fires when a session compacts
 *
 * The generic `event` hook delivers bus events whose discriminant is
 * `event.type`. The bus event types claude-mem reacts to are `message.updated`
 * / `message.part.updated` (assistant message capture), `session.idle`
 * (best-effort summarize), and `session.deleted` (forget the session mapping).
 * Session creation is lazy: the first tool run or assistant text capture creates
 * the worker session. `chat.message` is not used because it is not emitted by
 * current OpenCode versions.
 *
 * REAL_OPENCODE_EVENT_TYPES is the allowlist of bus `event.type` values the
 * plugin is permitted to switch on. The contract test asserts the plugin only
 * references names in this list so a future typo fails CI.
 */
export const REAL_OPENCODE_EVENT_TYPES = [
  "message.updated",
  "message.part.updated",
  "session.idle",
  "session.deleted",
] as const;

type RealOpenCodeEventType = (typeof REAL_OPENCODE_EVENT_TYPES)[number];

/** The hook keys this plugin returns. The contract test asserts these are the real OpenCode hook names. */
export const REGISTERED_OPENCODE_HOOKS = [
  "tool.execute.after",
  "event",
  "experimental.session.compacting",
] as const;

interface OpenCodeProject {
  name?: string;
  path?: string;
}

interface OpenCodePluginContext {
  client: unknown;
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

interface SessionCompactingInput {
  sessionID: string;
}

interface OpenCodeMessageInfo {
  id?: string;
  role?: string;
  sessionID?: string;
  finish?: string;
  error?: unknown;
  time?: {
    completed?: number;
  };
}

interface OpenCodeMessagePart {
  id?: string;
  sessionID?: string;
  messageID?: string;
  type?: string;
  text?: string;
  time?: {
    end?: number;
  };
}

interface BusEvent {
  type: string;
  properties?: {
    sessionID?: string;
    messageID?: string;
    info?: OpenCodeMessageInfo;
    part?: OpenCodeMessagePart;
  };
}

function resolveWorkerPort(): string {
  // Canonical resolution: CLAUDE_MEM_WORKER_PORT env override, else the
  // UID-derived default — identical to the rest of the codebase (#2406).
  return SettingsDefaultsManager.get("CLAUDE_MEM_WORKER_PORT");
}

const WORKER_BASE_URL = `http://127.0.0.1:${resolveWorkerPort()}`;
const MAX_TOOL_RESPONSE_LENGTH = 1000;

const JSON_HEADERS: Record<string, string> = { "Content-Type": "application/json" };

async function workerPost(
  path: string,
  body: Record<string, unknown>,
): Promise<void> {
  try {
    const response = await fetch(`${WORKER_BASE_URL}${path}`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      console.warn(`[claude-mem] Worker POST ${path} returned ${response.status}`);
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("ECONNREFUSED")) {
      console.warn(`[claude-mem] Worker POST ${path} failed: ${message}`);
    }
  }
}

async function workerGetText(path: string): Promise<string | null> {
  try {
    const response = await fetch(`${WORKER_BASE_URL}${path}`, { headers: JSON_HEADERS });
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
  }
}

const contentSessionIdsByOpenCodeSessionId = new Map<string, string>();
const initializedSessionIds = new Set<string>();
const assistantMessageSessionIds = new Map<string, string>();
const completedAssistantMessageIds = new Set<string>();
const capturedAssistantMessageIds = new Set<string>();
const textPartsByMessageId = new Map<string, Map<string, string>>();

const MAX_SESSION_MAP_ENTRIES = 1000;
const MAX_MESSAGE_CACHE_ENTRIES = 1000;

function getOrCreateContentSessionId(openCodeSessionId: string): string {
  if (!contentSessionIdsByOpenCodeSessionId.has(openCodeSessionId)) {
    while (contentSessionIdsByOpenCodeSessionId.size >= MAX_SESSION_MAP_ENTRIES) {
      const oldestKey = contentSessionIdsByOpenCodeSessionId.keys().next().value;
      if (oldestKey !== undefined) {
        contentSessionIdsByOpenCodeSessionId.delete(oldestKey);
        initializedSessionIds.delete(oldestKey);
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

/**
 * The worker has no "session.created" event in OpenCode, so we lazily initialize
 * the session the first time we see any activity for it (tool run or assistant
 * message capture). This guarantees a session row exists before observations arrive.
 */
async function ensureSessionInitialized(openCodeSessionId: string, projectName: string): Promise<string> {
  const contentSessionId = getOrCreateContentSessionId(openCodeSessionId);
  if (!initializedSessionIds.has(openCodeSessionId)) {
    initializedSessionIds.add(openCodeSessionId);
    await workerPost("/api/sessions/init", {
      contentSessionId,
      project: projectName,
      prompt: "",
    });
  }
  return contentSessionId;
}

function truncate(text: string): string {
  return text.length > MAX_TOOL_RESPONSE_LENGTH
    ? text.slice(0, MAX_TOOL_RESPONSE_LENGTH)
    : text;
}

function pruneAssistantMessageCache(): void {
  while (assistantMessageSessionIds.size > MAX_MESSAGE_CACHE_ENTRIES) {
    const oldestMessageId = assistantMessageSessionIds.keys().next().value;
    if (oldestMessageId === undefined) break;
    assistantMessageSessionIds.delete(oldestMessageId);
    completedAssistantMessageIds.delete(oldestMessageId);
    capturedAssistantMessageIds.delete(oldestMessageId);
    textPartsByMessageId.delete(oldestMessageId);
  }
}

function rememberAssistantMessage(messageID: string, sessionID: string): void {
  assistantMessageSessionIds.set(messageID, sessionID);
  pruneAssistantMessageCache();
}

function isAssistantMessageComplete(info: OpenCodeMessageInfo): boolean {
  return Boolean(
    info.finish
      || info.error
      || typeof info.time?.completed === "number",
  );
}

function isTextPartComplete(part: OpenCodeMessagePart): boolean {
  return typeof part.time?.end === "number";
}

function rememberTextPart(part: OpenCodeMessagePart): void {
  if (!part.messageID || !part.text) return;
  const partID = part.id || `${part.messageID}:${textPartsByMessageId.get(part.messageID)?.size || 0}`;
  let parts = textPartsByMessageId.get(part.messageID);
  if (!parts) {
    parts = new Map<string, string>();
    textPartsByMessageId.set(part.messageID, parts);
  }
  parts.set(partID, part.text);
}

async function captureAssistantMessage(
  messageID: string,
  sessionID: string,
  projectName: string,
  cwd: string,
): Promise<void> {
  if (capturedAssistantMessageIds.has(messageID)) return;
  const messageText = Array.from(textPartsByMessageId.get(messageID)?.values() || [])
    .filter((text) => text.trim().length > 0)
    .join("\n");
  if (!messageText) return;

  capturedAssistantMessageIds.add(messageID);
  const contentSessionId = await ensureSessionInitialized(sessionID, projectName);
  await workerPost("/api/sessions/observations", {
    contentSessionId,
    tool_name: "assistant_message",
    tool_input: {},
    tool_response: truncate(messageText),
    cwd,
  });
}

export const ClaudeMemPlugin = async (ctx: OpenCodePluginContext) => {
  const projectName = ctx.project?.name || "opencode";

  console.log(`[claude-mem] OpenCode plugin loading (project: ${projectName})`);

  return {
    // Capture every tool execution as an observation. This is the primary
    // capture path (#2419).
    "tool.execute.after": async (
      input: ToolExecuteAfterInput,
      output: ToolExecuteAfterOutput,
    ): Promise<void> => {
      const contentSessionId = await ensureSessionInitialized(input.sessionID, projectName);
      await workerPost("/api/sessions/observations", {
        contentSessionId,
        tool_name: input.tool,
        tool_input: input.args || output.args || {},
        tool_response: truncate(output.output || ""),
        cwd: ctx.directory,
      });
    },

    // Summarize when a session compacts. This hook fires before OpenCode writes
    // its own compaction summary.
    "experimental.session.compacting": async (
      input: SessionCompactingInput,
    ): Promise<void> => {
      const contentSessionId = await ensureSessionInitialized(input.sessionID, projectName);
      await workerPost("/api/sessions/summarize", {
        contentSessionId,
        last_assistant_message: "",
      });
    },

    // Generic bus events. The message events are OpenCode's current assistant
    // text capture path (see REAL_OPENCODE_EVENT_TYPES).
    event: async ({ event }: { event: BusEvent }): Promise<void> => {
      const eventType = event?.type as RealOpenCodeEventType | undefined;
      const sessionID = event?.properties?.sessionID || event?.properties?.info?.id;

      switch (eventType) {
        case "message.updated": {
          const info = event.properties?.info;
          const messageSessionID = event.properties?.sessionID || info?.sessionID;
          if (!info?.id || !messageSessionID || info.role !== "assistant") return;

          rememberAssistantMessage(info.id, messageSessionID);
          if (isAssistantMessageComplete(info)) {
            completedAssistantMessageIds.add(info.id);
            await captureAssistantMessage(info.id, messageSessionID, projectName, ctx.directory);
          }
          break;
        }
        case "message.part.updated": {
          const part = event.properties?.part;
          const messageSessionID = event.properties?.sessionID || part?.sessionID;
          if (!part?.messageID || !messageSessionID || part.type !== "text") return;

          rememberTextPart(part);
          if (!assistantMessageSessionIds.has(part.messageID)) return;
          if (isTextPartComplete(part) || completedAssistantMessageIds.has(part.messageID)) {
            await captureAssistantMessage(part.messageID, messageSessionID, projectName, ctx.directory);
          }
          break;
        }
        case "session.idle": {
          // Best-effort summarize once a session goes idle.
          if (!sessionID) return;
          const contentSessionId = await ensureSessionInitialized(sessionID, projectName);
          await workerPost("/api/sessions/summarize", {
            contentSessionId,
            last_assistant_message: "",
          });
          break;
        }
        case "session.deleted": {
          if (!sessionID) return;
          contentSessionIdsByOpenCodeSessionId.delete(sessionID);
          initializedSessionIds.delete(sessionID);
          for (const [messageID, messageSessionID] of assistantMessageSessionIds) {
            if (messageSessionID !== sessionID) continue;
            assistantMessageSessionIds.delete(messageID);
            completedAssistantMessageIds.delete(messageID);
            capturedAssistantMessageIds.delete(messageID);
            textPartsByMessageId.delete(messageID);
          }
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
