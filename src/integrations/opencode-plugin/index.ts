import { z } from "zod";
import { SettingsDefaultsManager } from "../../shared/SettingsDefaultsManager.js";
import {
  parseSearchResponse,
  type RealOpenCodeEventType,
} from "./contract.js";

/**
 * OpenCode plugin entry module.
 *
 * IMPORTANT: this module must export ONLY the default plugin factory.
 * OpenCode's plugin loader imports the entry module and treats EVERY export as
 * a plugin factory: each one must be a function, and each one gets INVOKED.
 * Non-function exports fail the whole plugin load with
 * "Plugin export is not a function"; extra function exports would be called as
 * plugins a second time. The event-contract constants and the search-response
 * parser therefore live in `contract.ts` (#3330).
 */

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
  // OpenCode passes the tool arguments here, on the hook's FIRST argument —
  // the output object never carries them (#3678 diagnosis by kevinchiha;
  // cross-checked against OpenCode 1.18's Hooks type, where the output is
  // only { title, output, metadata }).
  args?: Record<string, unknown>;
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

function resolveWorkerHost(): string {
  return SettingsDefaultsManager.get("CLAUDE_MEM_WORKER_HOST");
}

const WORKER_BASE_URL = `http://${resolveWorkerHost()}:${resolveWorkerPort()}`;
const MAX_TOOL_RESPONSE_LENGTH = 1000;

// Identifies these POSTs as coming from OpenCode. Without it the worker
// attributes OpenCode sessions to its default platform source ("claude"), so
// viewer badges and source-scoped session lookups are wrong (#3678).
const PLATFORM_SOURCE = "opencode";

const JSON_HEADERS: Record<string, string> = { "Content-Type": "application/json" };

function workerPostFireAndForget(
  path: string,
  body: Record<string, unknown>,
): void {
  fetch(`${WORKER_BASE_URL}${path}`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("ECONNREFUSED")) {
      console.warn(`[claude-mem] Worker POST ${path} failed: ${message}`);
    }
  });
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

/**
 * The last path segment of a Windows- or POSIX-style path, without any
 * platform-specific path module (the plugin bundle must stay dependency-free
 * beyond what the bundler inlines).
 */
function basenameOf(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const parts = value.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1];
}

/**
 * The project name claude-mem attributes the session to.
 *
 * `ctx.project?.name` is NOT the repository name in OpenCode — it resolves to
 * the constant "opencode", which lumps every project into one bucket. The
 * worktree root (falling back to the session directory) is the same repo-root
 * identity the rest of claude-mem keys projects by.
 */
function resolveProjectName(ctx: OpenCodePluginContext): string {
  return (
    basenameOf(ctx.worktree) ||
    basenameOf(ctx.directory) ||
    ctx.project?.name ||
    "opencode"
  );
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
 * The first user prompt travels with the init so the worker records what the
 * session was actually asked instead of its "[media prompt]" placeholder.
 */
function ensureSessionInitialized(
  openCodeSessionId: string,
  projectName: string,
  prompt = "",
): string {
  const contentSessionId = getOrCreateContentSessionId(openCodeSessionId);
  if (!initializedSessionIds.has(openCodeSessionId)) {
    initializedSessionIds.add(openCodeSessionId);
    workerPostFireAndForget("/api/sessions/init", {
      contentSessionId,
      project: projectName,
      prompt,
      platform_source: PLATFORM_SOURCE,
    });
  }
  return contentSessionId;
}

function truncate(text: string): string {
  return text.length > MAX_TOOL_RESPONSE_LENGTH
    ? text.slice(0, MAX_TOOL_RESPONSE_LENGTH)
    : text;
}

const ClaudeMemPlugin = async (ctx: OpenCodePluginContext) => {
  const projectName = resolveProjectName(ctx);

  console.log(`[claude-mem] OpenCode plugin loading (project: ${projectName})`);

  return {
    // Capture every tool execution as an observation. This is the primary
    // capture path (#2419).
    "tool.execute.after": async (
      input: ToolExecuteAfterInput,
      output: ToolExecuteAfterOutput,
    ): Promise<void> => {
      const contentSessionId = ensureSessionInitialized(input.sessionID, projectName);
      workerPostFireAndForget("/api/sessions/observations", {
        contentSessionId,
        tool_name: input.tool,
        // Arguments live on the hook input (see ToolExecuteAfterInput). The
        // output.args fallback covers older OpenCode versions the support
        // matrix still claims (1.16/1.17) whose output shape is unverified.
        // Reading output.args alone shipped empty tool_input for every
        // observation, and the compressor dismissed them all — the
        // "plugin loads but captures nothing" symptom of #3678.
        tool_input: input.args || output.args || {},
        tool_response: truncate(output.output || ""),
        cwd: ctx.directory,
        platform_source: PLATFORM_SOURCE,
      });
    },

    // Capture the user's prompt with the lazy session init, and assistant
    // messages as observations.
    "chat.message": async (
      _input: Record<string, unknown>,
      output: ChatMessageOutput,
    ): Promise<void> => {
      const sessionID = output.message?.sessionID;
      if (!sessionID) return;

      if (output.message?.role === "user") {
        const promptText = (output.parts || [])
          .filter((part) => part.type === "text" && typeof part.text === "string")
          .map((part) => part.text as string)
          .join("\n")
          .trim();
        ensureSessionInitialized(sessionID, projectName, promptText);
        return;
      }
      if (output.message?.role !== "assistant") return;

      const contentSessionId = ensureSessionInitialized(sessionID, projectName);
      const messageText = (output.parts || [])
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text as string)
        .join("\n");
      if (!messageText) return;

      workerPostFireAndForget("/api/sessions/observations", {
        contentSessionId,
        tool_name: "assistant_message",
        tool_input: {},
        tool_response: truncate(messageText),
        cwd: ctx.directory,
        platform_source: PLATFORM_SOURCE,
      });
    },

    // Summarize when a session compacts. This is OpenCode's real compaction
    // hook (the old `session.compacted` bus event never existed).
    "experimental.session.compacting": async (
      input: SessionCompactingInput,
    ): Promise<void> => {
      const contentSessionId = ensureSessionInitialized(input.sessionID, projectName);
      workerPostFireAndForget("/api/sessions/summarize", {
        contentSessionId,
        last_assistant_message: "",
        platform_source: PLATFORM_SOURCE,
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
          // Best-effort summarize once a session goes idle. The platform
          // source must match the one session-init used, or the worker's
          // source-scoped session lookup misses and summarizes into a fresh,
          // mis-attributed session row (#3678).
          const contentSessionId = ensureSessionInitialized(sessionID, projectName);
          workerPostFireAndForget("/api/sessions/summarize", {
            contentSessionId,
            last_assistant_message: "",
            platform_source: PLATFORM_SOURCE,
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

export default ClaudeMemPlugin;
