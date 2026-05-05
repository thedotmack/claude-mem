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

interface ToolDefinition {
  description: string;
  args: Record<string, unknown>;
  execute: (args: Record<string, unknown>, context: unknown) => Promise<string>;
}

interface SessionCreatedEvent {
  event: {
    sessionID: string;
    directory?: string;
    project?: string;
  };
}

interface MessageUpdatedEvent {
  event: {
    sessionID: string;
    role: string;
    content: string;
  };
}

interface SessionCompactedEvent {
  event: {
    sessionID: string;
    summary?: string;
    messageCount?: number;
  };
}

interface FileEditedEvent {
  event: {
    sessionID: string;
    path: string;
    diff?: string;
  };
}

interface SessionDeletedEvent {
  event: {
    sessionID: string;
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

export const ClaudeMemPlugin = async (ctx: OpenCodePluginContext) => {
  const projectName = ctx.project?.name || "opencode";

  console.log(`[claude-mem] OpenCode plugin loading (project: ${projectName})`);

  return {
    hooks: {
      tool: {
        execute: {
          after: (
            input: ToolExecuteAfterInput,
            output: ToolExecuteAfterOutput,
          ) => {
            const contentSessionId = getOrCreateContentSessionId(input.sessionID);

            let toolResponseText = output.output || "";
            if (toolResponseText.length > MAX_TOOL_RESPONSE_LENGTH) {
              toolResponseText = toolResponseText.slice(0, MAX_TOOL_RESPONSE_LENGTH);
            }

            workerPostFireAndForget("/api/sessions/observations", {
              contentSessionId,
              tool_name: input.tool,
              tool_input: input.args || {},
              tool_response: toolResponseText,
              cwd: ctx.directory,
            });
          },
        },
      },
    },

    event: (eventName: string, payload: unknown) => {
      switch (eventName) {
        case "session.created": {
          const { event } = payload as SessionCreatedEvent;
          const contentSessionId = getOrCreateContentSessionId(event.sessionID);

          workerPostFireAndForget("/api/sessions/init", {
            contentSessionId,
            project: projectName,
            prompt: "",
          });
          break;
        }

        case "message.updated": {
          const { event } = payload as MessageUpdatedEvent;

          if (event.role !== "assistant") break;

          const contentSessionId = getOrCreateContentSessionId(event.sessionID);

          let messageText = event.content || "";
          if (messageText.length > MAX_TOOL_RESPONSE_LENGTH) {
            messageText = messageText.slice(0, MAX_TOOL_RESPONSE_LENGTH);
          }

          workerPostFireAndForget("/api/sessions/observations", {
            contentSessionId,
            tool_name: "assistant_message",
            tool_input: {},
            tool_response: messageText,
            cwd: ctx.directory,
          });
          break;
        }

        case "session.compacted": {
          const { event } = payload as SessionCompactedEvent;
          const contentSessionId = getOrCreateContentSessionId(event.sessionID);

          workerPostFireAndForget("/api/sessions/summarize", {
            contentSessionId,
            last_assistant_message: event.summary || "",
          });
          break;
        }

        case "file.edited": {
          const { event } = payload as FileEditedEvent;
          const contentSessionId = getOrCreateContentSessionId(event.sessionID);

          workerPostFireAndForget("/api/sessions/observations", {
            contentSessionId,
            tool_name: "file_edit",
            tool_input: { path: event.path },
            tool_response: event.diff
              ? event.diff.slice(0, MAX_TOOL_RESPONSE_LENGTH)
              : `File edited: ${event.path}`,
            cwd: ctx.directory,
          });
          break;
        }

        case "session.deleted": {
          const { event } = payload as SessionDeletedEvent;
          contentSessionIdsByOpenCodeSessionId.delete(event.sessionID);
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
