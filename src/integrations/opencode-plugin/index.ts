/**
 * OpenCode Plugin for claude-mem
 *
 * Integrates claude-mem persistent memory with OpenCode (110k+ stars).
 * Runs inside OpenCode's Bun-based plugin runtime.
 *
 * SDK compatibility: @opencode-ai/plugin >= 1.2.23
 *
 * Hooks (flat string keys per SDK):
 * - "tool.execute.after": Captures tool execution observations
 * - "chat.message": Captures assistant responses after each conversation turn
 *
 * Events (SDK Event objects):
 * - session.created: Initialize claude-mem content session
 * - message.updated: Capture assistant message observations
 * - session.compacted: Trigger session summarization
 * - file.edited: Capture file edit observations
 * - session.idle: Trigger session completion when a conversation turn finishes
 * - session.deleted: Cleanup session on explicit deletion
 *
 * Custom tool:
 * - claude_mem_search: Search memory database from within OpenCode
 *   (For richer search, configure the claude-mem MCP server in opencode.json)
 */

import type { Plugin, PluginInput, Hooks } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";

// ============================================================================
// Constants
// ============================================================================

const WORKER_BASE_URL = "http://127.0.0.1:37777";
const MAX_TOOL_RESPONSE_LENGTH = 1000;

// ============================================================================
// Worker HTTP Client
// ============================================================================

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

function truncate(str: string, max: number = MAX_TOOL_RESPONSE_LENGTH): string {
  return str.length > max ? str.slice(0, max) : str;
}

// ============================================================================
// Plugin Entry Point
// ============================================================================

