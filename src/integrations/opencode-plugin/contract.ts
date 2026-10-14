/**
 * OpenCode plugin event contract.
 *
 * These constants and helpers describe the contract between claude-mem's
 * OpenCode plugin and OpenCode's host API. They live OUTSIDE the plugin entry
 * module (`index.ts`) on purpose: OpenCode's plugin loader imports the entry
 * module and treats EVERY export as a plugin factory, requiring each one to
 * be a function (non-function exports fail the load with
 * "Plugin export is not a function", and even extra function exports would be
 * invoked as plugins). Data exports and pure helpers must therefore live in
 * their own module; the entry module exports only the plugin factory
 * (#3330).
 */

/**
 * OpenCode plugin event contract.
 *
 * OpenCode has two plugin contracts and claude-mem implements both. The mapping
 * is not mechanical: V2 does not translate a V1 hooks object, so every hook is
 * re-registered through the imperative `ctx.*.hook()` API.
 *
 * | concern              | V1 hook name                         | V2 registration                               |
 * |----------------------|--------------------------------------|-----------------------------------------------|
 * | tool capture         | `tool.execute.after`                 | `ctx.tool.hook("execute.after")`              |
 * | user prompt          | `chat.message` (role === "user")     | `ctx.session.hook("prompt")`                  |
 * | memory injection     | `experimental.chat.system.transform` | `ctx.session.hook("context")`                 |
 * | compaction           | `experimental.session.compacting`    | `ctx.session.hook("compaction")` drops the    |
 * |                      |                                      | cached memory; bus `session.compaction.ended` |
 * |                      |                                      | summarizes                                    |
 * | turn finished        | `event` `session.idle`               | bus `session.execution.succeeded`             |
 * | session deleted      | `event` `session.deleted`            | bus `session.deleted`                         |
 * | custom tool          | `tool` map on the return value       | `ctx.tool.transform()`                        |
 *
 * The V2 bus is `ctx.event.subscribe()`; see REAL_OPENCODE_V2_EVENT_TYPES.
 *
 * V1 hook names (authoritative source: plans/08-opencode-integration.md "Fix
 * sequence" step 1, cross-checked against OpenCode's documented plugin API):
 *
 *   - `tool.execute.after`            (input, output) — fires after every tool run
 *   - `chat.message`                  ({}, output)    — fires on each chat message
 *   - `event`                         ({ event })     — generic bus; event.type carries the name
 *   - `experimental.session.compacting`               — fires when a session compacts
 *   - `experimental.chat.system.transform` (input, { system }) — builds each request's
 *                                                       system prompt; memory context is pushed here
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

export type RealOpenCodeEventType = (typeof REAL_OPENCODE_EVENT_TYPES)[number];

/**
 * The V2 bus event types the V2 adapter reacts to, as `@opencode/schema`
 * 2.0.22 names them. V2 events are `{ type, data, location }` envelopes, and
 * V2 has no `session.idle`: a finished turn is `session.execution.succeeded`,
 * and the last `session.text.ended` before it carries the reply.
 */
export const REAL_OPENCODE_V2_EVENT_TYPES = [
  "session.text.ended",
  "session.execution.succeeded",
  "session.compaction.ended",
  "session.deleted",
] as const;

/**
 * The V1 hook keys the V1 adapter returns. The contract test asserts these are
 * the real OpenCode hook names.
 */
export const REGISTERED_OPENCODE_HOOKS = [
  "tool.execute.after",
  "chat.message",
  "event",
  "experimental.session.compacting",
  "experimental.chat.system.transform",
] as const;

/**
 * The V2 registrations as `host domain` + `hook name` pairs. V2's API is
 * namespaced, so these are not bare hook names.
 */
export const REGISTERED_OPENCODE_V2_HOOKS = [
  { domain: "tool", hook: "execute.after" },
  { domain: "session", hook: "prompt" },
  { domain: "session", hook: "context" },
  { domain: "session", hook: "compaction" },
  { domain: "event", hook: "subscribe" },
  { domain: "tool", hook: "transform" },
] as const;

/**
 * The default export's plugin id. V2 reads it from the module and requires it;
 * it is also the handle `opencode.json(c)` uses to disable the plugin.
 */
export const OPENCODE_PLUGIN_ID = "claude-mem";

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
  } catch {
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
