import { z } from "zod";
import { join } from "node:path";
import { SettingsDefaultsManager } from "../../shared/SettingsDefaultsManager.js";
import {
  parseSearchResponse,
  type RealOpenCodeEventType,
} from "./contract.js";
import { normalizePlatformSource } from "../../shared/platform-source.js";
// Dependency-free, so it stays bundle-safe for the plugin (no worker-only imports).
import { isConnectionRefusedError } from "../../shared/connection-errors.js";

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
  const settingsPath = join(
    SettingsDefaultsManager.get("CLAUDE_MEM_DATA_DIR"),
    "settings.json",
  );
  return SettingsDefaultsManager.loadFromFile(settingsPath).CLAUDE_MEM_WORKER_PORT;
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

// A refused connection means the worker is simply not running and must stay
// quiet. isConnectionRefusedError recognizes Bun's and undici's shapes, which a
// message.includes('ECONNREFUSED') check misses (OpenCode hosts plugins under Bun).
function workerPostFireAndForget(
  path: string,
  body: Record<string, unknown>,
): void {
  fetch(`${WORKER_BASE_URL}${path}`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      ...body,
      platformSource: normalizePlatformSource(PLATFORM_SOURCE),
    }),
  }).catch((error: unknown) => {
    if (!isConnectionRefusedError(error)) {
      const message = error instanceof Error ? error.message : String(error);
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
    if (!isConnectionRefusedError(error)) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[claude-mem] Worker GET ${path} failed: ${message}`);
    }
    return null;
  }
}

const contentSessionIdsByOpenCodeSessionId = new Map<string, string>();

const MAX_SESSION_MAP_ENTRIES = 1000;

function getOrCreateContentSessionId(openCodeSessionId: string): string {
  if (!contentSessionIdsByOpenCodeSessionId.has(openCodeSessionId)) {
    while (contentSessionIdsByOpenCodeSessionId.size >= MAX_SESSION_MAP_ENTRIES) {
      const oldestKey = contentSessionIdsByOpenCodeSessionId.keys().next().value;
      if (oldestKey !== undefined) {
        contentSessionIdsByOpenCodeSessionId.delete(oldestKey);
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
 * Resolves the stable local ID for all OpenCode activity without contacting the
 * worker. Session init means "a user prompt happened", not "ensure a session
 * row exists": observations and summarize create their own rows. Posting init
 * without a prompt manufactures a "[media prompt]" at prompt #1 and attributes
 * a preceding tool observation to it (#3803).
 */
function resolveContentSessionId(openCodeSessionId: string): string {
  return getOrCreateContentSessionId(openCodeSessionId);
}

/**
 * Records a real user prompt with the worker. Every user prompt posts init,
 * matching the Claude Code path; the worker de-duplicates identical prompts
 * within its time window (#3803).
 *
 * The body carries the checkout, not a project key. `ctx.project?.name` is not
 * the repository (it resolves to "opencode" for every project), and resolving
 * the key here would mean a second copy of the identity rules (markers,
 * environments, git-remote slugs, worktree and submodule composites) inside
 * OpenCode's process. The worker keys the session with the same shared
 * resolver it applies to this plugin's observations, so init and capture
 * always agree.
 */
function initializeSessionForUserPrompt(
  openCodeSessionId: string,
  cwd: string,
  prompt: string,
): string {
  const contentSessionId = resolveContentSessionId(openCodeSessionId);
  workerPostFireAndForget("/api/sessions/init", {
    contentSessionId,
    prompt,
    cwd,
    platform_source: PLATFORM_SOURCE,
  });
  return contentSessionId;
}

function truncate(text: string): string {
  return text.length > MAX_TOOL_RESPONSE_LENGTH
    ? text.slice(0, MAX_TOOL_RESPONSE_LENGTH)
    : text;
}

const ClaudeMemPlugin = async (ctx: OpenCodePluginContext) => {
  console.log(`[claude-mem] OpenCode plugin loading (directory: ${ctx.directory})`);

  return {
    // Capture every tool execution as an observation. This is the primary
    // capture path (#2419).
    "tool.execute.after": async (
      input: ToolExecuteAfterInput,
      output: ToolExecuteAfterOutput,
    ): Promise<void> => {
      const contentSessionId = resolveContentSessionId(input.sessionID);
      workerPostFireAndForget("/api/sessions/observations", {
        contentSessionId,
        tool_name: input.tool,
        // OpenCode passes the tool arguments on the hook input; the output
        // object only carries { title, output, metadata }. Reading output.args
        // instead shipped an empty tool_input for every observation, and the
        // compressor dismissed them all — the "loads but captures nothing"
        // symptom of #3678.
        tool_input: input.args || {},
        tool_response: truncate(output.output || ""),
        cwd: ctx.directory,
        platform_source: PLATFORM_SOURCE,
      });
    },

    // Capture each real user prompt with session init, and assistant messages
    // as observations.
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
        if (promptText) {
          initializeSessionForUserPrompt(sessionID, ctx.directory, promptText);
        } else {
          resolveContentSessionId(sessionID);
        }
        return;
      }
      if (output.message?.role !== "assistant") return;

      const contentSessionId = resolveContentSessionId(sessionID);
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
      const contentSessionId = resolveContentSessionId(input.sessionID);
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
          const contentSessionId = resolveContentSessionId(sessionID);
          workerPostFireAndForget("/api/sessions/summarize", {
            contentSessionId,
            last_assistant_message: "",
            platform_source: PLATFORM_SOURCE,
          });
          break;
        }
        case "session.deleted": {
          contentSessionIdsByOpenCodeSessionId.delete(sessionID);
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
