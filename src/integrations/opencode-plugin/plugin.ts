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
  };
}

function resolveWorkerPort(): string {
  // Canonical resolution: CLAUDE_MEM_WORKER_PORT env override, else the
  // UID-derived default — identical to the rest of the codebase (#2406).
  return SettingsDefaultsManager.get("CLAUDE_MEM_WORKER_PORT");
}

const WORKER_BASE_URL = `http://127.0.0.1:${resolveWorkerPort()}`;
const MAX_TOOL_RESPONSE_LENGTH = 1000;

// Tag every session this plugin creates so the worker stores
// sdk_sessions.platform_source = 'opencode' instead of defaulting to 'claude'.
// The worker's /api/sessions/init and /api/sessions/observations handlers both
// read `platformSource` and run it through normalizePlatformSource(); without
// it, OpenCode work is mislabeled as 'claude' and source-scoped search (#2389)
// cannot isolate it. Sent on both session-creating POSTs so the session is
// tagged correctly whichever lands first.
const PLATFORM_SOURCE = "opencode";

// Cap how long a single worker POST may block a hook. OpenCode awaits hook
// handlers, so awaiting the POST is what makes capture reliable in a one-shot
// `opencode run` (the process stays alive until the post resolves instead of
// exiting mid-flight). The timeout is the safety valve: a hung or dead worker
// must never stall OpenCode — the post is abandoned and capture is skipped.
const WORKER_POST_TIMEOUT_MS = 3000;

const JSON_HEADERS: Record<string, string> = { "Content-Type": "application/json" };

/**
 * POST to the worker and await the result. Failures are swallowed (capture is
 * best-effort and must never break the user's OpenCode session): a refused
 * connection or a timeout means the worker is not running, which is fine.
 */
async function workerPost(
  path: string,
  body: Record<string, unknown>,
): Promise<void> {
  try {
    await fetch(`${WORKER_BASE_URL}${path}`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(WORKER_POST_TIMEOUT_MS),
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    // ECONNREFUSED = worker not running; AbortError/TimeoutError = worker hung.
    // Both are expected, non-fatal conditions — stay quiet so we don't spam the
    // OpenCode console on every tool call when the worker is simply offline.
    const isExpected =
      message.includes("ECONNREFUSED") ||
      (error instanceof Error &&
        (error.name === "AbortError" || error.name === "TimeoutError"));
    if (!isExpected) {
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
async function ensureSessionInitialized(
  openCodeSessionId: string,
  projectName: string,
): Promise<string> {
  const contentSessionId = getOrCreateContentSessionId(openCodeSessionId);
  // Mark initialized synchronously, before the await, so concurrent hooks for
  // the same session don't each fire an init POST.
  if (!initializedSessionIds.has(openCodeSessionId)) {
    initializedSessionIds.add(openCodeSessionId);
    await workerPost("/api/sessions/init", {
      contentSessionId,
      project: projectName,
      prompt: "",
      platformSource: PLATFORM_SOURCE,
    });
  }
  return contentSessionId;
}

function truncate(text: string): string {
  return text.length > MAX_TOOL_RESPONSE_LENGTH
    ? text.slice(0, MAX_TOOL_RESPONSE_LENGTH)
    : text;
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
        tool_input: output.args || {},
        tool_response: truncate(output.output || ""),
        cwd: ctx.directory,
        platformSource: PLATFORM_SOURCE,
      });
    },

    // Capture assistant chat messages as observations.
    "chat.message": async (
      _input: Record<string, unknown>,
      output: ChatMessageOutput,
    ): Promise<void> => {
      const sessionID = output.message?.sessionID;
      if (!sessionID) return;
      if (output.message?.role !== "assistant") return;

      const messageText = (output.parts || [])
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text as string)
        .join("\n");
      if (!messageText) return;

      const contentSessionId = await ensureSessionInitialized(sessionID, projectName);
      await workerPost("/api/sessions/observations", {
        contentSessionId,
        tool_name: "assistant_message",
        tool_input: {},
        tool_response: truncate(messageText),
        cwd: ctx.directory,
        platformSource: PLATFORM_SOURCE,
      });
    },

    // Summarize when a session compacts. This is OpenCode's real compaction
    // hook (the old `session.compacted` bus event never existed).
    "experimental.session.compacting": async (
      input: SessionCompactingInput,
    ): Promise<void> => {
      const contentSessionId = await ensureSessionInitialized(input.sessionID, projectName);
      await workerPost("/api/sessions/summarize", {
        contentSessionId,
        last_assistant_message: "",
      });
    },

    // Generic bus events. Only `session.idle` and `session.deleted` are real
    // and acted upon (see REAL_OPENCODE_EVENT_TYPES).
    event: async ({ event }: { event: BusEvent }): Promise<void> => {
      const eventType = event?.type as RealOpenCodeEventType | undefined;
      const sessionID = event?.properties?.sessionID || event?.properties?.info?.id;
      if (!sessionID) return;

      switch (eventType) {
        case "session.idle": {
          // Best-effort summarize once a session goes idle.
          const contentSessionId = await ensureSessionInitialized(sessionID, projectName);
          await workerPost("/api/sessions/summarize", {
            contentSessionId,
            last_assistant_message: "",
          });
          break;
        }
        case "session.deleted": {
          contentSessionIdsByOpenCodeSessionId.delete(sessionID);
          initializedSessionIds.delete(sessionID);
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
