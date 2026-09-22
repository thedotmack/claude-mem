import { z } from "zod";
import { join } from "node:path";
import { spawn } from "node:child_process";
import {
  buildSpawnSyncInvocation,
  lookupWindowsCommand,
  type SpawnSyncInvocation,
} from "../../shared/spawn.js";
import { SettingsDefaultsManager } from "../../shared/SettingsDefaultsManager.js";
import { normalizePlatformSource } from "../../shared/platform-source.js";

/**
 * OpenCode plugin event contract.
 *
 * A plugin is an async function that receives a context object and returns an
 * object whose keys are OpenCode's real hook names. The hooks claude-mem binds
 * to are (authoritative source: plans/08-opencode-integration.md "Fix sequence"
 * step 1, cross-checked against OpenCode's documented plugin API):
 *
 *   - `tool.execute.after`            (input, output) — fires after every tool run
 *   - `chat.message`                  ({}, output)    — fires on each chat message
 *   - `event`                         ({ event })     — generic bus; event.type carries the name
 *   - `experimental.session.compacting`               — fires when a session compacts
 *
 * The generic `event` hook delivers bus events whose discriminant is
 * `event.type`. The only bus event types claude-mem reacts to are
 * `session.deleted` (forget the session mapping) and `session.idle` (best-effort
 * summarize). Session creation/observation capture is driven by the dedicated
 * `tool.execute.after` / `chat.message` hooks above, not by bus events — that is
 * the #2435 fix: the old code subscribed to non-existent bus types
 * (`session.created`, `message.updated`, `session.compacted`, `file.edited`)
 * and therefore captured nothing.
 *
 * REAL_OPENCODE_EVENT_TYPES is the allowlist of bus `event.type` values the
 * plugin is permitted to switch on. The contract test asserts the plugin only
 * references names in this list so a future typo fails CI.
 */
export const REAL_OPENCODE_EVENT_TYPES = [
  "session.idle",
  "session.deleted",
] as const;

type RealOpenCodeEventType = (typeof REAL_OPENCODE_EVENT_TYPES)[number];

/** The hook keys this plugin returns. The contract test asserts these are the real OpenCode hook names. */
export const REGISTERED_OPENCODE_HOOKS = [
  "tool.execute.after",
  "chat.message",
  "event",
  "experimental.session.compacting",
] as const;

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
  args?: Record<string, unknown>;
}

interface ToolExecuteAfterOutput {
  title: string;
  output: string;
  metadata: Record<string, unknown>;
  args?: Record<string, unknown>;
}

interface ChatMessageOutput {
  message: {
    id?: string;
    role?: string;
    sessionID?: string;
  };
  parts: Array<{ type: string; text?: string }>;
}

interface SessionCompactingInput {
  sessionID: string;
}

interface BusEvent {
  type: string;
  properties?: {
    sessionID?: string;
    info?: { id?: string };
  };
}

function resolveWorkerPort(): string {
  const settingsPath = join(
    SettingsDefaultsManager.get("CLAUDE_MEM_DATA_DIR"),
    "settings.json",
  );
  return SettingsDefaultsManager.loadFromFile(settingsPath).CLAUDE_MEM_WORKER_PORT;
}

function resolveWorkerHost(): string {
  return SettingsDefaultsManager.get("CLAUDE_MEM_WORKER_HOST");
}

const WORKER_BASE_URL = `http://${resolveWorkerHost()}:${resolveWorkerPort()}`;
const MAX_TOOL_RESPONSE_LENGTH = 1000;

const JSON_HEADERS: Record<string, string> = { "Content-Type": "application/json" };

function workerPostFireAndForget(
  path: string,
  body: Record<string, unknown>,
): void {
  fetch(`${WORKER_BASE_URL}${path}`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      ...body,
      platformSource: normalizePlatformSource("opencode"),
    }),
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
const initializedSessionIds = new Set<string>();

const MAX_SESSION_MAP_ENTRIES = 1000;

