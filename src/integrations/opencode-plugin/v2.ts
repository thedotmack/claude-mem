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
 *   —  (pre-validation detection, no V1 equivalent)
 *                                       -> ctx.tool.hook("execute.before")
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
 * `@opencode/plugin`, to stay bundle-safe), so the surface is typed locally
 * and read defensively: the plugin API is still beta and field shapes can move.
 */

import { isClaudeMemTool, WORK_STATE_WRITE_TOOL } from "../../shared/work-state-tool.js";
import { CONTEXT_TAG_CLOSE, CONTEXT_TAG_OPEN } from "../../utils/context-injection.js";
import {
  guidanceForPaths,
  hintForPath,
  MAX_ENRICHMENT_CHARS,
  parseValidationIssues,
  renderKeyList,
  toolKeyNames,
  type ValidationIssue,
} from "./tool-call-guidance.js";
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
  agent?: string;
  id?: string;
  info?: { name?: string; input?: unknown };
  input?: Record<string, unknown>;
  args?: Record<string, unknown>;
  result?: unknown;
  error?: { message?: string } | string;
}

/** The V2 `execute.before` envelope, before the host validates the tool input. */
export interface V2ToolExecuteBeforeEvent {
  tool: string;
  sessionID: string;
  agent: string;
  info?: { name?: string; description?: string; input?: unknown };
  input: Record<string, unknown>;
}

export interface V2PromptEvent {
  sessionID: string;
  prompt: { text?: string };
}

