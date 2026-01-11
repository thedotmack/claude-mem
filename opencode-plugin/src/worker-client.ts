import { appendFileSync } from "fs";

const LOG_FILE = "/tmp/claude-mem-opencode.log";

function log(message: string, data?: any) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [WorkerClient] ${message}${data ? ` | ${JSON.stringify(data)}` : ""}\n`;
  try {
    appendFileSync(LOG_FILE, line);
  } catch (e) {
    console.log(`[claude-mem] ${message}`, data);
  }
}

export class WorkerClient {
  private static readonly PORT = 37777;
  private static readonly BASE_URL = `http://127.0.0.1:${WorkerClient.PORT}`;

  static async isHealthy(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 1000);

      const response = await fetch(`${this.BASE_URL}/api/health`, {
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      const healthy = response.ok;
      log("isHealthy", { healthy });
      return healthy;
    } catch (e) {
      log("isHealthy - ERROR", { error: String(e) });
      return false;
    }
  }

  static async ensureRunning(projectRoot: string): Promise<boolean> {
    log("ensureRunning", { projectRoot });
    if (await this.isHealthy()) {
      return true;
    }
    log("Worker NOT running - please start manually");
    console.warn("[claude-mem] Worker service is not running at http://localhost:37777");
    console.warn("[claude-mem] Please start it manually: npm run worker:start");
    return false;
  }

  static async sessionInit(
    claudeSessionId: string, 
    project: string, 
    prompt: string
  ): Promise<{ sessionDbId: number; promptNumber: number } | null> {
    log("sessionInit", { claudeSessionId, project, promptLength: prompt?.length });
    try {
      const response = await fetch(`${this.BASE_URL}/api/sessions/init`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ claudeSessionId, project, prompt })
      });
      if (!response.ok) {
        log("sessionInit - response not ok", { status: response.status });
        return null;
      }
      const result = (await response.json()) as { sessionDbId: number; promptNumber: number };
      log("sessionInit - success", result);
      return result;
    } catch (error) {
      log("sessionInit - ERROR", { error: String(error) });
      return null;
    }
  }

  static async sendObservation(
    claudeSessionId: string, 
    toolName: string, 
    toolInput: any, 
    toolResponse: any, 
    cwd: string
  ): Promise<void> {
    log("sendObservation", { 
      claudeSessionId, 
      toolName, 
      inputKeys: Object.keys(toolInput || {}),
      responseLength: typeof toolResponse === 'string' ? toolResponse.length : JSON.stringify(toolResponse).length,
      cwd 
    });
    try {
      const response = await fetch(`${this.BASE_URL}/api/sessions/observations`, {
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
      log("sendObservation - response", { status: response.status, ok: response.ok });
    } catch (error) {
      log("sendObservation - ERROR", { error: String(error) });
    }
  }

  static async summarize(
    claudeSessionId: string, 
    lastUserMessage: string, 
    lastAssistantMessage: string
  ): Promise<void> {
    log("summarize", { claudeSessionId });
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
      log("summarize - sent");
    } catch (error) {
      log("summarize - ERROR", { error: String(error) });
    }
  }

  static async completeSession(claudeSessionId: string): Promise<void> {
    log("completeSession", { claudeSessionId });
    try {
      await fetch(`${this.BASE_URL}/api/sessions/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ claudeSessionId })
      });
      log("completeSession - sent");
    } catch (error) {
      log("completeSession - ERROR", { error: String(error) });
    }
  }

  static async search(query: string, project: string): Promise<string> {
    log("search", { query, project });
    try {
      const response = await fetch(
        `${this.BASE_URL}/api/search?q=${encodeURIComponent(query)}&project=${encodeURIComponent(project)}`
      );
      if (!response.ok) {
        log("search - response not ok", { status: response.status });
        return "Search failed";
      }
      const data = await response.json();
      log("search - success", { resultCount: Array.isArray(data) ? data.length : 'object' });
      return JSON.stringify(data, null, 2);
    } catch (e) {
      log("search - ERROR", { error: String(e) });
      return `Error performing search: ${e}`;
    }
  }

  static async getContextForInjection(project: string): Promise<string> {
    log("getContextForInjection", { project });
    try {
      const response = await fetch(
        `${this.BASE_URL}/api/context/inject?project=${encodeURIComponent(project)}`
      );
      if (!response.ok) {
        log("getContextForInjection - response not ok", { status: response.status });
        return "";
      }
      const text = await response.text();
      log("getContextForInjection - success", { length: text.length });
      return text;
    } catch (e) {
      log("getContextForInjection - ERROR", { error: String(e) });
      return "";
    }
  }
}
