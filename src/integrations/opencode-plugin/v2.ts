/**
 * OpenCode V2 plugin adapter.
 *
 * V2 replaced the returned-hooks-object contract with `Plugin.define`:
 * the default export is `{ id, setup }` (or `{ id, effect }`), and `setup(ctx)`
 * registers behavior imperatively instead of returning a hook map. V2 validates
 * the module with `Schema.Struct({ id, effect })` / `Schema.Struct({ id, setup })`
 * and rejects anything else with "Plugin must export a default definition with an
 * id and an effect or setup function" — a v1 hooks object is not accepted, and
 * the two APIs are not translated into each other.
 *
 * The v1 -> v2 hook mapping this file implements:
 *
 *   v1 `tool.execute.after`              -> ctx.tool.hook("execute.after")
 *   v1 `chat.message` (user)             -> ctx.session.hook("prompt")
 *   v1 `experimental.session.compacting` -> ctx.session.hook("compaction") drops the
 *                                           cached memory; the bus event
 *                                           `session.compaction.ended` summarizes
 *   v1 `event` `session.idle`            -> bus `session.execution.succeeded`
 *   v1 `event` `session.deleted`         -> bus `session.deleted`
 *   v1 `experimental.chat.system.transform` -> ctx.session.hook("context")
 *   v1 `tool` (custom tool map)          -> ctx.tool.transform()
 *
 * The bus is `ctx.event.subscribe()`. Its events are `{ type, data, location }`
 * envelopes (`@opencode/schema` Event), not V1's `{ type, properties }`, and V2
 * has no `session.idle`: a finished turn is `session.execution.succeeded`. The
 * last `session.text.ended` before it carries the assistant reply for the
 * summary, since V2's context has no V1 `client` to read messages back from.
 *
 * V2's `ctx` is structurally unknown to this package (it ships no dependency on
 * `@opencode-ai/plugin`, to stay bundle-safe), so the surface is typed locally
 * and read defensively: the plugin API is still beta and field shapes can move.
 */

import { CONTEXT_TAG_CLOSE, CONTEXT_TAG_OPEN } from "../../utils/context-injection.js";
import { createCore, type ClaudeMemCore, type CoreContext } from "./core.js";

/** The V2 plugin id. Also the handle `opencode.json(c)` uses to disable it. */
export const CLAUDE_MEM_PLUGIN_ID = "claude-mem";

export interface V2Registration {
  dispose(): Promise<void>;
}

export interface V2ToolExecuteAfterEvent {
  status?: string;
  tool?: string;
  sessionID?: string;
  input?: Record<string, unknown>;
  args?: Record<string, unknown>;
  result?: unknown;
  error?: { message?: string } | string;
}

export interface V2PromptEvent {
  sessionID: string;
  prompt: { text?: string };
}

export interface V2ContextEvent {
  sessionID: string;
  system: Array<{ type: string; text?: string }>;
}

export interface V2CompactionEvent {
  sessionID: string;
  messages?: unknown;
}

/**
 * One envelope from `ctx.event.subscribe()`. Every session event carries its
 * session in `data.sessionID`; `session.text.ended` adds the text.
 */
export interface V2BusEvent {
  type?: string;
  data?: {
    sessionID?: string;
    text?: string;
  };
  /**
   * Where the event happened. The stream covers every location the server
   * hosts, and OpenCode 2.0.23 sends `session.execution.*` and
   * `session.deleted` with `location: null` (found on a live host in #4519).
   */
  location?: { directory?: string } | null;
}

export interface SetupV2Options {
  /** Wait before subscribing again after the event stream ends or fails. */
  resubscribeDelayMs?: number;
}

const RESUBSCRIBE_DELAY_MS = 10_000;

// Bounds the per-session reply cache on a long-lived server, as core.ts
// bounds its session maps.
const MAX_TRACKED_SESSIONS = 1000;

/** The slice of the V2 context this adapter uses. Every member is optional so
 * a beta API change degrades to a no-op instead of failing the whole load. */
