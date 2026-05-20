import { z } from "zod";

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
  args: Record<string, unknown>;
}

interface ToolExecuteAfterOutput {
  title: string;
  output: string;
  metadata: Record<string, unknown>;
}

interface ChatMessageInput {
  sessionID: string;
  agent?: string;
  model?: { providerID: string; modelID: string };
  messageID?: string;
  variant?: string;
}

interface SessionCompactingInput {
  sessionID: string;
}

interface SessionCompactingOutput {
  context: string[];
  prompt?: string;
}

interface ToolDefinition {
  description: string;
  args: Record<string, unknown>;
  execute: (args: Record<string, unknown>, context: unknown) => Promise<string>;
}

interface OpenCodeEventInput {
  event: {
    type: string;
    properties: Record<string, unknown>;
  };
}

function resolveWorkerPort(): string {
  const fromEnv = process.env.CLAUDE_MEM_WORKER_PORT;
  const parsed = fromEnv ? Number.parseInt(fromEnv.trim(), 10) : NaN;
  if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535) {
    return String(parsed);
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : 77;
  return String(37700 + (uid % 100));
}

const WORKER_BASE_URL = `http://127.0.0.1:${resolveWorkerPort()}`;
const MAX_TOOL_RESPONSE_LENGTH = 1000;
const MAX_SESSION_MAP_ENTRIES = 1000;
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

function truncate(text: string): string {
  return text.length > MAX_TOOL_RESPONSE_LENGTH
    ? text.slice(0, MAX_TOOL_RESPONSE_LENGTH)
    : text;
}

export const ClaudeMemPlugin = async (ctx: OpenCodePluginContext) => {
  const projectName = ctx.project?.name || "opencode";

  console.log(`[claude-mem] OpenCode plugin loading (project: ${projectName})`);

  // Per-plugin-instance state. Keeping these inside the factory closure (rather
  // than at module scope) gives each `ClaudeMemPlugin(ctx)` call a fresh map/set,
  // which keeps the idempotency guards (no double `/api/sessions/init`, no double
  // `/api/sessions/summarize`) provable from unit tests that re-instantiate the
  // plugin in `beforeEach` instead of having to hand-clear module globals.
  const contentSessionIdsByOpenCodeSessionId = new Map<string, string>();
  const initializedSessions = new Set<string>();

  function getOrCreateContentSessionId(openCodeSessionId: string): string {
    if (!contentSessionIdsByOpenCodeSessionId.has(openCodeSessionId)) {
      while (contentSessionIdsByOpenCodeSessionId.size >= MAX_SESSION_MAP_ENTRIES) {
        const oldestKey = contentSessionIdsByOpenCodeSessionId.keys().next().value;
        if (oldestKey !== undefined) {
          contentSessionIdsByOpenCodeSessionId.delete(oldestKey);
          initializedSessions.delete(oldestKey);
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

  function ensureSessionInitialized(openCodeSessionId: string): string {
    const contentSessionId = getOrCreateContentSessionId(openCodeSessionId);
    if (!initializedSessions.has(openCodeSessionId)) {
      initializedSessions.add(openCodeSessionId);
      workerPostFireAndForget("/api/sessions/init", {
        contentSessionId,
        project: projectName,
        prompt: "",
      });
    }
    return contentSessionId;
  }

  return {
    "tool.execute.after": async (
      input: ToolExecuteAfterInput,
      output: ToolExecuteAfterOutput,
    ): Promise<void> => {
      const contentSessionId = ensureSessionInitialized(input.sessionID);
      workerPostFireAndForget("/api/sessions/observations", {
        contentSessionId,
        tool_name: input.tool,
        tool_input: input.args || {},
        tool_response: truncate(output.output || ""),
        cwd: ctx.directory,
      });
    },

    "chat.message": async (input: ChatMessageInput): Promise<void> => {
      if (!input?.sessionID) return;
      ensureSessionInitialized(input.sessionID);
    },

    "experimental.session.compacting": async (
      input: SessionCompactingInput,
      _output: SessionCompactingOutput,
    ): Promise<void> => {
      if (!input?.sessionID) return;
      // Lazy-init only. The summarize POST is intentionally NOT fired here —
      // OpenCode emits the matching `session.compacted` event after compaction
      // completes, and that branch (below) owns the single summarize call.
      // Posting from both signals would double-write the summary row per
      // compaction cycle (claude-mem#2503 P1 review).
      ensureSessionInitialized(input.sessionID);
    },

    event: async (eventInput: OpenCodeEventInput): Promise<void> => {
      const e = eventInput?.event;
      if (!e || typeof e.type !== "string") return;
      const props = (e.properties || {}) as Record<string, unknown>;

      switch (e.type) {
        case "session.created": {
          const sid = (props.info as { id?: string } | undefined)?.id;
          if (sid) ensureSessionInitialized(sid);
          break;
        }

        case "message.updated": {
          const info = props.info as
            | { role?: string; sessionID?: string; content?: unknown }
            | undefined;
          if (!info || info.role !== "assistant" || !info.sessionID) break;
          const contentSessionId = ensureSessionInitialized(info.sessionID);
          const text = typeof info.content === "string" ? info.content : "";
          workerPostFireAndForget("/api/sessions/observations", {
            contentSessionId,
            tool_name: "assistant_message",
            tool_input: {},
            tool_response: truncate(text),
            cwd: ctx.directory,
          });
          break;
        }

        case "session.compacted": {
          const sid = props.sessionID as string | undefined;
          if (!sid) break;
          const contentSessionId = ensureSessionInitialized(sid);
          workerPostFireAndForget("/api/sessions/summarize", {
            contentSessionId,
            last_assistant_message: "",
          });
          break;
        }

        case "session.deleted": {
          const sid = (props.info as { id?: string } | undefined)?.id;
          if (sid) {
            contentSessionIdsByOpenCodeSessionId.delete(sid);
            initializedSessions.delete(sid);
          }
          break;
        }
      }
    },

    tool: {
      claude_mem_search: {
        description:
          "Search claude-mem memory database for past observations, sessions, and context",
        args: {
          query: z.string().describe("Search query for memory observations"),
        },
        async execute(
          args: Record<string, unknown>,
        ): Promise<string> {
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

          let data: any;
          try {
            data = JSON.parse(text);
          } catch (error: unknown) {
            console.warn('[claude-mem] Failed to parse search results:', error instanceof Error ? error.message : String(error));
            return "Failed to parse search results.";
          }

          const items = Array.isArray(data.items) ? data.items : [];
          if (items.length === 0) {
            return `No results found for "${query}".`;
          }

          return items
            .slice(0, 10)
            .map((item: Record<string, unknown>, index: number) => {
              const title = String(item.title || item.subtitle || "Untitled");
              const project = item.project ? ` [${String(item.project)}]` : "";
              return `${index + 1}. ${title}${project}`;
            })
            .join("\n");
        },
      } satisfies ToolDefinition,
    },
  };
};

export default ClaudeMemPlugin;
