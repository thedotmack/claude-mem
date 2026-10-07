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
 *   v1 `chat.message` (assistant)        -> ctx.event.subscribe("message.updated")
 *   v1 `experimental.session.compacting` -> ctx.session.hook("compaction")
 *   v1 `event` (session.idle/deleted)    -> ctx.event.subscribe()
 *   v1 `experimental.chat.system.transform` -> ctx.session.hook("context")
 *   v1 `tool` (custom tool map)          -> ctx.tool.transform()
 *
 * V2's `ctx` is structurally unknown to this package (it ships no dependency on
 * `@opencode-ai/plugin`, to stay bundle-safe), so the surface is typed locally
 * and read defensively: the plugin API is still beta and field shapes can move.
 */

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

export interface V2BusEvent {
  type?: string;
  properties?: {
    sessionID?: string;
    info?: { id?: string };
  };
}

/** The slice of the V2 context this adapter uses. Every member is optional so
 * a beta API change degrades to a no-op instead of failing the whole load. */
export interface OpenCodePluginContextV2 extends CoreContext {
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
  return error instanceof Error ? error.message : String(error);
}

function textOfUnknownParts(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return (value as Array<{ type?: string; text?: string }>)
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n");
}

/**
 * V2 replaced v1's `event` hook with `ctx.event.subscribe()`, an async
 * iterable over the server's public event stream. It has no `status`/`id`
 * envelope, so each event is matched by its own discriminant.
 */
async function subscribeToBus(
  ctx: OpenCodePluginContextV2,
  core: ClaudeMemCore,
  signal: AbortSignal,
): Promise<void> {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal.addEventListener("abort", onAbort, { once: true });

  try {
    for await (const event of ctx.event!.subscribe!({ signal: controller.signal })) {
      const type = event?.type;
      const sessionID = event?.properties?.sessionID || event?.properties?.info?.id;

      if (type === "session.idle") {
        if (sessionID) await core.captureSummary(sessionID);
        continue;
      }
      if (type === "session.deleted") {
        if (sessionID) core.forgetSession(sessionID);
        continue;
      }
      // v1 observed assistant messages from `chat.message`; V2 has no such
      // hook, so the assistant text is read back from the session transcript
      // on idle (see `captureSummary`). Nothing to do for other event types.
    }
  } catch (error: unknown) {
    if (!controller.signal.aborted) {
      console.warn(`[claude-mem] OpenCode event stream ended: ${errorMessage(error)}`);
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Registers every claude-mem hook on a V2 context. Returns a cleanup function
 * that disposes every registration, per the V2 lifecycle contract.
 */
export async function setupV2(ctx: OpenCodePluginContextV2): Promise<() => Promise<void>> {
  console.log(`[claude-mem] OpenCode plugin loading (directory: ${ctx.directory})`);
  const core: ClaudeMemCore = createCore(ctx);
  const registrations: V2Registration[] = [];
  const register = async (promise: Promise<V2Registration> | undefined): Promise<void> => {
    if (promise) registrations.push(await promise);
  };

  // Primary capture path: every tool execution becomes an observation.
  if (ctx.tool?.hook) {
    await register(
      ctx.tool.hook("execute.after", async (event) => {
        const sessionID = event.sessionID;
        const tool = event.tool;
        if (!sessionID || !tool) return;
        // v2 names the argument bag `input`; `args` is tolerated because the
        // beta shape has moved before.
        const args = (event.input ?? event.args) as Record<string, unknown> | undefined;
        // A failed tool still ran, and its error message is the interesting
        // part; v1 received the same string through `output`.
        const result = event.result;
        const output =
          typeof result === "string"
            ? result
            : typeof (result as { output?: unknown })?.output === "string"
              ? ((result as { output: string }).output)
              : errorMessage(event.error ?? "");
        await core.captureTool({ tool, sessionID, args, output });
      }),
    );
  }

  // User prompts: v1 read them off `chat.message`. V2 admits them through the
  // `prompt` hook, which runs once per admitted prompt.
  if (ctx.session?.hook) {
    await register(
      ctx.session.hook<V2PromptEvent>("prompt", async (event) => {
        const promptText = event?.prompt?.text?.trim();
        if (!event?.sessionID || !promptText) return;
        await core.captureUserPrompt(event.sessionID, promptText);
      }),
    );

    // Memory context: v1 pushed a raw string onto `output.system`; v2's system
    // prompt is a list of typed parts, so the context goes in as one text part.
    await register(
      ctx.session.hook<V2ContextEvent>("context", async (event) => {
        if (!event?.sessionID) return;
        const memory = await core.memoryContext(event.sessionID);
        if (!memory?.trim()) return;
        event.system.push({ type: "text", text: memory });
      }),
    );

    // Compaction: v1's `experimental.session.compacting`. V2 lets a hook both
    // observe and replace the summary; claude-mem only observes and lets the
    // worker write its own summary through the normal request path.
    await register(
      ctx.session.hook<V2CompactionEvent>("compaction", async (event) => {
        if (!event?.sessionID) return;
        await core.captureSummary(event.sessionID);
      }),
    );
  }

  // Custom tool: v1 returned a `tool` map, v2 registers through a transform.
  if (ctx.tool?.transform) {
    await register(
      ctx.tool.transform((editor) => {
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

  // Bus events (session.idle summarize, session.deleted cleanup). The stream is
  // a long-lived subscription, so it is driven by an AbortController owned by
  // the plugin cleanup rather than by an awaited hook registration.
  const cleanupController = new AbortController();
  if (ctx.event?.subscribe) {
    void subscribeToBus(ctx, core, cleanupController.signal);
  }

  return async () => {
    cleanupController.abort();
    await Promise.all(registrations.map((r) => r.dispose().catch(() => {})));
  };
}
