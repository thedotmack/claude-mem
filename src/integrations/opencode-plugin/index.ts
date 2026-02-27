/**
 * OpenCode Plugin for claude-mem
 *
 * Integrates claude-mem persistent memory with OpenCode (110k+ stars).
 * Runs inside OpenCode's Bun-based plugin runtime.
 *
 * Plugin hooks:
 * - tool.execute.after: Captures tool execution observations
 * - Bus events: session.created, message.updated, session.compacted,
 *   file.edited, session.deleted
 *
 * Custom tool:
 * - claude_mem_search: Search memory database from within OpenCode
 */

// ============================================================================
// Minimal type declarations for OpenCode Plugin SDK
// These match the runtime API provided by @opencode-ai/plugin
// ============================================================================

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
  $: unknown; // BunShell
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

// Bus event payloads
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

// ============================================================================
// Constants
// ============================================================================

const WORKER_BASE_URL = "http://127.0.0.1:37777";
const MAX_TOOL_RESPONSE_LENGTH = 1000;

// ============================================================================
// Worker HTTP Client
// ============================================================================

async function workerPost(
  path: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(`${WORKER_BASE_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      console.warn(`[claude-mem] Worker POST ${path} returned ${response.status}`);
      return null;
    }
    return (await response.json()) as Record<string, unknown>;
  } catch (error: unknown) {
    // Gracefully handle ECONNREFUSED — worker may not be running
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("ECONNREFUSED")) {
      console.warn(`[claude-mem] Worker POST ${path} failed: ${message}`);
    }
    return null;
  }
}

function workerPostFireAndForget(
  path: string,
  body: Record<string, unknown>,
): void {
  fetch(`${WORKER_BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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
    const response = await fetch(`${WORKER_BASE_URL}${path}`);
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

// ============================================================================
// Session tracking
// ============================================================================

const contentSessionIdsByOpenCodeSessionId = new Map<string, string>();

function getOrCreateContentSessionId(openCodeSessionId: string): string {
  if (!contentSessionIdsByOpenCodeSessionId.has(openCodeSessionId)) {
    contentSessionIdsByOpenCodeSessionId.set(
      openCodeSessionId,
      `opencode-${openCodeSessionId}-${Date.now()}`,
    );
  }
  return contentSessionIdsByOpenCodeSessionId.get(openCodeSessionId)!;
}

// ============================================================================
// Plugin Entry Point
// ============================================================================

export const ClaudeMemPlugin = async (ctx: OpenCodePluginContext) => {
  const projectName = ctx.project?.name || "opencode";

  console.log(`[claude-mem] OpenCode plugin loading (project: ${projectName})`);

  return {
    // ------------------------------------------------------------------
    // Direct interceptor hooks
    // ------------------------------------------------------------------
    hooks: {
      tool: {
        execute: {
          after: (
            input: ToolExecuteAfterInput,
            output: ToolExecuteAfterOutput,
          ) => {
            const contentSessionId = getOrCreateContentSessionId(input.sessionID);

            // Truncate long tool output
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

    // ------------------------------------------------------------------
    // Bus event handlers
    // ------------------------------------------------------------------
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

          // Only capture assistant messages as observations
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
          const contentSessionId = contentSessionIdsByOpenCodeSessionId.get(
            event.sessionID,
          );

          if (contentSessionId) {
            workerPostFireAndForget("/api/sessions/complete", {
              contentSessionId,
            });
            contentSessionIdsByOpenCodeSessionId.delete(event.sessionID);
          }
          break;
        }
      }
    },

    // ------------------------------------------------------------------
    // Custom tools
    // ------------------------------------------------------------------
    tool: {
      claude_mem_search: {
        description:
          "Search claude-mem memory database for past observations, sessions, and context",
        args: {
          query: {
            type: "string",
            description: "Search query for memory observations",
          },
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

          try {
            const data = JSON.parse(text);
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
          } catch {
            return "Failed to parse search results.";
          }
        },
      } satisfies ToolDefinition,
    },
  };
};

export default ClaudeMemPlugin;
