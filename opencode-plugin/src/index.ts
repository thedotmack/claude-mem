import { type Plugin, tool } from "@opencode-ai/plugin";
import { WorkerClient } from "./worker-client";

// Simple in-memory map to store tool arguments between before/after hooks
const callArgsMap = new Map<string, any>();

/**
 * OpenCode Plugin for Claude-Mem
 */
export const ClaudeMemPlugin: Plugin = async (ctx) => {
  const { project, client, $ } = ctx;

  // Cast project to any to access properties that might exist at runtime even if types are incomplete
  const p = project as any;
  const projectRoot = p.path || p.directory || process.cwd();
  const projectName = p.name || "unknown-project";

  // Try to ensure worker is running (best effort)
  WorkerClient.ensureRunning(projectRoot);

  let currentSessionId: string | null = null;

  return {
    /**
     * Hook: Session Created
     * Purpose: Initialize session in worker and inject memory context
     */
    "session.created": async (session: any) => {
      currentSessionId = session.id;

      const isHealthy = await WorkerClient.isHealthy();
      if (isHealthy) {
          try {
             await WorkerClient.sessionInit(session.id, projectName, "SESSION_START");

             // Inject context
             const context = await WorkerClient.search("recent observations", projectName);

             if (Array.isArray(session.messages)) {
                 session.messages.push({
                     role: "system",
                     content: `[Claude-Mem] Memory Active. Previous Context:\n${context}`
                 });
             }
          } catch (e) {
              console.error("[Claude-Mem] Failed to inject context", e);
          }
      }
    },

    /**
     * Hook: Tool Execute Before
     * Purpose: Capture tool arguments
     * Note: The second argument contains the tool arguments (input to the tool)
     */
    "tool.execute.before": async (input: { tool: string; sessionID: string; callID: string }, args: { args: any }) => {
        if (input.callID) {
            callArgsMap.set(input.callID, args.args);
        }
    },

    /**
     * Hook: Tool Execution After
     * Purpose: Capture observations
     */
    "tool.execute.after": async (input: { tool: string; sessionID: string; callID: string }, output: { title: string; output: string; metadata: any }) => {
      // Use stored session ID or input.sessionID
      const sessionId = input.sessionID || currentSessionId;
      if (!sessionId) return;

      const toolName = input.tool;
      const toolResult = output.output; // The output text is here

      // Retrieve args from map
      const toolArgs = callArgsMap.get(input.callID) || {};
      callArgsMap.delete(input.callID); // Cleanup

      // Send to worker
      await WorkerClient.sendObservation(
        sessionId,
        toolName,
        toolArgs,
        toolResult,
        projectRoot // cwd
      );
    },

    /**
     * Hook: Session End (Idle)
     * Purpose: Generate summary
     */
    "session.idle": async (session: any) => {
        if (!currentSessionId && session.id) currentSessionId = session.id;
        if (!currentSessionId) return;

        const messages = session.messages || [];
        const lastUser = messages.filter((m: any) => m.role === 'user').pop()?.content || "";
        const lastAssistant = messages.filter((m: any) => m.role === 'assistant').pop()?.content || "";

        await WorkerClient.summarize(currentSessionId, lastUser, lastAssistant);
        await WorkerClient.completeSession(currentSessionId);
    },

    /**
     * Hook: Message Updated
     * Purpose: Capture user prompt if needed for session init
     */
    "message.updated": async (message: any) => {
        if (message.role === 'user' && currentSessionId) {
             await WorkerClient.sessionInit(currentSessionId, projectName, message.content);
        }
    },

    /**
     * Custom Tool: Mem-Search
     */
    tool: {
        "mem-search": tool({
            description: "Search project history and memory. Use this to find information about past decisions, code changes, or bug fixes.",
            args: {
                query: tool.schema.string()
            },
            execute: async (args: { query: string }) => {
                return await WorkerClient.search(args.query, projectName);
            }
        })
    }
  };
};
