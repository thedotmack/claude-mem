/**
 * OpenCode V1 plugin adapter.
 *
 * V1 plugins are an async factory that RETURNS a hooks object, keyed by
 * OpenCode's hook names. Kept for OpenCode 1.18.29+, which loads the module's
 * default export and calls `server()`. V2 reads `id` + `setup()` instead (see
 * ./v2.ts); the entry module serves both.
 */

import { z } from "zod";
import { createCore, type ClaudeMemCore, type CoreContext } from "./core.js";
import { type RealOpenCodeEventType } from "./contract.js";

interface OpenCodeProject {
  name?: string;
  path?: string;
}

export interface OpenCodePluginContextV1 extends CoreContext {
  project?: OpenCodeProject;
  worktree?: string;
  serverUrl?: URL;
  $?: unknown;
}

export interface ToolExecuteAfterInput {
  tool: string;
  sessionID: string;
  callID: string;
  // OpenCode passes the tool arguments here, on the hook's FIRST argument —
  // the output object never carries them (#3678 diagnosis by kevinchiha;
  // cross-checked against OpenCode 1.18's Hooks type, where the output is
  // only { title, output, metadata }).
  args?: Record<string, unknown>;
}

export interface ToolExecuteAfterOutput {
  title: string;
  output: string;
  metadata: Record<string, unknown>;
  args?: Record<string, unknown>;
}

export interface ChatMessageOutput {
  message: {
    id?: string;
    role?: string;
    sessionID?: string;
  };
  parts: Array<{ type: string; text?: string }>;
}

export interface SessionCompactingInput {
  sessionID: string;
}

export interface BusEvent {
  type: string;
  properties?: {
    sessionID?: string;
    info?: { id?: string };
  };
}

function textOfParts(parts: Array<{ type: string; text?: string }>): string {
  return (parts || [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n");
}

export function createV1Hooks(ctx: OpenCodePluginContextV1) {
  console.log(`[claude-mem] OpenCode plugin loading (directory: ${ctx.directory})`);
  const core: ClaudeMemCore = createCore(ctx);

  return {
    // Capture every tool execution as an observation. This is the primary
    // capture path (#2419).
    "tool.execute.after": async (
      input: ToolExecuteAfterInput,
      output: ToolExecuteAfterOutput,
    ): Promise<void> => {
      await core.captureTool({
        tool: input.tool,
        sessionID: input.sessionID,
        args: input.args,
        output: output.output || "",
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
        const promptText = textOfParts(output.parts).trim();
        if (promptText) {
          await core.captureUserPrompt(sessionID, promptText);
        }
        return;
      }
      if (output.message?.role !== "assistant") return;

      await core.captureAssistantMessage(sessionID, textOfParts(output.parts));
    },

    // Summarize when a session compacts. This is OpenCode's real compaction
    // hook (the old `session.compacted` bus event never existed). Compaction
    // also drops the cached memory, so the next system prompt carries fresh
    // context; an idle summary keeps it.
    "experimental.session.compacting": async (
      input: SessionCompactingInput,
    ): Promise<void> => {
      core.forgetMemoryContext(input.sessionID);
      await core.captureSummary(input.sessionID);
    },

    // Inject memory context into the system prompt OpenCode builds for each
    // request: this project's own memory, current, rather than one global
    // AGENTS.md block shared by every project.
    "experimental.chat.system.transform": async (
      input: { sessionID?: string },
      output: { system: string[] },
    ): Promise<void> => {
      const context = await core.memoryContext(input.sessionID ?? "");
      if (context?.trim()) output.system.push(context);
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
          await core.captureSummary(sessionID);
          break;
        }
        case "session.deleted": {
          core.forgetSession(sessionID);
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
        execute: async (args: Record<string, unknown>): Promise<string> =>
          core.search(String(args.query || "")),
      },
    },
  };
}

export type OpenCodeV1Hooks = ReturnType<typeof createV1Hooks>;
