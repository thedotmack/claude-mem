/**
 * Framework-agnostic core of the OpenCode integration.
 *
 * Everything that decides WHAT gets remembered lives here: worker requests,
 * the OpenCode-session -> content-session mapping, memory-context caching and
 * the search client. The host-specific adapters (`index.ts`) translate their
 * own hook shapes into calls on a `ClaudeMemCore`, so the v1 and the v2 plugin
 * contracts cannot drift apart.
 *
 * Dependency-free (no worker-only imports) so it stays bundle-safe.
 */

import { join } from "node:path";
import { SettingsDefaultsManager } from "../../shared/SettingsDefaultsManager.js";
import { parseSearchResponse } from "./contract.js";
import { normalizePlatformSource } from "../../shared/platform-source.js";
import { isConnectionRefusedError } from "../../shared/connection-errors.js";
import { formatHostForUrl } from "../../shared/worker-url.js";
import { retryWhileRefused } from "./worker-retry.js";

export interface OpenCodeClient {
  session?: {
    messages?(options: {
      path: { id: string };
      query?: { directory?: string };
    }): Promise<{ data?: OpenCodeMessageSnapshot[] }>;
  };
}

export interface OpenCodeMessageSnapshot {
  info?: {
    role?: string;
    summary?: boolean;
    time?: { completed?: number };
  };
  parts?: Array<{ type: string; text?: string; ignored?: boolean }>;
}

/** The bits of the host context claude-mem actually reads. */
export interface CoreContext {
  directory: string;
  client?: OpenCodeClient;
}

function resolveWorkerBaseUrl(): string {
  const settingsPath = join(
    SettingsDefaultsManager.get("CLAUDE_MEM_DATA_DIR"),
    "settings.json",
  );
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  return `http://${formatHostForUrl(settings.CLAUDE_MEM_WORKER_HOST)}:${settings.CLAUDE_MEM_WORKER_PORT}`;
}

const WORKER_BASE_URL = resolveWorkerBaseUrl();
const MAX_TOOL_RESPONSE_LENGTH = 1000;

// Identifies these POSTs as coming from OpenCode. Without it the worker
// attributes OpenCode sessions to its default platform source ("claude"), so
// viewer badges and source-scoped session lookups are wrong (#3678).
const PLATFORM_SOURCE = "opencode";

// Built-in OpenCode names differ from the shared file-evidence vocabulary.
const CAPTURE_TOOL_NAMES = new Map([
  ["read", "Read"],
  ["write", "Write"],
  ["edit", "Edit"],
]);

const JSON_HEADERS: Record<string, string> = { "Content-Type": "application/json" };

