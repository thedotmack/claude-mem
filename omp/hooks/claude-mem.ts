/**
 * omp -> claude-mem observation bridge.
 *
 * Ports the claude-mem team's OpenClaw adapter (openclaw/src/index.ts, 1140 loc)
 * to the omp hook event bus, so omp sessions are written into the same claude-mem
 * store that Claude Code and Cursor already write to — one shared memory across
 * all three agents.
 *
 * Discovery: omp auto-discovers `.omp/hooks/pre/*.ts` (project <cwd>/.omp and user
 * ~/.omp/agent via getAgentDir()); the file loads as an extension module and
 * `pi.on(...)` binds to the runtime event bus (oh-my-pi CHANGELOG #2796). The
 * `tool` field derived from the filename is only the capability dedup key
 * `${type}:${tool}:${name}`, NOT a runtime emission scope — emitToolResult
 * (extensions/runner.ts) iterates handlers by event name with no tool filter, so
 * this file receives tool_result for every tool.
 *
 * Advisor-signoff contract notes:
 *  - context handler MAY return { messages }, but that REPLACES the conversation
 *    (chained replacement). We spread the original messages back in and append
 *    one system message — never return only injected text (would wipe the chat).
 *  - contentSessionId is process-stable and regenerated only on session_compact
 *    (one claude-mem session per omp session, not per prompt — before_agent_start
 *    fires once per user prompt, so we never mint a new id there).
 *  - every user prompt posts init (the worker de-duplicates a repeated prompt),
 *    as the Claude Code hooks do, each after the previous one so prompts are
 *    recorded in order. Observations wait for the latest prompt's init and are
 *    dropped when the worker did not record it. A tool result never inits on
 *    its own: a prompt-less init would pin the session to "[media prompt]".
 *  - All POSTs are fire-and-forget via detached chains; the handler returns
 *    synchronously and never blocks the tool dispatch (30s handler cap). Every
 *    request is bounded by a timeout, which counts as a breaker failure.
 *  - The project is never named here: every request carries the session's cwd
 *    and the worker resolves the project key from it, the same resolver the
 *    Claude Code hooks use (worktrees, markers, environments).
 */

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HookAPI } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const MAX_LEN = 1000; // tool_response hard cap (OpenClaw)
const CTX_CACHE_MS = 60_000; // /api/context/inject cache TTL (OpenClaw)
// A hung worker must not hold OMP's handlers: the context handler is awaited
// before every model call, so an unbounded fetch added up to OMP's 30 s handler
// cap per call, and the breaker never saw a failure.
const REQUEST_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// Worker endpoint
// ---------------------------------------------------------------------------

/**
 * claude-mem's settings.json, read the way claude-mem reads it: from
 * CLAUDE_MEM_DATA_DIR (default ~/.claude-mem); its keys sit under `env` when
 * that block holds CLAUDE_MEM_* keys, else at the root. Empty on any error.
 */
function readClaudeMemSettings(): Record<string, unknown> {
  const dataDir = process.env.CLAUDE_MEM_DATA_DIR || join(homedir(), ".claude-mem");
  try {
    const doc = JSON.parse(readFileSync(join(dataDir, "settings.json"), "utf8").replace(/^﻿/, ""));
    const env = doc?.env;
    const nested = env !== null && typeof env === "object" && !Array.isArray(env)
      && Object.keys(env).some(key => key.startsWith("CLAUDE_MEM_"));
    return nested ? env : (doc ?? {});
  } catch {
    return {};
  }
}

/** Env wins over settings.json, which wins over claude-mem's own default. */
function setting(settings: Record<string, unknown>, key: string, fallback: string): string {
  const fromEnv = process.env[key];
  if (fromEnv) return fromEnv;
  const fromFile = settings[key];
  return typeof fromFile === "string" && fromFile ? fromFile : fallback;
}

