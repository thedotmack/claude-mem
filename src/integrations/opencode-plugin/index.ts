import { z } from "zod";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { SettingsDefaultsManager } from "../../shared/SettingsDefaultsManager.js";
import { stripBom } from "../../utils/json-utils.js";

const PLATFORM_SOURCE = "opencode";

const PLATFORM_SOURCE = "opencode";

interface OpenCodePluginInput {
  client: unknown;
  project: { name?: string; path?: string };
  directory: string;
  worktree: string;
  serverUrl: URL;
  $: unknown;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyHook = (...args: any[]) => Promise<void> | void;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type OpenCodeHooks = Record<string, AnyHook | Record<string, any>>;

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
}

interface ChatMessageInput {
  sessionID: string;
  agent?: string;
  messageID?: string;
}

interface ChatMessageOutput {
  message: {
    id?: string;
    role?: string;
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
  // 1. Env override wins (set by the worker at startup via its own process).
  if (process.env.CLAUDE_MEM_WORKER_PORT) {
    return process.env.CLAUDE_MEM_WORKER_PORT;
  }
  // 2. Read from settings.json so the OpenCode plugin process (which doesn't
  //    inherit the worker's env) uses the same port the worker chose.
  try {
    const settingsPath = join(homedir(), ".claude-mem", "settings.json");
    if (existsSync(settingsPath)) {
      const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, string>;
      if (settings.CLAUDE_MEM_WORKER_PORT) {
        return settings.CLAUDE_MEM_WORKER_PORT;
      }
    }
  } catch {
    // fall through to default
  }
  // 3. UID-derived default — matches the worker's own default calculation.
  return SettingsDefaultsManager.get("CLAUDE_MEM_WORKER_PORT");
}

function resolveWorkerHost(): string {
  return SettingsDefaultsManager.get("CLAUDE_MEM_WORKER_HOST");
}

const WORKER_BASE_URL = `http://${resolveWorkerHost()}:${resolveWorkerPort()}`;
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
let nextContentSessionNonce = 0;

const MAX_SESSION_MAP_ENTRIES = 1000;

function getOrCreateContentSessionId(openCodeSessionId: string): string {
  if (!contentSessionIdsByOpenCodeSessionId.has(openCodeSessionId)) {
    while (contentSessionIdsByOpenCodeSessionId.size >= MAX_SESSION_MAP_ENTRIES) {
      const oldestKey = contentSessionIdsByOpenCodeSessionId.keys().next().value;
      if (oldestKey !== undefined) {
        contentSessionIdsByOpenCodeSessionId.delete(oldestKey);
        initializedSessionIds.delete(oldestKey);
        pendingSessionInitializations.delete(oldestKey);
      } else {
        break;
      }
    }
    contentSessionIdsByOpenCodeSessionId.set(
      openCodeSessionId,
      `opencode-${openCodeSessionId}-${Date.now()}-${nextContentSessionNonce++}`,
    );
  }
  return contentSessionIdsByOpenCodeSessionId.get(openCodeSessionId)!;
}

/**
 * The worker has no "session.created" event in OpenCode, so we lazily initialize
 * the session the first time we see any activity for it (tool run or chat
 * message). This guarantees a session row exists before observations arrive.
 */
function ensureSessionInitialized(openCodeSessionId: string, projectName: string, prompt = ""): string {
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
      prompt,
      platformSource: PLATFORM_SOURCE,
    });
    if (pendingSessionInitializations.get(openCodeSessionId) === initialization) {
      pendingSessionInitializations.delete(openCodeSessionId);
    }
    if (!initialized) {
      return null;
    }
    if (contentSessionIdsByOpenCodeSessionId.get(openCodeSessionId) !== contentSessionId) {
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

const ClaudeMemPlugin = async (ctx: OpenCodePluginInput) => {
  const projectName = ctx.project?.name || "opencode";

  console.log(`[claude-mem] OpenCode plugin loading (project: ${projectName})`);

  return {
    "tool.execute.after": async (
      input: ToolExecuteAfterInput,
      output: ToolExecuteAfterOutput,
    ): Promise<void> => {
      const contentSessionId = await ensureSessionInitialized(input.sessionID, projectName);
      if (!contentSessionId) return;
      await workerPost("/api/sessions/observations", {
        contentSessionId,
        platformSource: PLATFORM_SOURCE,
        tool_name: input.tool,
        tool_input: input.args || {},
        tool_response: truncate(output.output || ""),
        cwd: ctx.directory,
        platformSource: PLATFORM_SOURCE,
      });
    },

    "chat.message": async (
      input: ChatMessageInput,
      output: ChatMessageOutput,
    ): Promise<void> => {
      const sessionID = input.sessionID;
      if (!sessionID) return;

      const messageText = (output.parts || [])
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text as string)
        .join("\n");
      if (!messageText) return;

      const role = output.message?.role || "assistant";
      // Pass the user message as the session prompt so the viewer shows it instead of "[media prompt]"
      const prompt = role === "user" ? truncate(messageText) : "";
      const contentSessionId = ensureSessionInitialized(sessionID, projectName, prompt);
      workerPostFireAndForget("/api/sessions/observations", {
        contentSessionId,
        tool_name: role === "user" ? "user_message" : "assistant_message",
        tool_input: {},
        tool_response: truncate(messageText),
        cwd: ctx.directory,
        platformSource: PLATFORM_SOURCE,
      });
    },

    "experimental.session.compacting": async (
      input: SessionCompactingInput,
    ): Promise<void> => {
      const contentSessionId = await ensureSessionInitialized(input.sessionID, projectName);
      if (!contentSessionId) return;
      await workerPost("/api/sessions/summarize", {
        contentSessionId,
        platformSource: PLATFORM_SOURCE,
        last_assistant_message: "",
        platformSource: PLATFORM_SOURCE,
      });
    },

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
          const contentSessionId = ensureSessionInitialized(sessionID, projectName);
          workerPostFireAndForget("/api/sessions/summarize", {
            contentSessionId,
            platformSource: PLATFORM_SOURCE,
            last_assistant_message: "",
            platformSource: PLATFORM_SOURCE,
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

export default { id: "claude-mem", server: ClaudeMemPlugin };
