/**
 * Worker API client for the LoCoMo evaluation harness.
 *
 * Communicates with the claude-mem worker service at localhost:37777.
 * Uses the new contentSessionId-based API endpoints for session management
 * and the unified search endpoint for retrieval.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// ---------------------------------------------------------------------------
// Auth token
// ---------------------------------------------------------------------------

const AUTH_TOKEN_PATH = join(homedir(), ".claude-mem", ".auth-token");

function readAuthToken(): string {
  try {
    return readFileSync(AUTH_TOKEN_PATH, "utf-8").trim();
  } catch {
    throw new Error(
      `Cannot read auth token at ${AUTH_TOKEN_PATH}. Is claude-mem installed?`
    );
  }
}

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

export interface InitSessionResponse {
  sessionDbId: number;
  promptNumber: number;
  skipped: boolean;
  reason?: string;
}

export interface SessionStatusResponse {
  status: "active" | "not_found";
  sessionDbId?: number;
  project?: string;
  queueLength?: number;
  uptime?: number;
}

export interface SearchObservationResult {
  id: number;
  memory_session_id: string;
  project: string;
  text: string | null;
  type: string;
  title: string | null;
  subtitle: string | null;
  facts: string | null;
  narrative: string | null;
  concepts: string | null;
  files_read: string | null;
  files_modified: string | null;
  prompt_number: number | null;
  created_at: string;
  created_at_epoch: number;
  rank?: number;
  score?: number;
}

export interface SearchResponse {
  observations: SearchObservationResult[];
  sessions: unknown[];
  prompts: unknown[];
  totalResults: number;
  query: string;
  search_latency_ms: number;
}

// ---------------------------------------------------------------------------
// Worker client
// ---------------------------------------------------------------------------

const DEFAULT_BASE_URL = "http://localhost:37777";

export class WorkerClient {
  private baseUrl: string;
  private authToken: string;
  /** Maps contentSessionId → sessionDbId (populated by initSession). */
  private sessionDbIdMap = new Map<string, number>();

  constructor(baseUrl = DEFAULT_BASE_URL) {
    this.baseUrl = baseUrl;
    this.authToken = readAuthToken();
  }

  // ---- helpers ------------------------------------------------------------

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.authToken}`,
    };
  }

  private async handleResponse<T>(response: Response): Promise<T> {
    if (response.status === 401) {
      throw new Error("Invalid auth token");
    }
    if (response.status >= 500) {
      const body = await response.text();
      throw new Error(
        `Worker returned ${response.status}: ${body}`
      );
    }
    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Worker returned ${response.status}: ${body}`
      );
    }
    return response.json() as Promise<T>;
  }

  private async fetchWithConnectionCheck<T>(
    url: string,
    init?: RequestInit
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (error: unknown) {
      if (
        error instanceof TypeError &&
        (error.message.includes("ECONNREFUSED") ||
          error.message.includes("fetch failed"))
      ) {
        throw new Error(
          `Worker not running at ${this.baseUrl}. Start it with: bun plugin/scripts/worker-service.cjs start`
        );
      }
      throw error;
    }
    return this.handleResponse<T>(response);
  }

  // ---- session lifecycle --------------------------------------------------

  /**
   * Initialize a session via POST /api/sessions/init.
   * Stores the sessionDbId mapping for later status polling.
   */
  async initSession(
    contentSessionId: string,
    project: string,
    userPrompt: string
  ): Promise<InitSessionResponse> {
    const data = await this.fetchWithConnectionCheck<InitSessionResponse>(
      `${this.baseUrl}/api/sessions/init`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          contentSessionId,
          project,
          prompt: userPrompt,
        }),
      }
    );
    this.sessionDbIdMap.set(contentSessionId, data.sessionDbId);
    return data;
  }

  /**
   * Queue an observation via POST /api/sessions/observations.
   *
   * The server derives promptNumber from the session's user_prompts count,
   * so it does not need to be sent explicitly.
   *
   * @param toolInput - JSON string representing the tool input object
   * @param toolResponse - Plain text tool response
   */
  async queueObservation(
    contentSessionId: string,
    toolName: string,
    toolInput: string,
    toolResponse: string
  ): Promise<{ status: string }> {
    // Parse toolInput string back to object since the server calls
    // JSON.stringify() on the body value (avoids double-encoding).
    let parsedToolInput: unknown;
    try {
      parsedToolInput = JSON.parse(toolInput);
    } catch {
      parsedToolInput = toolInput;
    }

    return this.fetchWithConnectionCheck<{ status: string }>(
      `${this.baseUrl}/api/sessions/observations`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          contentSessionId,
          tool_name: toolName,
          tool_input: parsedToolInput,
          tool_response: toolResponse,
          cwd: "",
        }),
      }
    );
  }

  /**
   * Complete a session via POST /api/sessions/complete.
   */
  async completeSession(
    contentSessionId: string
  ): Promise<{ status: string }> {
    return this.fetchWithConnectionCheck<{ status: string }>(
      `${this.baseUrl}/api/sessions/complete`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ contentSessionId }),
      }
    );
  }

  /**
   * Get session status via the legacy GET /sessions/:sessionDbId/status endpoint.
   * Requires that initSession was called first (to populate the sessionDbId mapping).
   */
  async getSessionStatus(
    contentSessionId: string
  ): Promise<SessionStatusResponse> {
    const sessionDbId = this.sessionDbIdMap.get(contentSessionId);
    if (sessionDbId === undefined) {
      throw new Error(
        `No sessionDbId known for contentSessionId "${contentSessionId}". Call initSession first.`
      );
    }
    return this.fetchWithConnectionCheck<SessionStatusResponse>(
      `${this.baseUrl}/sessions/${sessionDbId}/status`,
      { headers: this.headers() }
    );
  }

  /**
   * Poll getSessionStatus every `pollIntervalMs` until the queue is empty
   * or `timeoutMs` is reached.
   *
   * @returns The final status response when queue is empty.
   * @throws If timeout is reached while queue is still non-empty.
   */
  async waitForProcessing(
    contentSessionId: string,
    timeoutMs: number,
    pollIntervalMs = 2000
  ): Promise<SessionStatusResponse> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const status = await this.getSessionStatus(contentSessionId);

      // Queue is empty or session no longer active — done
      if (
        status.status === "not_found" ||
        (status.queueLength !== undefined && status.queueLength === 0)
      ) {
        return status;
      }

      // Wait before next poll
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    throw new Error(
      `Timeout after ${timeoutMs}ms waiting for processing of session "${contentSessionId}"`
    );
  }

  // ---- search -------------------------------------------------------------

  /**
   * Search claude-mem observations via GET /api/search.
   * Uses format=json for raw programmatic results.
   * Instruments search_latency_ms from request start to response received.
   */
  async search(
    query: string,
    project: string,
    limit: number
  ): Promise<SearchResponse> {
    const params = new URLSearchParams({
      query,
      project,
      limit: String(limit),
      type: "observations",
      format: "json",
    });

    const startMs = Date.now();
    const data = await this.fetchWithConnectionCheck<Omit<SearchResponse, "search_latency_ms">>(
      `${this.baseUrl}/api/search?${params.toString()}`,
      { headers: this.headers() }
    );
    const searchLatencyMs = Date.now() - startMs;

    return { ...data, search_latency_ms: searchLatencyMs };
  }
}