function resolveWorkerBase(): string {
  const settings = readClaudeMemSettings();
  const defaultPort = String(37700 + ((process.getuid?.() ?? 77) % 100));
  const port = setting(settings, "CLAUDE_MEM_WORKER_PORT", defaultPort);
  const host = setting(settings, "CLAUDE_MEM_WORKER_HOST", "127.0.0.1");
  const urlHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${urlHost}:${port}`;
}

// Resolved once per omp session (session_start clears it), so a port change in
// settings.json is picked up by the next session without a restart.
let workerBase: string | undefined;

function worker(): string {
  workerBase ??= resolveWorkerBase();
  return workerBase;
}

// ---------------------------------------------------------------------------
// Circuit breaker (OpenClaw pattern) — 3 consecutive failures => 30s OPEN
// ---------------------------------------------------------------------------

let tripCount = 0;
let openUntil = 0;

function breakerOpen(): boolean {
  return Date.now() < openUntil;
}

function onFail(): void {
  tripCount++;
  if (tripCount >= 3) {
    openUntil = Date.now() + 30_000;
    tripCount = 0;
  }
}

function onOk(): void {
  tripCount = 0;
  openUntil = 0;
}

// ---------------------------------------------------------------------------
// Session state (process-stable contentSessionId)
// ---------------------------------------------------------------------------

interface OmpSession {
  id: string;
  // The tail of the session's init chain: the latest prompt's init, which
  // resolves true once the worker recorded that prompt. Observations and the
  // summary wait on it so they land after the prompts they belong to.
  lastInit?: Promise<boolean>;
  // The worker recorded at least one prompt for this id (finalize needs one).
  anchored: boolean;
  // The worker skipped this checkout as excluded: nothing more is sent.
  excluded: boolean;
}

let session: OmpSession | undefined;
let ctxCache: { at: number; cwd: string; md: string } | null = null;
let lastAssistant = ""; // captured on agent_end, sent at summarize

function newSession(): OmpSession {
  session = { id: `omp-${process.pid}-${randomUUID()}`, anchored: false, excluded: false };
  return session;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map(c => (c && typeof c === "object" && "type" in c && c.type === "text" ? String(c.text ?? "") : ""))
      .join("\n")
      .trim();
  }
  return "";
}

// Find the last message of `role` and return its text. Handles string content or
// [{type:"text",text}] chunks. Empty when the event carries no such message.
function lastMessageText(messages: unknown[], role: string): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && typeof m === "object" && "role" in m && m.role === role && "content" in m) {
      return typeof m.content === "string" ? m.content : textFromContent(m.content);
    }
  }
  return "";
}

/** One bounded worker request; a timeout or an HTTP error rejects. */
async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const r = await fetch(`${worker()}${path}`, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!r.ok) throw new Error(`${path} ${r.status}`);
  return r;
}

function postJson(path: string, body: unknown): Promise<Response> {
  return request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function post(path: string, body: unknown): Promise<void> {
  if (breakerOpen()) return Promise.resolve();
  return postJson(path, body).then(() => onOk(), () => onFail());
}

/**
 * Record one user prompt for `target`. Every prompt posts init, so prompts 2+
 * are recorded too (the worker de-duplicates a repeated prompt). Each init
 * waits for the previous one, so overlapping prompts reach the worker in order
 * and finalize, which waits for the chain's tail, covers all of them. A failed
 * init is counted by the breaker, and a later prompt simply tries again.
 */
function sendPrompt(target: OmpSession, cwd: string | undefined, prompt: string): void {
  const body: Record<string, unknown> = { contentSessionId: target.id, prompt, platformSource: "omp" };
  if (cwd) body.cwd = cwd;
  target.lastInit = (target.lastInit ?? Promise.resolve(true)).then(() => recordPrompt(target, body));
}

// Resolves true once the worker recorded the prompt. Success is counted only
// after the reply is read: a body that stalls until the timeout is a failure,
// not a recorded prompt.
async function recordPrompt(target: OmpSession, body: Record<string, unknown>): Promise<boolean> {
  if (target.excluded || breakerOpen()) return false;
  try {
    const r = await postJson("/api/sessions/init", body);
    const reply = (await r.json()) as { reason?: unknown } | null;
    onOk();
    // An excluded checkout is skipped before any session row exists.
    if (reply?.reason === "project_excluded") {
      target.excluded = true;
      return false;
    }
    target.anchored = true;
    return true;
  } catch {
    onFail();
    return false;
  }
}

// Finalize a session the worker recorded a prompt for. Chained after its latest
// init, so the summary never overtakes the prompts it summarizes; a session
// with no recorded prompt (every init failed, or the checkout is excluded) is
// left alone.
function finalize(target: OmpSession | undefined, assistantMessage: string): void {
  if (!target) return;
  void (target.lastInit ?? Promise.resolve(false)).then(() => {
    if (!target.anchored || target.excluded) return;
    return post("/api/sessions/summarize", {
      contentSessionId: target.id,
      last_assistant_message: assistantMessage,
      platformSource: "omp",
    });
  });
}

// ---------------------------------------------------------------------------
// Hook factory
// ---------------------------------------------------------------------------

export default function claudeMemBridge(pi: HookAPI): void {
  // session_start: mint the per-session contentSessionId. Init is deferred to
  // before_agent_start so we can capture the real user prompt (the worker records
  // and privacy-filters on it).
  pi.on("session_start", async () => {
    workerBase = undefined;
    newSession();
  });

  // /new, /resume and branches switch sessions without firing session_start
  // again. Close the old prompt chain before rotating its bridge identity.
  const switchSession = async () => {
    finalize(session, lastAssistant);
    newSession();
    workerBase = undefined;
    ctxCache = null;
    lastAssistant = "";
  };
  pi.on("session_switch", switchSession);
  pi.on("session_branch", switchSession);

  // Compaction starts a new logical session in claude-mem too (matches Claude
  // Code's SessionStart clear/compact path): finalize the session that is
  // ending, then rotate the id. The next before_agent_start inits the new id
  // with the post-compact prompt.
  pi.on("session_compact", async () => {
    finalize(session, lastAssistant);
    newSession();
    // lastAssistant belongs to the logical session that just ended, so a
    // compact followed directly by session_shutdown must not attribute the
    // pre-compaction response to the replacement id.
    lastAssistant = "";
  });

  // before_agent_start fires once per user prompt: record it, every time. The
  // prompt is a direct `event.prompt` string (BeforeAgentStartEvent in both
  // hooks/types.ts:281 and extensions/types.ts:705) — NOT in event.messages.
  // Never mint a new id here.
  pi.on("before_agent_start", async (event, ctx) => {
    const prompt = typeof event?.prompt === "string" ? event.prompt : "";
    sendPrompt(session ?? newSession(), ctx?.cwd, prompt);
  });

  // tool_result: the observation pipeline. Fire-and-forget; handler returns void
  // immediately. Waits for the latest prompt's init, then POSTs the observation
  // on a detached chain, unless the worker did not record that prompt or
  // excluded the checkout. It never inits: a tool result before the first
  // prompt would otherwise pin the session to "[media prompt]" (the worker
  // creates the session row from the observation itself when no prompt came
  // first).
  pi.on("tool_result", async (event, ctx) => {
    const toolName = String(event?.toolName ?? "");
    if (!toolName || toolName.startsWith("memory_")) return; // avoid claude-mem recursion

    const target = session ?? newSession();
    if (target.excluded) return;
    const response = textFromContent(event?.content);
    // isError rows are valuable — never skip them. tool_input is sent raw (the
    // worker serializes it once); tool_response is capped to MAX_LEN.
    const body: Record<string, unknown> = {
      contentSessionId: target.id,
      tool_name: toolName,
      tool_input: event?.input,
      tool_response: response.length > MAX_LEN ? response.slice(0, MAX_LEN) : response,
      platformSource: "omp",
    };
    if (ctx?.cwd) body.cwd = ctx.cwd;

    void (target.lastInit ?? Promise.resolve(true)).then(recorded => {
      if (!recorded || target.excluded) return;
      return post("/api/sessions/observations", body);
    });
  });

  // agent_end: remember the last assistant message so summarize has an anchor.
  // (fires every prompt loop; just overwrites — cheap)
  pi.on("agent_end", async event => {
    if (Array.isArray(event?.messages)) lastAssistant = lastMessageText(event.messages, "assistant");
  });

  // context: inject recent memory. MUST preserve the original conversation —
  // returning { messages } replaces the chain, so we re-spread originals and
  // append exactly one system message with the cached context markdown.
  pi.on("context", async (event, ctx) => {
    if (breakerOpen()) return;
    const cwd = ctx?.cwd;
    if (!cwd) return;
    const now = Date.now();

    if (!ctxCache || ctxCache.cwd !== cwd || now - ctxCache.at > CTX_CACHE_MS) {
      try {
        const r = await request(`/api/context/inject?cwd=${encodeURIComponent(cwd)}&platformSource=omp`);
        const md = (await r.text()) ?? "";
        onOk();
        // Only cache non-empty — an empty result means "no memory yet", caching it
        // would delay newly-arriving memory by CTX_CACHE_MS.
        if (md.trim()) ctxCache = { at: now, cwd, md };
        else ctxCache = null;
      } catch {
        onFail();
        return; // leave conversation untouched
      }
    }

    const injected = (ctxCache?.md ?? "").trim();
    if (!injected) return; // no memory available this session — do not mutate

    const original = Array.isArray(event?.messages) ? event.messages : [];
    return { messages: [...original, { role: "system", content: injected }] };
  });

  // session_shutdown: finalize the claude-mem session and drop in-memory state.
  // finalize captures the session and assistant message before the reset
  // below: its detached chain runs after this handler has cleared them.
  pi.on("session_shutdown", async () => {
    finalize(session, lastAssistant);

    session = undefined;
    ctxCache = null;
    lastAssistant = "";
  });
}
