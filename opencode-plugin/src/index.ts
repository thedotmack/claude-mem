import { type Plugin, tool } from "@opencode-ai/plugin";
import { WorkerClient } from "./worker-client";
import { appendFileSync } from "fs";
import { basename } from "path";

const LOG_FILE = "/tmp/claude-mem-opencode.log";
const IDLE_CONFIRMATION_DELAY_MS = 60000;

function log(message: string, data?: any) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${message}${data ? ` | ${JSON.stringify(data)}` : ""}\n`;
  try {
    appendFileSync(LOG_FILE, line);
  } catch (e) {
    console.log(`[claude-mem] ${message}`, data);
  }
}

function getProjectName(directory: string): string {
  if (!directory || directory.trim() === '') return 'unknown-project';
  const name = basename(directory);
  return name || 'unknown-project';
}

const callArgsMap = new Map<string, any>();
const pendingStopTimers = new Map<string, ReturnType<typeof setTimeout>>();
const sessionActivitySinceIdle = new Map<string, boolean>();
const sessionUserMessages = new Map<string, string[]>();
const sessionAssistantMessages = new Map<string, string[]>();

function stripClaudeMemContext(text: string): string {
  return text.replace(/\[Claude-Mem Context\][\s\S]*?\[\/Claude-Mem Context\]\s*/g, "").trim();
}

function cancelPendingStop(sessionId: string): void {
  const timer = pendingStopTimers.get(sessionId);
  if (timer) {
    clearTimeout(timer);
    pendingStopTimers.delete(sessionId);
    log("Pending stop cancelled", { sessionId });
  }
}

function markActivitySinceIdle(sessionId: string): void {
  sessionActivitySinceIdle.set(sessionId, true);
}

export const ClaudeMemPlugin: Plugin = async (ctx) => {
  const { project, client, directory } = ctx;

  log("=== PLUGIN INITIALIZING ===", { directory });

  const p = project as any;
  const projectRoot = directory || p.worktree || p.path || process.cwd();
  const projectName = getProjectName(projectRoot);

  log("Project info", { projectRoot, projectName, worktree: p.worktree });

  // Try to ensure worker is running (best effort)
  const workerRunning = await WorkerClient.ensureRunning(projectRoot);
  log("Worker status", { running: workerRunning });

  const injectedSessions = new Set<string>();
  const initializedSessions = new Set<string>();

  log("=== PLUGIN INITIALIZED ===");

  return {
    "chat.message": async (
      input: { sessionID: string; messageID?: string },
      output: { message: Record<string, unknown>; parts: Array<{ type: string; text?: string; [key: string]: unknown }> }
    ): Promise<void> => {
      const sessionId = input.sessionID;
      
      if (!sessionId) return;

      const textParts = output.parts.filter(p => p.type === "text" && p.text);
      const userMessage = textParts.map(p => p.text ?? "").join("\n");
      const cleanedMessage = stripClaudeMemContext(userMessage);

      const isFirstMessage = !injectedSessions.has(sessionId);
      
      log("chat.message", { sessionId, messageLength: cleanedMessage.length, isFirstMessage });

      const isHealthy = await WorkerClient.isHealthy();
      if (!isHealthy) {
        log("chat.message - worker not healthy, skipping", { sessionId });
        if (isFirstMessage) injectedSessions.add(sessionId);
        return;
      }

      // ALWAYS save user messages to claude-mem (not just first)
      // sessionInit increments promptNumber for subsequent messages
      if (cleanedMessage.length > 0) {
        const messages = sessionUserMessages.get(sessionId) || [];
        messages.push(cleanedMessage);
        sessionUserMessages.set(sessionId, messages);
        
        const initResult = await WorkerClient.sessionInit(sessionId, projectName, cleanedMessage.slice(0, 2000));
        log("Saved user message", { initResult, sessionId, messageCount: messages.length });
        initializedSessions.add(sessionId);
      }

      // Only inject context on first message
      if (isFirstMessage) {
        const context = await WorkerClient.getContextForInjection(projectName);
        log("Context fetched", { length: context?.length || 0 });

        if (context && context.length > 0) {
          const firstTextPart = output.parts.find(p => p.type === "text" && p.text);
          if (firstTextPart && firstTextPart.text) {
            firstTextPart.text = `[Claude-Mem Context]\n${context}\n[/Claude-Mem Context]\n\n${firstTextPart.text}`;
            log("Context prepended to first text part", { sessionId });
          }
        }

        injectedSessions.add(sessionId);
      }
    },

    event: async ({ event }) => {
      log("EVENT received", { type: event.type });

      if (event.type === "session.created") {
        const sessionInfo = (event as any).properties?.info;
        const sessionId = sessionInfo?.id;
        log("session.created", { sessionId });
      }

      if (event.type === "session.status") {
        const props = (event as any).properties;
        const status = props?.status as { type: string } | undefined;
        const sessionId = props?.sessionID as string | undefined;

        if (status?.type !== "idle") return;
        if (!sessionId) return;

        log("session.status idle", { sessionId });

        if (!initializedSessions.has(sessionId)) {
          log("session.status idle - session not initialized, skipping", { sessionId });
          return;
        }

        sessionActivitySinceIdle.set(sessionId, false);

        cancelPendingStop(sessionId);

        const timer = setTimeout(async () => {
          pendingStopTimers.delete(sessionId);

          if (sessionActivitySinceIdle.get(sessionId)) {
            log("Stop cancelled - activity detected during idle confirmation", { sessionId });
            return;
          }

          log("Stop executing after confirmed idle", { sessionId, delayMs: IDLE_CONFIRMATION_DELAY_MS });

          try {
            const userMsgs = sessionUserMessages.get(sessionId) || [];
            const assistantMsgs = sessionAssistantMessages.get(sessionId) || [];
            
            const lastUserMsg = userMsgs.length > 0 ? userMsgs[userMsgs.length - 1] : "";
            const lastAssistantMsg = assistantMsgs.length > 0 ? assistantMsgs[assistantMsgs.length - 1] : "";
            
            log("Summarizing session", { 
              sessionId, 
              userMessageCount: userMsgs.length, 
              assistantMessageCount: assistantMsgs.length,
              lastUserMsgLength: lastUserMsg.length,
              lastAssistantMsgLength: lastAssistantMsg.length
            });
            
            await WorkerClient.summarize(sessionId, lastUserMsg, lastAssistantMsg);
            await WorkerClient.completeSession(sessionId);
            
            sessionUserMessages.delete(sessionId);
            sessionAssistantMessages.delete(sessionId);
            
            log("Session completed", { sessionId });
          } catch (e) {
            log("ERROR completing session", { error: String(e), sessionId });
          }
        }, IDLE_CONFIRMATION_DELAY_MS);

        pendingStopTimers.set(sessionId, timer);
        log("Stop scheduled", { sessionId, delayMs: IDLE_CONFIRMATION_DELAY_MS });
      }

      // Handle session updated
      if (event.type === "session.updated") {
        const sessionInfo = (event as any).properties?.info;
        log("session.updated", { sessionId: sessionInfo?.id });
      }

      if (event.type === "message.updated") {
        const msgInfo = (event as any).properties;
        log("message.updated", { role: msgInfo?.role, hasContent: !!msgInfo?.content });
        
        if (msgInfo?.sessionID) {
          markActivitySinceIdle(msgInfo.sessionID);
          cancelPendingStop(msgInfo.sessionID);
        }

        if (msgInfo?.role === "user" && msgInfo?.sessionID) {
          const sessionId = msgInfo.sessionID;
          if (!initializedSessions.has(sessionId)) {
            const rawContent = msgInfo.content || msgInfo.parts?.map((p: any) => p.text).join("") || "";
            const content = stripClaudeMemContext(rawContent);
            await WorkerClient.sessionInit(sessionId, projectName, content.length > 0 ? content.slice(0, 1000) : "SESSION_RESUME");
            initializedSessions.add(sessionId);
            log("Session initialized (resume) from message.updated", { sessionId });
          }
        }

        if (msgInfo?.role === "assistant" && msgInfo?.sessionID) {
          const content = msgInfo.content || msgInfo.parts?.map((p: any) => p.text).join("") || "";
          if (content.length > 0) {
            const messages = sessionAssistantMessages.get(msgInfo.sessionID) || [];
            messages.push(content);
            sessionAssistantMessages.set(msgInfo.sessionID, messages);
            log("Captured assistant response", { sessionId: msgInfo.sessionID, messageCount: messages.length });
          }
        }
      }
    },

    /**
     * Hook: Tool Execute Before
     * Purpose: Capture tool arguments before execution
     */
    "tool.execute.before": async (
      input: { tool: string; sessionID: string; callID: string },
      args: { args: any }
    ) => {
      log("tool.execute.before", { tool: input.tool, sessionID: input.sessionID, callID: input.callID });
      
      if (input.callID) {
        callArgsMap.set(input.callID, args.args);
      }

      if (input.sessionID) {
        markActivitySinceIdle(input.sessionID);
        cancelPendingStop(input.sessionID);
      }

      if (input.sessionID && !initializedSessions.has(input.sessionID)) {
        await WorkerClient.sessionInit(input.sessionID, projectName, "SESSION_RESUME");
        initializedSessions.add(input.sessionID);
        log("Session initialized (resume) from tool.execute.before", { sessionID: input.sessionID });
      }
    },

    /**
     * Hook: Tool Execution After
     * Purpose: Capture observations (tool inputs + outputs)
     */
    "tool.execute.after": async (
      input: { tool: string; sessionID: string; callID: string },
      output: { title: string; output: string; metadata: any }
    ) => {
      const sessionId = input.sessionID;
      
      log("tool.execute.after", { 
        tool: input.tool, 
        sessionID: sessionId, 
        callID: input.callID,
        outputLength: output.output?.length || 0 
      });

      if (sessionId) {
        markActivitySinceIdle(sessionId);
        cancelPendingStop(sessionId);
      }

      if (!sessionId) {
        log("tool.execute.after - NO SESSION ID, skipping observation");
        return;
      }

      const toolName = input.tool;
      const toolResult = output.output;

      const toolArgs = callArgsMap.get(input.callID) || {};
      callArgsMap.delete(input.callID);

      try {
        await WorkerClient.sendObservation(
          sessionId,
          toolName,
          toolArgs,
          toolResult,
          projectRoot
        );
        log("Observation sent", { tool: toolName, sessionId });
      } catch (e) {
        log("ERROR sending observation", { error: String(e), tool: toolName });
      }
    },

    /**
     * Custom Tool: Mem-Search
     * Allows the model to search memory on demand
     */
    tool: {
      "mem-search": tool({
        description: "Search project history and memory. Use this to find information about past decisions, code changes, or bug fixes.",
        args: {
          query: tool.schema.string().describe("Search query for memory")
        },
        execute: async (args: { query: string }) => {
          log("mem-search tool called", { query: args.query });
          const result = await WorkerClient.search(args.query, projectName);
          log("mem-search result", { length: result?.length || 0 });
          return result;
        }
      })
    }
  };
};