// Every worker request is bounded, so a hung worker can neither hold a hook
// open nor pile up pending requests inside OpenCode's process (plan-23 step 2).
const WORKER_REQUEST_TIMEOUT_MS = 5_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One POST attempt. Resolves true when the worker refused the connection (not running yet). */
async function postToWorker(fetchImpl: typeof fetch, path: string, payload: string): Promise<boolean> {
  try {
    const response = await fetchImpl(`${WORKER_BASE_URL}${path}`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: payload,
      signal: AbortSignal.timeout(WORKER_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      console.warn(`[claude-mem] Worker POST ${path} returned ${response.status}`);
    }
    return false;
  } catch (error: unknown) {
    if (isConnectionRefusedError(error)) return true;
    console.warn(`[claude-mem] Worker POST ${path} failed: ${errorMessage(error)}`);
    return false;
  }
}

async function workerPost(path: string, body: Record<string, unknown>): Promise<void> {
  const payload = JSON.stringify({
    ...body,
    platformSource: normalizePlatformSource(PLATFORM_SOURCE),
  });
  // Retries reuse the fetch of the first attempt.
  const fetchImpl = fetch;
  if (await postToWorker(fetchImpl, path, payload)) {
    // The worker may still be starting (see worker-retry.ts): retry in the
    // background so no hook waits on it.
    void retryWhileRefused(() => postToWorker(fetchImpl, path, payload));
  }
}

async function workerGetText(path: string): Promise<string | null> {
  try {
    const response = await fetch(`${WORKER_BASE_URL}${path}`, {
      headers: JSON_HEADERS,
      signal: AbortSignal.timeout(WORKER_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      console.warn(`[claude-mem] Worker GET ${path} returned ${response.status}`);
      return null;
    }
    return await response.text();
  } catch (error: unknown) {
    if (!isConnectionRefusedError(error)) {
      console.warn(`[claude-mem] Worker GET ${path} failed: ${errorMessage(error)}`);
    }
    return null;
  }
}

const contentSessionIdsByOpenCodeSessionId = new Map<string, string>();

const MAX_SESSION_MAP_ENTRIES = 1000;

// Memory context per OpenCode session: fetched on the session's first system
// prompt build and reused for its later turns, as Claude Code injects once per
// session. Compaction clears it, so the next build carries fresh context.
interface CachedMemoryContext {
  request: Promise<string | null>;
  /** When the fetch came back with nothing; set only for a failed fetch. */
  failedAt?: number;
}
const contextByOpenCodeSessionId = new Map<string, CachedMemoryContext>();

// A failed context fetch is remembered this long before the next build tries
// again: OpenCode builds a system prompt for every request, and a hung worker
// would otherwise add the full request timeout to each one (plan-17 contract).
const FAILED_CONTEXT_RETRY_MS = 60_000;

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

/**
 * Resolves the stable local ID for all OpenCode activity without contacting the
 * worker. Session init means "a user prompt happened", not "ensure a session
 * row exists": observations and summarize create their own rows. Posting init
 * without a prompt manufactures a "[media prompt]" at prompt #1 and attributes
 * a preceding tool observation to it (#3803).
 */
function resolveContentSessionId(openCodeSessionId: string): string {
  return getOrCreateContentSessionId(openCodeSessionId);
}

/**
 * Records a real user prompt with the worker. Every user prompt posts init,
 * matching the Claude Code path; the worker de-duplicates identical prompts
 * within its time window (#3803).
 *
 * The body carries the checkout, not a project key. `ctx.project?.name` is not
 * the repository (it resolves to "opencode" for every project), and resolving
 * the key here would mean a second copy of the identity rules (markers,
 * environments, git-remote slugs, worktree and submodule composites) inside
 * OpenCode's process. The worker keys the session with the same shared
 * resolver it applies to this plugin's observations, so init and capture
 * always agree.
 */
async function initializeSessionForUserPrompt(
  openCodeSessionId: string,
  cwd: string,
  prompt: string,
): Promise<void> {
  const contentSessionId = resolveContentSessionId(openCodeSessionId);
  await workerPost("/api/sessions/init", {
    contentSessionId,
    prompt,
    cwd,
    platform_source: PLATFORM_SOURCE,
  });
}

function truncate(text: string): string {
  return text.length > MAX_TOOL_RESPONSE_LENGTH
    ? text.slice(0, MAX_TOOL_RESPONSE_LENGTH)
    : text;
}

/**
 * The text of the session's latest completed assistant reply, for summarize's
 * last_assistant_message. OpenCode fires chat.message for the user's message,
 * so the reply is read from OpenCode's own message list when the session idles
 * or compacts. Empty when the client offers no message list or it fails.
 */
async function latestAssistantText(
  client: unknown,
  openCodeSessionId: string,
  directory: string,
): Promise<string> {
  const session = (client as OpenCodeClient | undefined)?.session;
  if (typeof session?.messages !== "function") return "";
  try {
    const { data } = await session.messages({ path: { id: openCodeSessionId }, query: { directory } });
    let latest: { completed: number; text: string } | null = null;
    for (const message of data ?? []) {
      const completed = message.info?.time?.completed;
      if (message.info?.role !== "assistant" || message.info.summary === true || typeof completed !== "number") continue;
      const text = (message.parts ?? [])
        .filter((part) => part.type === "text" && part.ignored !== true && typeof part.text === "string")
        .map((part) => part.text as string)
        .join("\n")
        .trim();
      if (text && (!latest || completed >= latest.completed)) latest = { completed, text };
    }
    return latest?.text ?? "";
  } catch (error: unknown) {
    console.warn(`[claude-mem] OpenCode message list failed for ${openCodeSessionId}: ${errorMessage(error)}`);
    return "";
  }
}

export interface ClaudeMemCore {
  /**
   * Capture every tool execution as an observation. This is the primary
   * capture path (#2419). `args` are the tool arguments; OpenCode passes them
   * on the hook input, never on the output (#3678).
   */
  captureTool(input: {
    tool: string;
    sessionID: string;
    args?: Record<string, unknown>;
    output: string;
  }): Promise<void>;
  /** Capture a real user prompt with session init. */
  captureUserPrompt(sessionID: string, promptText: string): Promise<void>;
  /** Capture an assistant message as an observation. */
  captureAssistantMessage(sessionID: string, messageText: string): Promise<void>;
  /**
   * Summarize the session (compaction and idle both funnel here). The cached
   * memory context is kept: only compaction drops it, through
   * `forgetMemoryContext`. `lastAssistantMessage` is the reply when the host
   * reports it; otherwise it is read back from the client's message list.
   */
  captureSummary(sessionID: string, options?: { lastAssistantMessage?: string }): Promise<void>;
  /** Drop the cached memory context so the next system prompt fetches it again (compaction). */
  forgetMemoryContext(sessionID: string): void;
  /** Forget everything about a session the user deleted. */
  forgetSession(sessionID: string): void;
  /**
   * Memory context for a session's system prompt, cached once per session and
   * re-fetched after a failure window. Returns null/empty when there is none.
   */
  memoryContext(sessionID: string): Promise<string | null>;
  /** The `claude_mem_search` tool body. */
  search(query: string): Promise<string>;
}

export function createCore(ctx: CoreContext): ClaudeMemCore {
  function memoryContextFor(openCodeSessionId: string, cwd: string): Promise<string | null> {
    const cached = contextByOpenCodeSessionId.get(openCodeSessionId);
    if (cached && (cached.failedAt === undefined || Date.now() - cached.failedAt < FAILED_CONTEXT_RETRY_MS)) {
      return cached.request;
    }
    contextByOpenCodeSessionId.delete(openCodeSessionId);

    while (contextByOpenCodeSessionId.size >= MAX_SESSION_MAP_ENTRIES) {
      const oldestKey = contextByOpenCodeSessionId.keys().next().value;
      if (oldestKey === undefined) break;
      contextByOpenCodeSessionId.delete(oldestKey);
    }
    // The worker resolves the project keys from the checkout, as it does for init.
    const entry: CachedMemoryContext = {
      request: workerGetText(
        `/api/context/inject?cwd=${encodeURIComponent(cwd)}&platformSource=${PLATFORM_SOURCE}`,
      ),
    };
    contextByOpenCodeSessionId.set(openCodeSessionId, entry);
    void entry.request.then((context) => {
      if (!context) entry.failedAt = Date.now();
    });
    return entry.request;
  }

  async function captureSummary(
    sessionID: string,
    options: { lastAssistantMessage?: string } = {},
  ): Promise<void> {
    const contentSessionId = resolveContentSessionId(sessionID);
    await workerPost("/api/sessions/summarize", {
      contentSessionId,
      last_assistant_message:
        options.lastAssistantMessage ?? await latestAssistantText(ctx.client, sessionID, ctx.directory),
      // The worker skips an excluded checkout; the plugin cannot check it.
      cwd: ctx.directory,
      platform_source: PLATFORM_SOURCE,
    });
  }

  return {
    async captureTool({ tool, sessionID, args, output }) {
      const contentSessionId = resolveContentSessionId(sessionID);
      // apply_patch carries its patch as `patchText`, and the worker's file
      // evidence reads `patch`. Renamed rather than copied, so the observer
      // is not sent the whole patch twice.
      let toolInput: Record<string, unknown> = args || {};
      if (tool === "apply_patch" && typeof toolInput.patchText === "string") {
        const { patchText, ...otherArgs } = toolInput;
        toolInput = { ...otherArgs, patch: patchText };
      }
      await workerPost("/api/sessions/observations", {
        contentSessionId,
        tool_name: CAPTURE_TOOL_NAMES.get(tool) ?? tool,
        // Reading output.args instead shipped an empty tool_input for every
        // observation, and the compressor dismissed them all — the "loads but
        // captures nothing" symptom of #3678.
        tool_input: toolInput,
        tool_response: truncate(output || ""),
        cwd: ctx.directory,
        platform_source: PLATFORM_SOURCE,
      });
    },

    async captureUserPrompt(sessionID, promptText) {
      await initializeSessionForUserPrompt(sessionID, ctx.directory, promptText);
    },

    async captureAssistantMessage(sessionID, messageText) {
      const contentSessionId = resolveContentSessionId(sessionID);
      if (!messageText) return;
      await workerPost("/api/sessions/observations", {
        contentSessionId,
        tool_name: "assistant_message",
        tool_input: {},
        tool_response: truncate(messageText),
        cwd: ctx.directory,
        platform_source: PLATFORM_SOURCE,
      });
    },

    captureSummary,

    forgetMemoryContext(sessionID) {
      contextByOpenCodeSessionId.delete(sessionID);
    },

    forgetSession(sessionID) {
      contentSessionIdsByOpenCodeSessionId.delete(sessionID);
      contextByOpenCodeSessionId.delete(sessionID);
    },

    memoryContext(sessionID) {
      return memoryContextFor(sessionID, ctx.directory);
    },

    async search(query) {
      if (!query) return "Please provide a search query.";
      const text = await workerGetText(
        `/api/search/observations?query=${encodeURIComponent(query)}&limit=10`,
      );
      if (!text) {
        return "claude-mem worker is not running. Start it with: npx claude-mem start";
      }
      return parseSearchResponse(text, query);
    },
  };
}
