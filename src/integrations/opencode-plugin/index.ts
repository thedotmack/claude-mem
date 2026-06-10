import { z } from "zod";
import { SettingsDefaultsManager } from "../../shared/SettingsDefaultsManager.js";

/**
 * OpenCode plugin event contract.
 *
 * A plugin is an async function that receives a context object and returns an
 * object whose keys are OpenCode's real hook names. The hooks claude-mem binds
 * to are (authoritative source: plans/08-opencode-integration.md "Fix sequence"
 * step 1, cross-checked against OpenCode's documented plugin API):
 *
 *   - `tool.execute.after`            (input, output) — fires after every tool run
 *   - `event`                         ({ event })     — generic bus; event.type carries the name
 *   - `experimental.session.compacting`               — fires when a session compacts
 *
 * The generic `event` hook delivers bus events whose discriminant is
 * `event.type`. Assistant-message capture now happens via the real bus events
 * `message.updated` and `message.part.updated`, while `session.idle` and
 * `session.deleted` remain session-lifecycle events.
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
}

interface ToolExecuteAfterOutput {
  title: string;
  output: string;
  metadata: Record<string, unknown>;
  args?: Record<string, unknown>;
}

interface ChatMessageOutput {
  message: {
    id?: string;
    role?: string;
    sessionID?: string;
  };
  parts: Array<{ type: string; text?: string }>;
}

interface SessionCompactingInput {
  sessionID: string;
}

interface BusEvent {
  type: string;
  properties?: {
    sessionID?: string;
    info?: { id?: string };
    message?: ChatMessageOutput["message"];
    parts?: ChatMessageOutput["parts"];
    output?: ChatMessageOutput;
  };
  message?: ChatMessageOutput["message"];
  parts?: ChatMessageOutput["parts"];
}

function normalizeChatMessageOutput(value: {
  message?: ChatMessageOutput["message"];
  parts?: ChatMessageOutput["parts"];
} | null | undefined): ChatMessageOutput | null {
  if (!value?.message || !value.parts) return null;
  return {
    message: value.message,
    parts: value.parts,
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
    if (!message.includes("ECONNREFUSED")) {
      console.warn(`[claude-mem] Worker POST ${path} failed: ${message}`);
    }
    return false;
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
const pendingSessionInitializations = new Map<string, Promise<string | null>>();

const MAX_SESSION_MAP_ENTRIES = 1000;

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
 * the session the first time we see any activity for it (tool run or chat
 * message). This guarantees a session row exists before observations arrive.
 */
async function ensureSessionInitialized(openCodeSessionId: string, projectName: string): Promise<string | null> {
  const contentSessionId = getOrCreateContentSessionId(openCodeSessionId);
  if (initializedSessionIds.has(openCodeSessionId)) {
    return contentSessionId;
  }

  const pendingInitialization = pendingSessionInitializations.get(openCodeSessionId);
  if (pendingInitialization) {
    return pendingInitialization;
  }

  let initialization: Promise<string | null> | undefined;
  initialization = (async (): Promise<string | null> => {
    const initialized = await workerPost("/api/sessions/init", {
      contentSessionId,
      project: projectName,
      prompt: "",
    });
    if (pendingSessionInitializations.get(openCodeSessionId) === initialization) {
      pendingSessionInitializations.delete(openCodeSessionId);
    }
    if (!initialized) {
      return null;
    }
    if (!contentSessionIdsByOpenCodeSessionId.has(openCodeSessionId)) {
      return null;
    }
    initializedSessionIds.add(openCodeSessionId);
    return contentSessionId;
  })();

  pendingSessionInitializations.set(openCodeSessionId, initialization);
  return await initialization;
}

function truncate(text: string): string {
  return text.length > MAX_TOOL_RESPONSE_LENGTH
    ? text.slice(0, MAX_TOOL_RESPONSE_LENGTH)
    : text;
}

function extractAssistantMessageText(output: ChatMessageOutput): string {
  return (output.parts || [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n");
}

async function captureAssistantMessage(
  sessionID: string,
  output: ChatMessageOutput,
  projectName: string,
  cwd: string,
): Promise<void> {
  if (output.message?.role !== "assistant") return;

  const messageText = extractAssistantMessageText(output);
  if (!messageText) return;

  const contentSessionId = await ensureSessionInitialized(sessionID, projectName);
  if (!contentSessionId) return;
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
      if (!contentSessionId) return;
      await workerPost("/api/sessions/observations", {
        contentSessionId,
        tool_name: input.tool,
        tool_input: output.args || {},
        tool_response: truncate(output.output || ""),
        cwd: ctx.directory,
      });
    },

    // Summarize when a session compacts. This is OpenCode's real compaction
    // hook (the old `session.compacted` bus event never existed).
    "experimental.session.compacting": async (
      input: SessionCompactingInput,
    ): Promise<void> => {
      const contentSessionId = await ensureSessionInitialized(input.sessionID, projectName);
      if (!contentSessionId) return;
      await workerPost("/api/sessions/summarize", {
        contentSessionId,
        last_assistant_message: "",
      });
    },

    // Generic bus events. Only `session.idle` and `session.deleted` are real
    // and acted upon, plus the assistant-message bus events that OpenCode
    // delivers only through this hook (see REAL_OPENCODE_EVENT_TYPES).
    event: async ({ event }: { event: BusEvent }): Promise<void> => {
      const eventType = event?.type as RealOpenCodeEventType | undefined;
      const sessionID =
        event?.properties?.sessionID ||
        event?.properties?.info?.id ||
        event?.properties?.output?.message?.sessionID ||
        event?.properties?.message?.sessionID ||
        event?.message?.sessionID;

      switch (eventType) {
        case "message.part.updated": {
          if (!sessionID) return;
          await ensureSessionInitialized(sessionID, projectName);
          break;
        }
        case "message.updated": {
          const output =
            normalizeChatMessageOutput(event?.properties?.output) ??
            normalizeChatMessageOutput({
              message: event?.properties?.message,
              parts: event?.properties?.parts,
            }) ??
            normalizeChatMessageOutput({
              message: event?.message,
              parts: event?.parts,
            });
          if (!sessionID || !output) return;
          await captureAssistantMessage(sessionID, output, projectName, ctx.directory);
          break;
        }
        case "session.idle": {
          if (!sessionID) return;
          // Best-effort summarize once a session goes idle.
          const contentSessionId = await ensureSessionInitialized(sessionID, projectName);
          if (!contentSessionId) return;
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
          pendingSessionInitializations.delete(sessionID);
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
