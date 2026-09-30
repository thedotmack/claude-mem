import { ensureSessionInitialized, forgetSession, initSession, resolveProjectName } from "./sessions.js";
import { parseSearchResponse, truncate, workerGetText, workerPostFireAndForget } from "./worker.js";

/**
 * OpenCode V2 (2.x) plugin setup.
 *
 * OpenCode 2 validates the module's default export as `{ id, setup(ctx) }`
 * and calls `setup` once; everything is registered through the context, and
 * the returned function is the cleanup:
 *
 *   - `ctx.session.hook("prompt")`       — user prompt admitted; init the session
 *   - `ctx.tool.hook("execute.after")`   — every tool run becomes an observation
 *   - `ctx.session.hook("compaction")`   — summarize when a session compacts
 *   - `ctx.event.subscribe()`            — bus events, see V2_EVENT_TYPES
 *   - `ctx.tool.transform()`             — registers the claude_mem_search tool
 *
 * The shapes below mirror `@opencode/plugin` 2.x (`dist/promise/*.d.ts`) and
 * cover only the fields this plugin reads.
 */

/**
 * Bus event types the plugin reacts to; everything else is ignored. A turn
 * ends with `session.execution.succeeded` — OpenCode 2 does not emit the V1
 * `session.idle` for it.
 */
export const V2_EVENT_TYPES = [
  "session.text.ended",
  "session.execution.succeeded",
  "session.deleted",
] as const;

type V2EventType = (typeof V2_EVENT_TYPES)[number];

interface Registration {
  readonly dispose: () => Promise<void>;
}

interface SessionPromptEvent {
  readonly sessionID: string;
  readonly messageID: string;
  prompt: { text?: string };
}

interface SessionCompactionEvent {
  readonly sessionID: string;
}

interface ToolContent {
  readonly type: string;
  readonly text?: string;
}

interface ToolResult {
  readonly output?: unknown;
  readonly content?: string | ReadonlyArray<ToolContent>;
}

type ToolExecuteAfterEvent = {
  readonly tool: string;
  readonly sessionID: string;
  readonly id: string;
  readonly input: unknown;
} & (
  | { readonly status: "completed"; result: ToolResult }
  | { readonly status: "error"; error: { readonly message?: string } }
);

interface BusEvent {
  readonly type: string;
  readonly data?: {
    readonly sessionID?: string;
    readonly text?: string;
  };
}

interface ToolEditor {
  add(tool: {
    name: string;
    description: string;
    input: Record<string, unknown>;
    execute: (input: unknown) => Promise<{ content: string }>;
  }): void;
}

export interface OpenCodeV2PluginContext {
  readonly location: {
    readonly directory: string;
    readonly project?: { readonly directory?: string };
  };
  readonly session: {
    hook(name: "prompt", callback: (event: SessionPromptEvent) => void | Promise<void>): Promise<Registration>;
    hook(name: "compaction", callback: (event: SessionCompactionEvent) => void | Promise<void>): Promise<Registration>;
  };
  readonly tool: {
    hook(name: "execute.after", callback: (event: ToolExecuteAfterEvent) => void | Promise<void>): Promise<Registration>;
    transform(callback: (editor: ToolEditor) => void): Promise<Registration>;
  };
  readonly event: {
    subscribe(options?: { signal?: AbortSignal }): AsyncIterable<BusEvent>;
  };
}

function toolResultText(event: ToolExecuteAfterEvent): string {
  if (event.status === "error") {
    return `Error: ${event.error?.message ?? "unknown error"}`;
  }
  const { content, output } = event.result ?? {};
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text as string)
      .join("\n");
  }
  if (output === undefined) return "";
  return typeof output === "string" ? output : JSON.stringify(output);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function handleEvent(event: BusEvent, projectName: string, cwd: string): void {
  const sessionID = event.data?.sessionID;
  if (!sessionID) return;

  switch (event.type as V2EventType) {
    case "session.text.ended": {
      const text = event.data?.text;
      if (!text) return;
      const contentSessionId = ensureSessionInitialized(sessionID, projectName);
      workerPostFireAndForget("/api/sessions/observations", {
        contentSessionId,
        tool_name: "assistant_message",
        tool_input: {},
        tool_response: truncate(text),
        cwd,
      });
      break;
    }
    case "session.execution.succeeded": {
      const contentSessionId = ensureSessionInitialized(sessionID, projectName);
      workerPostFireAndForget("/api/sessions/summarize", {
        contentSessionId,
        last_assistant_message: "",
      });
      break;
    }
    case "session.deleted": {
      forgetSession(sessionID);
      break;
    }
    default:
      break;
  }
}

async function consumeEvents(
  ctx: OpenCodeV2PluginContext,
  signal: AbortSignal,
  projectName: string,
  cwd: string,
): Promise<void> {
  try {
    for await (const event of ctx.event.subscribe({ signal })) {
      handleEvent(event, projectName, cwd);
    }
  } catch (error: unknown) {
    if (signal.aborted || isAbortError(error)) return;
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[claude-mem] OpenCode event subscription ended: ${message}`);
  }
}

export async function setupV2(ctx: OpenCodeV2PluginContext): Promise<() => Promise<void>> {
  const cwd = ctx.location.directory;
  const projectName = resolveProjectName(ctx.location.project?.directory, cwd);

  console.log(`[claude-mem] OpenCode plugin loading (project: ${projectName})`);

  const registrations: Registration[] = [];

  registrations.push(
    await ctx.session.hook("prompt", (event) => {
      initSession(event.sessionID, projectName, event.prompt?.text ?? "");
    }),
  );

  // Capture every tool execution as an observation. This is the primary
  // capture path (#2419).
  registrations.push(
    await ctx.tool.hook("execute.after", (event) => {
      const contentSessionId = ensureSessionInitialized(event.sessionID, projectName);
      workerPostFireAndForget("/api/sessions/observations", {
        contentSessionId,
        tool_name: event.tool,
        tool_input: event.input ?? {},
        tool_response: truncate(toolResultText(event)),
        tool_use_id: event.id,
        cwd,
      });
    }),
  );

  // Observe only: leaving event.result unset lets OpenCode run its own compaction.
  registrations.push(
    await ctx.session.hook("compaction", (event) => {
      const contentSessionId = ensureSessionInitialized(event.sessionID, projectName);
      workerPostFireAndForget("/api/sessions/summarize", {
        contentSessionId,
        last_assistant_message: "",
      });
    }),
  );

  registrations.push(
    await ctx.tool.transform((editor) => {
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
          additionalProperties: false,
        },
        async execute(input: unknown): Promise<{ content: string }> {
          const query = String((input as { query?: unknown } | undefined)?.query ?? "");
          if (!query) {
            return { content: "Please provide a search query." };
          }
          const text = await workerGetText(
            `/api/search/observations?query=${encodeURIComponent(query)}&limit=10`,
          );
          if (!text) {
            return { content: "claude-mem worker is not running. Start it with: npx claude-mem start" };
          }
          return { content: parseSearchResponse(text, query) };
        },
      });
    }),
  );

  const controller = new AbortController();
  const subscription = consumeEvents(ctx, controller.signal, projectName, cwd);

  return async () => {
    controller.abort();
    await subscription;
    await Promise.all(registrations.map((registration) => registration.dispose()));
  };
}
