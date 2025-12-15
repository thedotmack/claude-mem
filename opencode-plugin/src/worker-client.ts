import { spawn } from "bun";
import type { Plugin } from "@opencode-ai/plugin";

/**
 * Worker Client for Claude-Mem
 * Handles communication with the local worker service running on port 37777.
 */
export class WorkerClient {
  private static readonly PORT = 37777;
  private static readonly BASE_URL = `http://127.0.0.1:${WorkerClient.PORT}`;

  /**
   * Check if the worker is healthy
   */
  static async isHealthy(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 1000); // 1s timeout

      const response = await fetch(`${this.BASE_URL}/api/health`, {
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      return response.ok;
    } catch (e) {
      return false;
    }
  }

  /**
   * Ensure the worker is running.
   */
  static async ensureRunning(projectRoot: string): Promise<boolean> {
    if (await this.isHealthy()) {
      return true;
    }
    console.warn("[claude-mem] Worker service is not running at http://localhost:37777");
    console.warn("[claude-mem] Please start it manually: npm run worker:start");
    return false;
  }

  /**
   * Initialize a session
   */
  static async sessionInit(claudeSessionId: string, project: string, prompt: string): Promise<{ sessionDbId: number; promptNumber: number } | null> {
    try {
      const response = await fetch(`${this.BASE_URL}/api/sessions/init`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ claudeSessionId, project, prompt })
      });
      if (!response.ok) return null;
      return (await response.json()) as { sessionDbId: number; promptNumber: number };
    } catch (error) {
      console.error("[claude-mem] Failed to init session:", error);
      return null;
    }
  }

  /**
   * Send observation
   */
  static async sendObservation(claudeSessionId: string, toolName: string, toolInput: any, toolResponse: any, cwd: string): Promise<void> {
    try {
      await fetch(`${this.BASE_URL}/api/sessions/observations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          claudeSessionId,
          tool_name: toolName,
          tool_input: toolInput,
          tool_response: toolResponse,
          cwd
        })
      });
    } catch (error) {
      console.error("[claude-mem] Failed to send observation:", error);
    }
  }

  /**
   * Trigger summarization
   */
  static async summarize(claudeSessionId: string, lastUserMessage: string, lastAssistantMessage: string): Promise<void> {
    try {
      await fetch(`${this.BASE_URL}/api/sessions/summarize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          claudeSessionId,
          last_user_message: lastUserMessage,
          last_assistant_message: lastAssistantMessage
        })
      });
    } catch (error) {
      console.error("[claude-mem] Failed to queue summary:", error);
    }
  }

  /**
   * Complete session
   */
  static async completeSession(claudeSessionId: string): Promise<void> {
    try {
      await fetch(`${this.BASE_URL}/api/sessions/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ claudeSessionId })
      });
    } catch (error) {
      console.error("[claude-mem] Failed to complete session:", error);
    }
  }

  /**
   * Perform Search
   */
  static async search(query: string, project: string): Promise<string> {
      try {
          const response = await fetch(`${this.BASE_URL}/api/search?q=${encodeURIComponent(query)}&project=${encodeURIComponent(project)}`);
          if (!response.ok) return "Search failed";
          const data = await response.json();
          return JSON.stringify(data, null, 2);
      } catch (e) {
          return `Error performing search: ${e}`;
      }
  }
}