export interface V2ContextEvent {
  sessionID: string;
  agent: string;
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

// The prompt hook's model read is best-effort. Bound it to the worker handoff
// deadline so a beta `session.get()` that never settles cannot hold a prompt.
const OBSERVER_MODEL_READ_TIMEOUT_MS = 250;

// Bounds the per-session reply cache on a long-lived server, as core.ts
// bounds its session maps. The same bound applies to the transient raw-key map.
const MAX_TRACKED_SESSIONS = 1000;

// A Code Mode script is scanned, never executed; oversized scripts are skipped.
const MAX_CODE_CHARS = 8 * 1024;

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
    hook?: {
      (
        name: "execute.before",
        callback: (event: V2ToolExecuteBeforeEvent) => Promise<void> | void,
      ): Promise<V2Registration>;
      (
        name: "execute.after",
        callback: (event: V2ToolExecuteAfterEvent) => Promise<void> | void,
      ): Promise<V2Registration>;
    };
    /** The host's tool catalog, used to recover a schema for Code Mode calls. */
    list?: () => Promise<Array<{ id: string; name?: string; input?: unknown }>>;
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
    /**
     * V2 exposes the session's selected model here, rather than on a
     * chat-message input. Only `id` is endpoint-ready; `providerID/id` is a
     * display key, not an inference endpoint model name, so it must never be
     * forwarded as one. The read is best-effort (see the `prompt` hook).
     */
    get?: (input: { sessionID: string }) => Promise<{
      model?: { providerID?: string; id?: string };
    } | undefined>;
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
 * Best-effort, time-bounded read of the prompt's own selected model. A missing
 * `get`, a failed read, or one that never settles all degrade to `undefined`
 * (the worker's global model fallback) without rejecting or stalling the prompt.
 */
async function readObserverModel(
  sessionDomain: OpenCodePluginContextV2["session"],
  sessionID: string,
): Promise<string | undefined> {
  const get = sessionDomain?.get;
  if (!get) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Resolve instead of reject on timeout: the race stays settled even if the
  // real read finishes later, so no rejection goes unhandled.
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), OBSERVER_MODEL_READ_TIMEOUT_MS);
    // A pending read must not keep the host process alive.
    (timer as { unref?: () => void }).unref?.();
  });
  try {
    const session = await Promise.race([
      // Member call preserves the host's `this` binding.
      get.call(sessionDomain, { sessionID }),
      deadline,
    ]);
    const modelID = session?.model?.id;
    return typeof modelID === "string" && modelID.trim() ? modelID : undefined;
  } catch {
    // Model capture is best-effort; never reject a prompt for it.
    return undefined;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
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
 * Names the root-level `required` keys a tool call did not supply, so the
 * `execute.before` trace can log key names without ever logging input values.
 * Only a literal top-level array is trusted: `$ref`/`anyOf` and nested schemas
 * are deliberately not resolved, because guessing a key name would produce a
 * false warning about a call that may still be valid.
 */
export function missingRequiredKeys(schema: unknown, input: Record<string, unknown>): string[] {
  if (!schema || typeof schema !== "object") return [];
  const required = (schema as { required?: unknown }).required;
  if (!Array.isArray(required)) return [];
  // An own key carrying `undefined` is not a supplied value: a client that
  // serializes `{ fields: undefined }` drops the key entirely on the wire.
  return required.filter(
    (key): key is string =>
      typeof key === "string"
      && (!Object.prototype.hasOwnProperty.call(input, key) || input[key] === undefined),
  );
}

/**
 * Top-level keys of a literal object argument. Nested values are skipped by
 * depth, and a computed or non-literal member never yields a name. An
 * unterminated argument is discarded rather than guessed at.
 */
function literalObjectKeys(code: string, open: number): string[] | undefined {
  const keys: string[] = [];
  let depth = 1;
  let atStart = true;
  let candidate: string | undefined;
  let quoted = false;
  for (let index = open + 1; index < code.length; index++) {
    const char = code[index];
    if (char === "'" || char === '"' || char === "`") {
      const quote = char;
      let value = "";
      index++;
      while (index < code.length && code[index] !== quote) {
        if (code[index] === "\\") {
          index++;
          if (index >= code.length) return undefined;
        }
        value += code[index];
        index++;
      }
      if (index >= code.length) return undefined;
      if (depth === 1 && atStart) {
        candidate = value;
        quoted = true;
      }
      atStart = false;
      continue;
    }
    if (char === "{" || char === "[" || char === "(") {
      if (char === "{" && depth === 1) atStart = true;
      else {
        atStart = false;
        candidate = undefined;
      }
      depth++;
      continue;
    }
    if (char === "}" || char === "]" || char === ")") {
      depth--;
      if (depth === 0) return keys;
      atStart = false;
      candidate = undefined;
      continue;
    }
    if (depth !== 1 || /\s/.test(char)) continue;
    if (char === ",") {
      atStart = true;
      candidate = undefined;
      quoted = false;
      continue;
    }
    if (char === ":") {
      if (candidate !== undefined && (quoted || /^[A-Za-z_$][\w$]*$/.test(candidate))) keys.push(candidate);
      candidate = undefined;
      quoted = false;
      atStart = false;
      continue;
    }
    if (atStart && /[A-Za-z_$]/.test(char)) {
      let end = index + 1;
      while (end < code.length && /[\w$]/.test(code[end])) end++;
      candidate = code.slice(index, end);
      quoted = false;
      atStart = false;
      index = end - 1;
      continue;
    }
    candidate = undefined;
    quoted = false;
  }
  return undefined;
}

const REGEX_AFTER_KEYWORDS = new Set([
  "return", "throw", "case", "delete", "typeof", "void", "instanceof",
  "in", "of", "new", "yield", "await", "else", "do",
]);

/**
 * A `/` opens a regex literal only where an expression can start. After an
 * operand — an identifier, a number, a closing bracket, a quote, a template or
 * an increment — it is division and must stay readable.
 */
function startsRegexLiteral(code: string, at: number): boolean {
  let previous = at - 1;
  while (previous >= 0 && /\s/.test(code[previous])) previous--;
  if (previous < 0) return true;
  const char = code[previous];
  if ((char === "+" || char === "-") && code[previous - 1] === char) return false;
  if ("([{,;:=!?&|+-*%<>~^".includes(char)) return true;
  if (/[A-Za-z_$]/.test(char)) {
    let start = previous;
    while (start > 0 && /[\w$]/.test(code[start - 1])) start--;
    return REGEX_AFTER_KEYWORDS.has(code.slice(start, previous + 1));
  }
  return false;
}

/** Index just past a regex literal's closing `/`, or undefined if unterminated. */
function regexEnd(code: string, at: number): number | undefined {
  let index = at + 1;
  let inClass = false;
  while (index < code.length) {
    const char = code[index];
    if (char === "\n" || char === "\r") return undefined;
    if (char === "\\") { index += 2; continue; }
    if (char === "[") { inClass = true; index++; continue; }
    if (char === "]") { inClass = false; index++; continue; }
    if (char === "/" && !inClass) return index + 1;
    index++;
  }
  return undefined;
}

/**
 * Same-length copy of a script with comments, regex literals and string
 * contents blanked, so a call written in prose is never mistaken for a live
 * call. Quoted bracket members stay readable because they are path segments
 * the call matcher must see, and `${...}` expressions stay readable because
 * they are code. Indexes are unchanged, so keys can still be read from the
 * original script.
 */
function maskNonCode(code: string): string {
  const out = code.split("");
  const blank = (start: number, end: number): void => {
    for (let at = start; at < end; at++) {
      if (out[at] !== "\n" && out[at] !== "\r") out[at] = " ";
    }
  };
  type Frame = { type: "template" | "expr"; depth: number };
  const stack: Frame[] = [];
  let index = 0;
  while (index < code.length) {
    const char = code[index];
    const next = code[index + 1];
    const top = stack[stack.length - 1];
    if (top?.type === "template") {
      if (char === "\\") { blank(index, Math.min(index + 2, code.length)); index += 2; continue; }
      if (char === "$" && next === "{") { stack.push({ type: "expr", depth: 0 }); index += 2; continue; }
      if (char === "`") { stack.pop(); index++; continue; }
      blank(index, index + 1);
      index++;
      continue;
    }
    if (char === "/" && next === "/") {
      const start = index;
      index += 2;
      while (index < code.length && code[index] !== "\n" && code[index] !== "\r") index++;
      blank(start, index);
      continue;
    }
    if (char === "/" && next === "*") {
      const start = index;
      index += 2;
      while (index < code.length && !(code[index] === "*" && code[index + 1] === "/")) index++;
      if (index < code.length) index += 2;
      blank(start, index);
      continue;
    }
    // A regex is consumed whole, before any quote or `//` inside it can start
    // a string or comment. `/` stays literal inside `[...]` and `\/` is escaped;
    // an unterminated `/` is left alone instead of eating the rest of the line.
    if (char === "/" && next !== "/" && next !== "*" && startsRegexLiteral(code, index)) {
      const end = regexEnd(code, index);
      if (end !== undefined) {
        let afterFlags = end;
        while (afterFlags < code.length && /[A-Za-z]/.test(code[afterFlags])) afterFlags++;
        blank(index, afterFlags);
        index = afterFlags;
        continue;
      }
    }
    if (char === "'" || char === '"') {
      const quote = char;
      const start = index;
      index++;
      while (index < code.length && code[index] !== quote) {
        if (code[index] === "\\") index += 2;
        else index++;
      }
      if (index < code.length) index++;
      let left = start - 1;
      while (left >= 0 && /\s/.test(code[left])) left--;
      let right = index;
      while (right < code.length && /\s/.test(code[right])) right++;
      const bracketMember = code[left] === "[" && code[right] === "]"
        && /^[\w.$-]+$/.test(code.slice(start + 1, index - 1));
      if (!bracketMember) blank(start + 1, index - 1);
      continue;
    }
    if (char === "`") { stack.push({ type: "template", depth: 0 }); index++; continue; }
    if (top?.type === "expr") {
      if (char === "{") top.depth++;
      else if (char === "}" && top.depth > 0) top.depth--;
      else if (char === "}") stack.pop();
    }
    index++;
  }
  return out.join("");
}

/**
 * Names the top-level keys of literal object arguments passed to claude-mem
 * tools inside a Code Mode script. The script is scanned as text: it is never
 * evaluated, repaired or replayed, and no argument value is retained. Calls
 * in comments or strings are masked out before matching. A non-literal
 * argument, a computed key, an unrelated tool or an oversized script yields no
 * names.
 */
export function extractRawKeyNames(code: string): string[] {
  if (typeof code !== "string" || !code || code.length > MAX_CODE_CHARS) return [];
  const names: unknown[] = [];
  const masked = maskNonCode(code);
  const calls = /\btools\b((?:\s*(?:\.\s*[A-Za-z_$][\w$]*|\[\s*['"][^'"]+['"]\s*\]))+)\s*\(/g;
  const segments = /(\.\s*([A-Za-z_$][\w$]*)|\[\s*['"]([^'"]+)['"]\s*\])/g;
  for (let call = calls.exec(masked); call !== null; call = calls.exec(masked)) {
    const path = call[1] ?? "";
    const parts: string[] = [];
    segments.lastIndex = 0;
    for (let part = segments.exec(path); part !== null; part = segments.exec(path)) {
      const name = part[2] ?? part[3];
      if (name) parts.push(name);
    }
    if (parts.length === 0 || !isClaudeMemTool(parts.join("."))) continue;
    let cursor = call.index + call[0].length;
    while (cursor < masked.length && /\s/.test(masked[cursor])) cursor++;
    if (masked[cursor] !== "{") continue;
    const keys = literalObjectKeys(code, cursor);
    if (keys) names.push(...keys);
  }
  return toolKeyNames(names);
}

/**
 * Enriches the error the model sees in the same turn, after `core.captureTool`
 * has stored the host's original message. Literal schema guidance, the raw
 * names of a Code Mode script and undeclared argument names are appended to
 * the existing message under one bound. The error object and every other
 * event field keep their identity; no input is repaired or replayed and no
 * argument value is logged.
 */
export function enrichValidationError(event: V2ToolExecuteAfterEvent, rawNames: string[]): boolean {
  if (event.status !== "error") return false;
  const error = event.error;
  if (!error || typeof error !== "object" || typeof error.message !== "string") return false;
  const original = error.message;
  // A policy refusal is the host's decision: it must not be rewritten.
  if (!original || original.includes("<private>")) return false;

  const schema = event.info?.input;
  const tool = event.info?.name ?? event.tool;
  const issues = parseValidationIssues(original);
  const details = issues.filter((issue) => issue.path !== "");
  const counter = issues.find((issue) => issue.path === "")?.message;
  // Root missing keys outrank root value errors, which outrank nested paths.
  const rank = (issue: ValidationIssue): number =>
    /[.[\]]/.test(issue.path) ? 2 : /missing key/i.test(issue.message) ? 0 : 1;
  const ranked = [...details].sort((left, right) => rank(left) - rank(right));
  const kept = ranked.slice(0, 3);

  const lines: string[] = [];
  // Guidance comes from literal schema fields only; a direct call needs no
  // raw-name claim. The primary key is the first kept issue or the raw name.
  // It goes first: the single truncation bound must never cut the most
  // actionable instruction after a long list of issues.
  const primary = kept[0]?.path ?? rawNames.find((name) => typeof name === "string");
  if (tool && primary) {
    const [entry] = guidanceForPaths(schema, [primary]);
    if (entry?.type) {
      lines.push(`Reissue ${tool} with ${entry.key}: ${entry.type}${entry.description ? ` — ${entry.description}` : ""}`);
    }
  }

  for (const issue of kept) {
    const hint = hintForPath(schema, issue.path);
    lines.push(`- ${issue.path}: ${issue.message}${hint ? ` (${hint})` : ""}`);
  }
  if (counter) lines.push(`- ${counter}`);

  // Only the diagnostic JSON block is read, bounded and under try/catch. Its
  // top-level keys are names; a value never enters the enrichment.
  const header = "Arguments provided:\n";
  const start = original.indexOf(header);
  if (start >= 0) {
    const rest = original.slice(start + header.length);
    const block = rest.length <= MAX_CODE_CHARS ? rest.split(/\n\s*\n/, 1)[0] : "";
    if (block) {
      try {
        const provided: unknown = JSON.parse(block);
        if (provided && typeof provided === "object" && !Array.isArray(provided)) {
          const properties = (schema as { properties?: unknown } | null)?.properties;
          if (properties && typeof properties === "object" && !Array.isArray(properties)) {
            const undeclared = Object.keys(provided).filter(
              (key) => !Object.prototype.hasOwnProperty.call(properties, key),
            );
            const names = renderKeyList(undeclared);
            if (names) lines.push(`undeclared: ${names}`);
          }
        }
      } catch {
        // A malformed diagnostic block is not a contract to parse.
      }
    }
  }

  const raw = renderKeyList(rawNames);
  if (raw) lines.push(`Raw keys from execute: ${raw}`);

  if (lines.length === 0) return false;
  // One emission bound; the host's prefix stays untouched and ours goes last.
  const addition = `\n${lines.join("\n")}`.slice(0, MAX_ENRICHMENT_CHARS);
  try {
    error.message = original + addition;
    return true;
  } catch {
    // A frozen or accessor-backed host error must not throw out of the hook.
    return false;
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
  const directory = context.location?.directory ?? context.directory;
  if (typeof directory !== "string" || directory === "") {
    // OpenCode also calls setup() with a host registry that has no checkout.
    // Registering hooks there would send every write to the worker without a cwd.
    return async () => {};
  }
  const ctx: CoreContext = {
    directory,
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
  // Key names from an outer `execute` script, waiting for the nested tool's
  // `execute.after`. Names only, bounded like the reply cache, and consumed at
  // most once; no bus, no id correlation, no file or POST.
  const rawNamesBySessionAgent = new Map<string, string[]>();
  const rawKey = (sessionID: string, agent: string): string => `${sessionID}\u0000${agent}`;
  const rememberRawNames = (sessionID: string, agent: string, names: string[]): void => {
    if (!sessionID) return;
    const key = rawKey(sessionID, agent);
    // A later script with no literal call must not inherit the previous one's
    // names: replace the entry, including with an empty one that drops it.
    if (names.length === 0) { rawNamesBySessionAgent.delete(key); return; }
    if (!rawNamesBySessionAgent.has(key) && rawNamesBySessionAgent.size >= MAX_TRACKED_SESSIONS) {
      const oldest = rawNamesBySessionAgent.keys().next().value;
      if (oldest !== undefined) rawNamesBySessionAgent.delete(oldest);
    }
    // The extractor already sorted and bounded the names. No read at `before`:
    // the map is consumed only by the nested `execute.after`.
    rawNamesBySessionAgent.set(key, names);
  };
  const forgetRawNames = (sessionID: string): void => {
    const prefix = `${sessionID}\u0000`;
    for (const key of rawNamesBySessionAgent.keys()) {
      if (key.startsWith(prefix)) rawNamesBySessionAgent.delete(key);
    }
  };
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

  // Pre-validation detection. This registration is deliberately local: register()
  // disposes every prior registration when a hook throws, so a host that does
  // not support execute.before must not tear down the capture hooks below.
  if (toolDomain?.hook) {
    const hook = toolDomain.hook.bind(toolDomain);
    try {
      registrations.push(await hook("execute.before", async (event: V2ToolExecuteBeforeEvent) => {
        if (!event?.sessionID) return;
        // Only the outer `execute` call carries the script. Deposit names here;
        // never enrich or mutate the event at this hook. Another tool's `code`
        // (a shell command grepping source, for instance) is not a script.
        if (event.tool === "execute") {
          const code = (event.input as Record<string, unknown> | undefined)?.code;
          if (typeof code === "string") {
            rememberRawNames(event.sessionID, event.agent ?? "", extractRawKeyNames(code));
          }
        }
        const named = event.info?.name ?? event.tool;
        if (!isClaudeMemTool(event.tool) && !WORK_STATE_WRITE_TOOL.test(named ?? "")) return;
        const input = (event.input ?? {}) as Record<string, unknown>;
        // A normal call carries its schema in info.input; reading the catalog is
        // only the Code Mode fallback for a call with no info. A beta host may
        // reject that read: degrade to no schema (and therefore no warning) rather
        // than throwing out of the callback.
        const infoSchema = event.info?.input;
        let schema: unknown = infoSchema;
        if (infoSchema === undefined) {
          try {
            const catalog = (await toolDomain.list?.()) ?? [];
            const last = event.tool.split(".").at(-1);
            schema = catalog.find((tool) =>
              tool.id === event.tool
              || tool.id === last
              || tool.name === last
              || tool.id.replace(/[._]/g, "_").endsWith(`_${last}`)
            )?.input;
          } catch {
            // Best effort: a catalog refusal is not a tool-call failure.
          }
        }
        const missing = missingRequiredKeys(schema, input);
        if (missing.length === 0) return; // before validation: the call may still be repaired or refused by policy
        const sorted = missing.sort();
        // Schema-derived shape only: never the argument bag. One line, bounded,
        // so a verbose description cannot turn the trace into a log flood.
        const hint = schema == null ? undefined : hintForPath(schema, sorted[0] ?? "");
        const boundedHint = hint?.replace(/[\r\n]+/g, " ").slice(0, 200);
        console.warn(`[claude-mem] pre-validation: ${event.tool} session=${event.sessionID} missing=${sorted.join(",")}${boundedHint ? ` hint=${boundedHint}` : ""}`);
      }));
    } catch (error: unknown) {
      // Best effort: a beta host may not expose this hook yet.
      console.warn("[claude-mem] execute.before unavailable", error);
    }
  }

  // Primary capture path: every tool execution becomes an observation.
  if (toolDomain?.hook) {
    const hook = toolDomain.hook.bind(toolDomain);
    await register(() =>
      hook("execute.after", async (event) => {
        const sessionID = event.sessionID;
        let tool = event.tool;
        if (!sessionID || !tool) return;
        // The outer execute deposits names at `before`; when it finishes, its
        // nested after hooks have run. Drop anything they did not consume so a
        // later direct call cannot inherit this script's keys.
        if (tool === "execute") rawNamesBySessionAgent.delete(rawKey(sessionID, event.agent ?? ""));
        // The nested tool's after is the one consumer of the script's names:
        // read on error, purge on any recognized status so no stale name can
        // reach a later direct call. The outer execute after is never read.
        const named = event.info?.name ?? tool;
        const claudeMemCall = isClaudeMemTool(tool) || WORK_STATE_WRITE_TOOL.test(named ?? "");
        let rawNames: string[] = [];
        if (claudeMemCall) {
          const key = rawKey(sessionID, event.agent ?? "");
          if (event.status === "error") rawNames = rawNamesBySessionAgent.get(key) ?? [];
          rawNamesBySessionAgent.delete(key);
        }
        trackSession(sessionID);
        // Current V2 built-ins use these names; the core keeps V1's vocabulary.
        if (tool === "patch") tool = "apply_patch";
        if (tool === "shell") tool = "bash";
        // v2 names the argument bag `input`; `args` is tolerated because the
        // beta shape has moved before.
        let args = (event.input ?? event.args) as Record<string, unknown> | undefined;
        const readResultType = (event.result as { output?: { type?: string } } | null)?.output?.type;
        if (tool === "read" && typeof args?.path === "string"
          && (readResultType === "file" || readResultType === "text-page")
          && !/^[a-z][a-z0-9+.-]*:\/\//i.test(args.path)
          && args.file_path === undefined && args.filePath === undefined) {
          const { path, ...rest } = args;
          args = { ...rest, file_path: path };
        }
        // A failed tool still ran, and its error message is the interesting
        // part; v1 received the same string through `output`.
        const result = event.result;
        const output =
          event.status === "error"
            ? errorMessage(event.error ?? "")
            : extractResultText(result);
        await core.captureTool({ tool, sessionID, args, output, failed: event.status === "error",
          ...(tool !== event.tool ? { nativeToolName: event.tool } : {}),
        });
        // The observation above holds the host's original error; enrich only
        // the event the model sees, after capture. A direct call has no raw
        // names but still gets shape guidance from its own schema.
        if (event.status === "error" && claudeMemCall) {
          enrichValidationError(event, rawNames);
        }
      }),
    );
  }

  // User prompts: v1 read them off `chat.message`. V2 admits them through the
  // `prompt` hook, which runs once per admitted prompt.
  if (sessionDomain?.hook) {
    const hook = sessionDomain.hook.bind(sessionDomain);
    await register(() =>
      hook<V2PromptEvent>("prompt", async (event) => {
        if (!event?.sessionID) return;
        const promptText = event?.prompt?.text?.trim();
        if (!promptText) {
          core.forgetSemanticContext(event.sessionID);
          return;
        }
        trackSession(event.sessionID);
        // Read the selected model from this prompt's own session, before the
        // session-init POST runs. The V2 API is beta: a missing `get`, a failed
        // read, or one that never settles must not fail or delay the prompt.
        // Forward `model.id` only as a non-empty string and let core omit the
        // key (the worker's global fallback applies). Never send
        // `providerID/model.id`.
        const observerModel = await readObserverModel(sessionDomain, event.sessionID);
        await core.captureUserPrompt(event.sessionID, promptText, observerModel);
        core.primeSemanticContext(event.sessionID, promptText);
      }),
    );

    // Memory context: v1 pushed a raw string onto `output.system`; v2's system
    // prompt is a list of typed parts, so the context goes in as one text part,
    // tagged so the next build can find it. OpenCode runs this hook for every
    // model request, and a block left by an earlier run is replaced, not stacked.
    await register(() =>
      hook<V2ContextEvent>("context", async (event) => {
        if (!event?.sessionID || !Array.isArray(event.system)) return;
        const memory = (await core.memoryContext(event.sessionID))?.trim() ?? "";
        const semantic = (await core.semanticContext(event.sessionID))?.trim() ?? "";
        const combined = [memory, semantic].filter(Boolean).join("\n\n");
        removeMemoryParts(event.system);
        if (!combined) return;
        event.system.push({ type: "text", text: `${CONTEXT_TAG_OPEN}\n${combined}\n${CONTEXT_TAG_CLOSE}` });
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
            "Smart search (default), step 1: get a memory index. Review claude_mem_timeline, then fetch only selected IDs with claude_mem_get_observations.",
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
        editor.add({
          name: "claude_mem_timeline",
          description: "Smart search, step 2: inspect context around an observation ID from claude_mem_search.",
          input: { type: "object", properties: { anchor: { type: "integer" } }, required: ["anchor"] },
          execute: async (input: Record<string, unknown>) => ({ content: await core.timeline(Number(input.anchor)) }),
        });
        editor.add({
          name: "claude_mem_get_observations",
          description: "Smart search, step 3: fetch only IDs selected after reviewing the index and timeline. At most 100 ids per call; split larger selections.",
          input: { type: "object", properties: { ids: { type: "array", items: { type: "integer" }, minItems: 1, maxItems: 100 } }, required: ["ids"] },
          execute: async (input: Record<string, unknown>) => ({ content: await core.getObservations(input.ids as number[]) }),
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
        forgetRawNames(sessionID);
        core.forgetSession(sessionID);
        return;
      case "session.text.ended":
        // A turn has several text.ended events and one can precede the nested
        // after, so this is not a safe place to purge pending raw names.
        if (replyBySessionId.has(sessionID) && typeof event.data?.text === "string") {
          replyBySessionId.set(sessionID, event.data.text);
        }
        return;
      // V1's session.idle: the turn (or compaction) finished. The nested after
      // precedes execution.succeeded, so a name still here has no consumer.
      case "session.execution.succeeded":
      case "session.compaction.ended":
        forgetRawNames(sessionID);
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
    rawNamesBySessionAgent.clear();
    await disposeRegistrations();
  };
}