function getOrCreateContentSessionId(openCodeSessionId: string): string {
  if (!contentSessionIdsByOpenCodeSessionId.has(openCodeSessionId)) {
    while (contentSessionIdsByOpenCodeSessionId.size >= MAX_SESSION_MAP_ENTRIES) {
      const oldestKey = contentSessionIdsByOpenCodeSessionId.keys().next().value;
      if (oldestKey !== undefined) {
        contentSessionIdsByOpenCodeSessionId.delete(oldestKey);
        initializedSessionIds.delete(oldestKey);
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
 * The worker has no "session.created" event in OpenCode, so we lazily initialize
 * the session the first time we see any activity for it (tool run or chat
 * message). This guarantees a session row exists before observations arrive.
 */
function ensureSessionInitialized(openCodeSessionId: string, projectName: string): string {
  const contentSessionId = getOrCreateContentSessionId(openCodeSessionId);
  if (!initializedSessionIds.has(openCodeSessionId)) {
    initializedSessionIds.add(openCodeSessionId);
    workerPostFireAndForget("/api/sessions/init", {
      contentSessionId,
      project: projectName,
      prompt: "",
    });
  }
  return contentSessionId;
}

function truncate(text: string): string {
  return text.length > MAX_TOOL_RESPONSE_LENGTH
    ? text.slice(0, MAX_TOOL_RESPONSE_LENGTH)
    : text;
}

export const ClaudeMemPlugin = async (ctx: OpenCodePluginContext) => {
  const projectName = ctx.project?.name || "opencode";

  console.log(`[claude-mem] OpenCode plugin loading (project: ${projectName})`);

  return {
    // Capture every tool execution as an observation. This is the primary
    // capture path (#2419).
    "tool.execute.after": async (
      input: ToolExecuteAfterInput,
      output: ToolExecuteAfterOutput,
    ): Promise<void> => {
      const contentSessionId = ensureSessionInitialized(input.sessionID, projectName);
      workerPostFireAndForget("/api/sessions/observations", {
        contentSessionId,
        tool_name: input.tool,
        tool_input: input.args || output.args || {},
        tool_response: truncate(output.output || ""),
        cwd: ctx.directory,
      });
    },

    // Capture assistant chat messages as observations.
    "chat.message": async (
      _input: Record<string, unknown>,
      output: ChatMessageOutput,
    ): Promise<void> => {
      const sessionID = output.message?.sessionID;
      if (!sessionID) return;
      if (output.message?.role !== "assistant") return;

      const contentSessionId = ensureSessionInitialized(sessionID, projectName);
      const messageText = (output.parts || [])
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text as string)
        .join("\n");
      if (!messageText) return;

      workerPostFireAndForget("/api/sessions/observations", {
        contentSessionId,
        tool_name: "assistant_message",
        tool_input: {},
        tool_response: truncate(messageText),
        cwd: ctx.directory,
      });
    },

    // Summarize when a session compacts. This is OpenCode's real compaction
    // hook (the old `session.compacted` bus event never existed).
    "experimental.session.compacting": async (
      input: SessionCompactingInput,
    ): Promise<void> => {
      const contentSessionId = ensureSessionInitialized(input.sessionID, projectName);
      workerPostFireAndForget("/api/sessions/summarize", {
        contentSessionId,
        last_assistant_message: "",
      });
    },

    // Generic bus events. Only `session.idle` and `session.deleted` are real
    // and acted upon (see REAL_OPENCODE_EVENT_TYPES).
    event: async ({ event }: { event: BusEvent }): Promise<void> => {
      const eventType = event?.type as RealOpenCodeEventType | undefined;
      const sessionID = event?.properties?.sessionID || event?.properties?.info?.id;
      if (!sessionID) return;

      switch (eventType) {
        case "session.idle": {
          // Best-effort summarize once a session goes idle.
          const contentSessionId = ensureSessionInitialized(sessionID, projectName);
          workerPostFireAndForget("/api/sessions/summarize", {
            contentSessionId,
            last_assistant_message: "",
          });
          break;
        }
        case "session.deleted": {
          contentSessionIdsByOpenCodeSessionId.delete(sessionID);
          initializedSessionIds.delete(sessionID);
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
        async execute(args: Record<string, unknown>): Promise<string> {
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

          return parseSearchResponse(text, query);
        },
      },
    },
  };
};

/**
 * The worker returns Claude-style `{ content: [{ type: 'text', text: '...' }] }`
 * blocks, NOT `{ items: [...] }` (#2406). Concatenate the text blocks and return
 * them verbatim; an empty block list or a "No observations found" body becomes a
 * clear no-results message.
 */
export function parseSearchResponse(text: string, query: string): string {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error: unknown) {
    console.warn(
      "[claude-mem] Failed to parse search results:",
      error instanceof Error ? error.message : String(error),
    );
    return "Failed to parse search results.";
  }

  const content = (data as { content?: Array<{ type?: string; text?: string }> }).content;
  if (!Array.isArray(content) || content.length === 0) {
    return `No results found for "${query}".`;
  }

  const rendered = content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n")
    .trim();

  if (!rendered) {
    return `No results found for "${query}".`;
  }

  return rendered;
}

const WORKER_READY_TIMEOUT_MS = 10_000;
const WORKER_READY_POLL_INTERVAL_MS = 250;

/** Reports a launch failure (spawn `error` event or a non-zero start exit) to the ensure loop. */
type MarkLaunchFailed = () => void;

/**
 * Spawns `npx claude-mem start`; the default starter reports spawn errors and
 * non-zero exits via `markLaunchFailed`, so a start command that dies on its
 * own (missing CLI, missing Bun, ...) fails the wait immediately instead of
 * burning the full readiness timeout with the one-shot guard left latched.
 */
type WorkerStarter = (markLaunchFailed: MarkLaunchFailed) => void;

/**
 * Build the Windows-aware `npx claude-mem start` invocation. On Windows `npx`
 * is the npm `npx.cmd` PATH shim and a plain `spawn("npx", ...)` without a
 * shell never consults PATHEXT, so resolve the shim first; `.cmd`/`.bat`
 * shims are wrapped in `cmd.exe /d /s /c` with verbatim arguments (see
 * src/shared/spawn.ts).
 */
export function resolveWorkerStartInvocation(
  platform: NodeJS.Platform = process.platform,
  windowsLookup: () => string | null = () => lookupWindowsCommand("npx"),
): SpawnSyncInvocation {
  const command =
    platform === "win32" ? windowsLookup() ?? "npx.cmd" : "npx";
  return buildSpawnSyncInvocation(
    command,
    ["claude-mem", "start"],
    { encoding: "utf-8", stdio: "ignore" },
    platform,
  );
}

const spawnWorkerStartCommand: WorkerStarter = (markLaunchFailed) => {
  const invocation = resolveWorkerStartInvocation();
  const child = spawn(invocation.command, invocation.args, {
    ...invocation.options,
    detached: true,
  });
  child.on("error", (err: Error) => {
    markLaunchFailed();
    console.warn("[claude-mem] failed to start worker:", err.message);
  });
  child.on("exit", (code: number | null) => {
    // The start command daemonizes the worker and exits 0 on success (see
    // `start` in src/services/worker-service.ts), so any non-zero exit — or a
    // signal kill — means the launch itself failed.
    if (code !== 0) {
      markLaunchFailed();
      console.warn(`[claude-mem] worker start process exited with code ${code}`);
    }
  });
  child.unref();
};

/**
 * Liveness probe against the worker's dedicated /health endpoint (served by
 * ViewerRoutes, always 200 JSON `{ status: "ok", ... }` while the worker's
 * HTTP layer answers). Probing "/" would mark any service bound to the port
 * as healthy and suppress the auto-start.
 */
async function workerAlive(): Promise<boolean> {
  try {
    const response = await fetch(`${WORKER_BASE_URL}/health`, {
      signal: AbortSignal.timeout(1000),
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { status?: unknown };
    return body?.status === "ok";
  } catch {
    return false;
  }
}

async function waitForWorkerReady(
  isLaunchFailed: () => boolean,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await workerAlive()) return true;
    if (isLaunchFailed() || Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

let workerEnsurePromise: Promise<boolean> | null = null;

interface WorkerEnsureOptions {
  startWorker?: WorkerStarter;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

/**
 * Make the claude-mem worker available before capture hooks are exposed.
 *
 * OpenCode loads this plugin automatically at startup, but the claude-mem
 * worker is a separate long-running process. If it is down, spawn
 * `npx claude-mem start` and wait (bounded) until it responds, so the first
 * capture events are not dropped on ECONNREFUSED. Returns true once the
 * worker is verified healthy.
 *
 * The attempt is memoized per process so later plugin initializations never
 * spawn duplicate workers; on launch failure the memo is reset so a later
 * initialization can retry.
 */
export function ensureWorkerRunning(options: WorkerEnsureOptions = {}): Promise<boolean> {
  if (!workerEnsurePromise) {
    const startWorker = options.startWorker ?? spawnWorkerStartCommand;
    const timeoutMs = options.timeoutMs ?? WORKER_READY_TIMEOUT_MS;
    const pollIntervalMs = options.pollIntervalMs ?? WORKER_READY_POLL_INTERVAL_MS;
    workerEnsurePromise = (async () => {
      if (await workerAlive()) return true;
      console.log("[claude-mem] worker not running — starting");
      let launchFailed = false;
      try {
        startWorker(() => {
          launchFailed = true;
        });
      } catch (error: unknown) {
        launchFailed = true;
        const message = error instanceof Error ? error.message : String(error);
        console.warn("[claude-mem] failed to start worker:", message);
      }
      const ready = await waitForWorkerReady(
        () => launchFailed,
        timeoutMs,
        pollIntervalMs,
      );
      if (!ready) {
        if (launchFailed) {
          workerEnsurePromise = null;
        }
        console.warn(
          "[claude-mem] worker not ready — capture resumes once it responds (npx claude-mem start)",
        );
      }
      return ready;
    })();
  }
  return workerEnsurePromise;
}

export default async (ctx: OpenCodePluginContext) => {
  await ensureWorkerRunning();
  return ClaudeMemPlugin(ctx);
};
