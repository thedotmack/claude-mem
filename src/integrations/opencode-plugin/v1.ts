import { z } from "zod";
import { ensureSessionInitialized, forgetSession, initSession, resolveProjectName } from "./sessions.js";
import { parseSearchResponse, truncate, workerGetText, workerPostFireAndForget } from "./worker.js";

/**
 * OpenCode V1 (1.x) server plugin.
 *
 * OpenCode 1.x calls `server(input, options)` and binds the returned object's
 * keys as hooks (packages/plugin/src/index.ts @ v1.18.33):
 *
 *   - `tool.execute.after`              (input, output) — fires after every tool run
 *   - `chat.message`                    (input, output) — fires on each USER message
 *   - `event`                           ({ event })     — generic bus; event.type carries the name
 *   - `experimental.session.compacting`                 — fires when a session compacts
 *
 * The only bus event types this plugin reacts to are `session.idle`
 * (best-effort summarize) and `session.deleted` (forget the session mapping).
 */
export const V1_EVENT_TYPES = ["session.idle", "session.deleted"] as const;

type V1EventType = (typeof V1_EVENT_TYPES)[number];

/** The hook keys `server` returns. The contract test asserts these are real OpenCode 1.x hook names. */
export const V1_HOOKS = [
  "tool.execute.after",
  "chat.message",
  "event",
  "experimental.session.compacting",
] as const;

export interface OpenCodeV1PluginInput {
  directory: string;
  worktree?: string;
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
  parts: Array<{ type: string; text?: string; synthetic?: boolean }>;
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

export async function serverV1(ctx: OpenCodeV1PluginInput) {
  const projectName = resolveProjectName(ctx.worktree, ctx.directory);

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
        tool_input: input.args || output.args || {},
        tool_response: truncate(output.output || ""),
        cwd: ctx.directory,
      });
    },

    // OpenCode 1.x fires chat.message for the user's message, so this is where
    // the prompt text comes from. Synthetic parts are OpenCode-injected context,
    // not what the user typed (#4275).
    "chat.message": async (
      input: ChatMessageInput,
      output: ChatMessageOutput,
    ): Promise<void> => {
      const sessionID = output.message?.sessionID || input?.sessionID;
      if (!sessionID) return;
      if (output.message?.role && output.message.role !== "user") return;

      const prompt = (output.parts || [])
        .filter((part) => part.type === "text" && typeof part.text === "string" && !part.synthetic)
        .map((part) => part.text as string)
        .join("\n");
      initSession(sessionID, projectName, prompt);
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
      });
    },

    // Generic bus events. Only `session.idle` and `session.deleted` are acted upon.
    event: async ({ event }: { event: BusEvent }): Promise<void> => {
      const eventType = event?.type as V1EventType | undefined;
      const sessionID = event?.properties?.sessionID || event?.properties?.info?.id;
      if (!sessionID) return;

      switch (eventType) {
        case "session.idle": {
          const contentSessionId = ensureSessionInitialized(sessionID, projectName);
          workerPostFireAndForget("/api/sessions/summarize", {
            contentSessionId,
            last_assistant_message: "",
          });
          break;
        }
        case "session.deleted": {
          forgetSession(sessionID);
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
}