export interface OpenCodePluginContextV2 extends CoreContext {
  /**
   * V2 moved the checkout out of the context root: V1 read `ctx.directory`,
   * V2 exposes it as `ctx.location.directory`. Every worker write is keyed by
   * the checkout, so passing an undefined cwd makes the worker reject the
   * observation ("Missing cwd when ingesting observation").
   */
  location?: { directory?: string; workspaceID?: string };
  tool?: {
    hook?: (
      name: "execute.after",
      callback: (event: V2ToolExecuteAfterEvent) => Promise<void> | void,
    ) => Promise<V2Registration>;
    transform?: (
      callback: (editor: {
        add(tool: {
          name: string;
          description: string;
          input: Record<string, unknown>;
          execute: (input: Record<string, unknown>) => Promise<{ content: string }>;
        }): void;
      }) => void,
    ) => Promise<V2Registration>;
  };
  session?: {
    hook?: <E>(
      name: string,
      callback: (event: E) => Promise<void> | void,
    ) => Promise<V2Registration>;
    context?: (input: { sessionID: string }) => Promise<readonly unknown[]>;
  };
  event?: {
    subscribe?: (options?: { signal?: AbortSignal }) => AsyncIterable<V2BusEvent>;
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  // A V2 Tool.Error that crossed a serialization boundary is a plain object.
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === "string" ? message : String(error);
}

/**
 * Removes the memory blocks an earlier context build left in the system
 * prompt, in place, so the list the host reads back never holds two.
 */
function removeMemoryParts(system: Array<{ type: string; text?: string }>): void {
  for (let index = system.length - 1; index >= 0; index--) {
    const part = system[index];
    if (part?.type === "text" && part.text?.startsWith(CONTEXT_TAG_OPEN)) system.splice(index, 1);
  }
}

function waitUnlessAborted(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, milliseconds);
    // A pending retry must not keep the host process alive.
    (timer as { unref?: () => void }).unref?.();
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Reads `ctx.event.subscribe()` until the plugin is cleaned up. The stream is
 * long-lived, so when it ends or fails it is opened again after a delay;
 * otherwise one dropped connection would stop every later summary.
 */
async function consumeBus(
  subscribe: (options: { signal: AbortSignal }) => AsyncIterable<V2BusEvent>,
  onEvent: (event: V2BusEvent) => void,
  signal: AbortSignal,
  resubscribeDelayMs: number,
): Promise<void> {
  while (!signal.aborted) {
    try {
      for await (const event of subscribe({ signal })) {
        if (signal.aborted) break;
        onEvent(event);
      }
    } catch (error: unknown) {
      if (!signal.aborted) {
        console.warn(`[claude-mem] OpenCode event stream failed: ${errorMessage(error)}`);
      }
    }
    if (!signal.aborted) await waitUnlessAborted(resubscribeDelayMs, signal);
  }
}

/**
 * V2 hands the tool result over as an object, not the string V1's
 * `output.output` carried. The observed shape is
 * `{ output: { exit, truncated, output }, content: [{ type: "text", text }] }`,
 * so the text blocks are the reliable source; `output` is a tool-specific
 * object for shell and a plain string elsewhere.
 */
export function extractResultText(result: unknown): string {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return "";

  const shape = result as { output?: unknown; content?: unknown };
  // Tool.Result allows `content` as a plain string as well as a block list.
  if (typeof shape.content === "string" && shape.content.trim()) return shape.content;
  if (Array.isArray(shape.content)) {
    const text = (shape.content as Array<{ type?: string; text?: string }>)
      .filter((block) => block?.type === "text" && typeof block.text === "string")
      .map((block) => block.text as string)
      .join("\n");
    if (text.trim()) return text;
  }
  if (typeof shape.output === "string") return shape.output;
  if (shape.output && typeof shape.output === "object") {
    const nested = (shape.output as { output?: unknown }).output;
    if (typeof nested === "string") return nested;
  }
  return "";
}

/**
 * Registers every claude-mem hook on a V2 context. Returns a cleanup function
 * that disposes every registration, per the V2 lifecycle contract.
 */
export async function setupV2(
  context: OpenCodePluginContextV2,
  options: SetupV2Options = {},
): Promise<() => Promise<void>> {
  // V1 read `ctx.directory`; V2 nests it under `ctx.location`. Without this the
  // worker rejects every write with "Missing cwd when ingesting observation".
  const ctx: CoreContext = {
    directory: context.location?.directory ?? "",
    client: context.client,
  };

  console.log(`[claude-mem] OpenCode plugin loading (directory: ${ctx.directory})`);
  const core: ClaudeMemCore = createCore(ctx);
  const registrations: V2Registration[] = [];

  // The sessions this plugin captured a prompt or a tool for, each with the
  // latest assistant text the bus reported. Execution and deletion events can
  // arrive without a location, so this is how the bus tells this checkout's
  // sessions from another location's on the same server.
  const replyBySessionId = new Map<string, string>();
  const trackSession = (sessionID: string): void => {
    if (replyBySessionId.has(sessionID)) return;
    if (replyBySessionId.size >= MAX_TRACKED_SESSIONS) {
      const oldest = replyBySessionId.keys().next().value;
      if (oldest !== undefined) replyBySessionId.delete(oldest);
    }
    replyBySessionId.set(sessionID, "");
  };
  const disposeRegistrations = async (): Promise<void> => {
    await Promise.allSettled(registrations.map((registration) => registration.dispose()));
  };
  const register = async (registerHook: () => Promise<V2Registration>): Promise<void> => {
    try {
      registrations.push(await registerHook());
    } catch (error: unknown) {
      // A failed setup must not leave the hooks registered before it behind.
      await disposeRegistrations();
      throw error;
    }
  };

  const toolDomain = context.tool;
  const sessionDomain = context.session;

  // Primary capture path: every tool execution becomes an observation.
  if (toolDomain?.hook) {
    const hook = toolDomain.hook.bind(toolDomain);
    await register(() =>
      hook("execute.after", async (event) => {
        const sessionID = event.sessionID;
        const tool = event.tool;
        if (!sessionID || !tool) return;
        trackSession(sessionID);
        // v2 names the argument bag `input`; `args` is tolerated because the
        // beta shape has moved before.
        const args = (event.input ?? event.args) as Record<string, unknown> | undefined;
        // A failed tool still ran, and its error message is the interesting
        // part; v1 received the same string through `output`.
        const result = event.result;
        const output =
          event.status === "error"
            ? errorMessage(event.error ?? "")
            : extractResultText(result);
        await core.captureTool({ tool, sessionID, args, output });
      }),
    );
  }

  // User prompts: v1 read them off `chat.message`. V2 admits them through the
  // `prompt` hook, which runs once per admitted prompt.
  if (sessionDomain?.hook) {
    const hook = sessionDomain.hook.bind(sessionDomain);
    await register(() =>
      hook<V2PromptEvent>("prompt", async (event) => {
        const promptText = event?.prompt?.text?.trim();
        if (!event?.sessionID || !promptText) return;
        trackSession(event.sessionID);
        await core.captureUserPrompt(event.sessionID, promptText);
      }),
    );

    // Memory context: v1 pushed a raw string onto `output.system`; v2's system
    // prompt is a list of typed parts, so the context goes in as one text part,
    // tagged so the next build can find it. OpenCode runs this hook for every
    // model request, and a block left by an earlier run is replaced, not stacked.
    await register(() =>
      hook<V2ContextEvent>("context", async (event) => {
        if (!event?.sessionID || !Array.isArray(event.system)) return;
        const memory = (await core.memoryContext(event.sessionID))?.trim();
        if (!memory) return;
        removeMemoryParts(event.system);
        event.system.push({ type: "text", text: `${CONTEXT_TAG_OPEN}\n${memory}\n${CONTEXT_TAG_CLOSE}` });
      }),
    );

    // Compaction: v1's `experimental.session.compacting`. The hook runs before
    // the compaction request, so dropping the cached memory here means the
    // first request after compaction fetches it fresh. The summary is written
    // when the bus reports `session.compaction.ended` (below), so one
    // compaction is summarized once.
    await register(() =>
      hook<V2CompactionEvent>("compaction", (event) => {
        if (event?.sessionID) core.forgetMemoryContext(event.sessionID);
      }),
    );
  }

  // Custom tool: v1 returned a `tool` map, v2 registers through a transform.
  if (toolDomain?.transform) {
    const transform = toolDomain.transform.bind(toolDomain);
    await register(() =>
      transform((editor) => {
        editor.add({
          name: "claude_mem_search",
          description:
            "Search claude-mem memory database for past observations, sessions, and context",
          input: {
            type: "object",
            properties: {
              query: { type: "string", description: "Search query for memory observations" },
            },
            required: ["query"],
          },
          execute: async (input: Record<string, unknown>) => ({
            content: await core.search(String(input?.query || "")),
          }),
        });
      }),
    );
  }

  const summarize = (sessionID: string): void => {
    void core
      .captureSummary(sessionID, { lastAssistantMessage: replyBySessionId.get(sessionID) ?? "" })
      .catch((error: unknown) => console.warn(`[claude-mem] OpenCode summary failed: ${errorMessage(error)}`));
  };

  const onBusEvent = (event: V2BusEvent): void => {
    const sessionID = event?.data?.sessionID;
    if (!sessionID) return;
    // The stream covers every location the server hosts. An event that names
    // another checkout is not ours; one without a location is matched by the
    // sessions this plugin has seen.
    const eventDirectory = event.location?.directory;
    if (eventDirectory && ctx.directory && eventDirectory !== ctx.directory) return;

    switch (event.type) {
      case "session.deleted":
        replyBySessionId.delete(sessionID);
        core.forgetSession(sessionID);
        return;
      case "session.text.ended":
        if (replyBySessionId.has(sessionID) && typeof event.data?.text === "string") {
          replyBySessionId.set(sessionID, event.data.text);
        }
        return;
      // V1's session.idle: the turn finished.
      case "session.execution.succeeded":
      case "session.compaction.ended":
        if (replyBySessionId.has(sessionID)) summarize(sessionID);
        return;
      default:
        return;
    }
  };

  // The bus is a long-lived subscription, so it is driven by an AbortController
  // owned by the plugin cleanup rather than by an awaited hook registration.
  const cleanupController = new AbortController();
  const events = context.event;
  if (events?.subscribe) {
    void consumeBus(
      // Called on the domain object, which may rely on `this`.
      (subscribeOptions) => events.subscribe!(subscribeOptions),
      onBusEvent,
      cleanupController.signal,
      options.resubscribeDelayMs ?? RESUBSCRIBE_DELAY_MS,
    );
  }

  return async () => {
    cleanupController.abort();
    await disposeRegistrations();
  };
}