export const ClaudeMemPlugin: Plugin = async (ctx: PluginInput) => {
  const projectName = ctx.project?.name || "opencode";

  console.log(`[claude-mem] OpenCode plugin loading (project: ${projectName})`);

  return {
    // ------------------------------------------------------------------
    // Event handler: receives SDK Event objects
    //
    // The @opencode-ai/plugin SDK dispatches events as:
    //   event({ event: Event })
    // where Event has .type (string) and .properties (object).
    //
    // Event.properties vary by type — see inline comments below.
    // ------------------------------------------------------------------
    async event({ event }) {
      const type = event.type;
      const props = event.properties as Record<string, any>;

      switch (type) {
        case "session.created": {
          // props.info is a Session object with .id, .title, etc.
          const info = props.info;
          const contentSessionId = getOrCreateContentSessionId(info.id);

          console.log(`[claude-mem] session.created: ${info.id} → ${contentSessionId}`);
          workerPostFireAndForget("/api/sessions/init", {
            contentSessionId,
            project: projectName,
            prompt: info.title || "",
          });
          break;
        }

        case "message.updated": {
          // props.info is a Message object with .role, .id, etc.
          // NOTE: assistant message events can be high-volume with low signal.
          // If you experience worker queue congestion, consider disabling this
          // handler. Tool executions and chat.message hook already capture
          // the substantive content.
          const info = props.info;
          if (info.role !== "assistant") break;

          const contentSessionId = getOrCreateContentSessionId(props.sessionID);
          // Message content may not be directly available on the event;
          // use a placeholder. The chat.message hook captures full text.
          workerPostFireAndForget("/api/sessions/observations", {
            contentSessionId,
            tool_name: "assistant_message",
            tool_input: {},
            tool_response: truncate(String(info.content || "")),
            cwd: ctx.directory,
          });
          break;
        }

        case "session.compacted": {
          // Experimental event: fired when session context is compacted.
          // props.sessionID is available.
          const contentSessionId = getOrCreateContentSessionId(props.sessionID);

          workerPostFireAndForget("/api/sessions/summarize", {
            contentSessionId,
            last_assistant_message: "",
          });
          break;
        }

        case "file.edited": {
          // props.file is the file path (string).
          // This event doesn't carry a sessionID, so we skip it.
          // File edits are already captured via tool.execute.after hook
          // when the agent uses file editing tools.
          break;
        }

        case "session.idle": {
          // Fired when a session transitions from busy → idle (conversation
          // turn finished). This is the best signal for session completion
          // in OpenCode, since there is no explicit "session.completed" event.
          //
          // WORKAROUND: OpenCode does not fire a "session.completed" event.
          // session.idle fires after each conversation turn finishes, which
          // is the closest equivalent. This may fire multiple times per
          // session (once per turn), but the worker handles duplicate
          // completion calls gracefully (idempotent).
          const sid = props.sessionID;
          const contentSessionId = contentSessionIdsByOpenCodeSessionId.get(sid);
          if (contentSessionId) {
            workerPostFireAndForget("/api/sessions/summarize", {
              contentSessionId,
              last_assistant_message: "",
            });
            workerPostFireAndForget("/api/sessions/complete", {
              contentSessionId,
            });
          }
          break;
        }

        case "session.deleted": {
          // props.info is a Session object with .id
          const info = props.info;
          const contentSessionId = contentSessionIdsByOpenCodeSessionId.get(
            info.id,
          );

          if (contentSessionId) {
            workerPostFireAndForget("/api/sessions/complete", {
              contentSessionId,
            });
            contentSessionIdsByOpenCodeSessionId.delete(info.id);
          }
          break;
        }
      }
    },

    // ------------------------------------------------------------------
    // Hook: tool.execute.after (flat string key per SDK)
    //
    // Captures every tool execution as an observation.
    // ------------------------------------------------------------------
    "tool.execute.after": async (input, output) => {
      const contentSessionId = getOrCreateContentSessionId(input.sessionID);

      workerPostFireAndForget("/api/sessions/observations", {
        contentSessionId,
        tool_name: input.tool,
        tool_input: input.args || {},
        tool_response: truncate(output.output || ""),
        cwd: ctx.directory,
      });
    },

    // ------------------------------------------------------------------
    // Hook: chat.message (flat string key per SDK)
    //
    // Captures the assistant's response after each conversation turn.
    // This provides richer content than message.updated events since
    // it includes the fully assembled response parts.
    // ------------------------------------------------------------------
    "chat.message": async (input, output) => {
      const contentSessionId = getOrCreateContentSessionId(input.sessionID);

      // Extract text from assistant response parts
      const textParts = (output.parts || [])
        .filter((p) => p.type === "text")
        .map((p) => "text" in p ? String(p.text) : "")
        .join("\n");

      if (textParts) {
        workerPostFireAndForget("/api/sessions/observations", {
          contentSessionId,
          tool_name: "assistant_response",
          tool_input: { messageID: input.messageID },
          tool_response: truncate(textParts, 2000),
          cwd: ctx.directory,
        });
      }

      // Init session on first message if not already initialized
      // (covers the case where session.created event was missed)
      if (!contentSessionIdsByOpenCodeSessionId.has(input.sessionID)) {
        getOrCreateContentSessionId(input.sessionID);
        const userContent = output.message?.content;
        const userText = typeof userContent === "string"
          ? userContent
          : Array.isArray(userContent)
            ? userContent.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n")
            : "";

        workerPostFireAndForget("/api/sessions/init", {
          contentSessionId,
          project: projectName,
          prompt: truncate(userText, 500),
        });
      }
    },

    // ------------------------------------------------------------------
    // Custom tool: claude_mem_search
    //
    // Provides basic memory search directly within OpenCode.
    // For a richer search experience with timeline navigation and
    // observation details, configure the claude-mem MCP server
    // in your opencode.json instead.
    // ------------------------------------------------------------------
    tool: {
      claude_mem_search: tool({
        description:
          "Search claude-mem memory database for past observations, sessions, and context",
        args: {
          query: tool.schema.string().describe(
            "Search query for memory observations",
          ),
        },
        async execute(args, _context) {
          const query = args.query;
          if (!query) {
            return "Please provide a search query.";
          }

          const text = await workerGetText(
            `/api/search?query=${encodeURIComponent(query)}&limit=10`,
          );

          if (!text) {
            return "claude-mem worker is not running. Start it with: npx claude-mem start";
          }

          try {
            const data = JSON.parse(text);

            // Handle MCP format: { content: [{ type: 'text', text: '...' }] }
            if (data.content && Array.isArray(data.content)) {
              const resultText = data.content
                .map((c: { text?: string }) => c.text || "")
                .join("\n")
                .trim();
              return resultText || `No results found for "${query}".`;
            }

            // Handle legacy format: { items: [...] }
            const items = Array.isArray(data.items) ? data.items : [];
            if (items.length === 0) {
              return `No results found for "${query}".`;
            }

            return items
              .slice(0, 10)
              .map((item: Record<string, unknown>, index: number) => {
                const title = String(item.title || item.subtitle || "Untitled");
                const project = item.project
                  ? ` [${String(item.project)}]`
                  : "";
                return `${index + 1}. ${title}${project}`;
              })
              .join("\n");
          } catch {
            return "Failed to parse search results.";
          }
        },
      }),
    },
  } satisfies Hooks;
};

export default ClaudeMemPlugin;
