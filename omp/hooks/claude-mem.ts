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
 *  - init is fired exactly once per contentSessionId; observations await its
 *    promise so the first observation never lands before the session row exists.
 *  - All POSTs are fire-and-forget via detached chains; the handler returns
 *    synchronously and never blocks the tool dispatch (30s handler cap).
 */

import type { HookAPI } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const MAX_LEN = 1000; // tool_response hard cap (OpenClaw)
const CTX_CACHE_MS = 60_000; // /api/context/inject cache TTL (OpenClaw)

// ---------------------------------------------------------------------------
// Worker endpoint
// ---------------------------------------------------------------------------

function port(): number {
  // claude-mem default port derivation (docs/platform-integration.md).
  const envP = Number(process.env.CLAUDE_MEM_WORKER_PORT);
  if (Number.isFinite(envP) && envP > 0) return envP;
  try {
    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    return 37700 + (uid % 100);
  } catch {
    return 37700;
  }
}

const WORKER = `http://127.0.0.1:${port()}`;

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

let sid: string | undefined;
let initialized = false;
let initPromise: Promise<void> | undefined;
let ctxCache: { at: number; md: string } | null = null; // single project per omp process
let lastAssistant = ""; // captured on agent_end, sent at summarize

function newSid(): string {
  sid = `omp-${process.pid}-${Date.now().toString(36)}`;
  initialized = false;
  initPromise = undefined;
  return sid;
}

function projectName(cwd: string | undefined): string {
  // basename(cwd) — matches what Claude Code writes to claude-mem (verified in
  // ~/.claude-mem/claude-mem.db: sdk_sessions.project = "maltpanel"). Cross-agent
  // mem-search unifies on this exact key, so it must be basename, not the full path.
  const parts = (cwd ?? "").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "unknown";
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

// Fire /api/sessions/init exactly once per contentSessionId (observer awaits this).
function fireInit(project: string, prompt?: string): Promise<void> {
  if (breakerOpen()) return Promise.resolve();
  if (sid === undefined) newSid();
  if (initialized) return initPromise ?? Promise.resolve();
  initialized = true;
  const body = {
    contentSessionId: sid,
    project,
    prompt: prompt ?? "",
    platformSource: "omp",
  };
  // On any failure (network or HTTP) trip the breaker and release the init lock
  // so the next before_agent_start/tool_result can retry; observers awaiting this
  // promise proceed and the subsequent observation POST is gated by the breaker.
  initPromise = fetch(`${WORKER}/api/sessions/init`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
    .then(r => {
      if (!r.ok) throw new Error(`init ${r.status}`);
      onOk();
    })
    .catch(() => {
      onFail();
      initialized = false;
      initPromise = undefined;
    });
  return initPromise;
}

function post(path: string, body: unknown): Promise<void> {
  if (breakerOpen()) return Promise.resolve();
  return fetch(`${WORKER}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
    .then(r => {
      if (!r.ok) throw new Error(`${path} ${r.status}`);
      onOk();
    })
    .catch(() => onFail());
}

// ---------------------------------------------------------------------------
// Hook factory
// ---------------------------------------------------------------------------

export default function claudeMemBridge(pi: HookAPI): void {
  // session_start: mint the per-session contentSessionId. Init is deferred to
  // before_agent_start so we can capture the real user prompt (the worker records
  // and privacy-filters on it).
  pi.on("session_start", async () => {
    newSid();
  });

  // Compaction starts a new logical session in claude-mem too (matches Claude
  // Code's SessionStart clear/compact path): rotate id; the next
  // before_agent_start re-inits with the post-compact prompt.
  pi.on("session_compact", async () => {
    const id = sid;
    const pendingInit = initPromise;
    const previousAssistant = lastAssistant;

    if (id && initialized) {
      void (pendingInit ?? Promise.resolve()).then(() =>
        post("/api/sessions/summarize", {
          contentSessionId: id,
          last_assistant_message: previousAssistant,
          platformSource: "omp",
        })
      );
    }

    newSid();
  });

  // before_agent_start fires once per user prompt — init for the current session
  // id (exactly once via the `initialized` lock) and send the latest user prompt.
  // The prompt is a direct `event.prompt` string (BeforeAgentStartEvent in both
  // hooks/types.ts:281 and extensions/types.ts:705) — NOT in event.messages.
  // Never mint a new id here.
  pi.on("before_agent_start", async (event, ctx) => {
    fireInit(projectName(ctx?.cwd), event?.prompt);
  });

  // tool_result: the observation pipeline. Fire-and-forget; handler returns void
  // immediately. Awaits init, then POSTs the observation on a detached chain.
  pi.on("tool_result", async (event, ctx) => {
    const toolName = String(event?.toolName ?? "");
    if (!toolName || toolName.startsWith("memory_")) return; // avoid claude-mem recursion

    const response = textFromContent(event?.content);
    // isError rows are valuable — never skip them. tool_input is sent raw (the
    // worker serializes it once); tool_response is capped to MAX_LEN.
    const body: Record<string, unknown> = {
      contentSessionId: sid ?? newSid(),
      tool_name: toolName,
      tool_input: event?.input,
      tool_response: response.length > MAX_LEN ? response.slice(0, MAX_LEN) : response,
      platformSource: "omp",
    };
    if (ctx?.cwd) body.cwd = ctx.cwd;

    // Race-safe: wait for session init before the first observation lands.
    const dep = initPromise ?? fireInit(projectName(ctx?.cwd));
    void dep.then(() => post("/api/sessions/observations", body));
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
    const project = projectName(ctx?.cwd);
    const now = Date.now();

    if (!ctxCache || now - ctxCache.at > CTX_CACHE_MS) {
      try {
        const url = `${WORKER}/api/context/inject?projects=${encodeURIComponent(project)}`;
        const r = await fetch(url);
        if (!r.ok) throw new Error(`inject ${r.status}`);
        const md = (await r.text()) ?? "";
        onOk();
        // Only cache non-empty — an empty result means "no memory yet", caching it
        // would delay newly-arriving memory by CTX_CACHE_MS.
        if (md.trim()) ctxCache = { at: now, md };
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
  pi.on("session_shutdown", async () => {
    const id = sid;
    if (id) {
      void post("/api/sessions/summarize", {
        contentSessionId: id,
        last_assistant_message: lastAssistant,
        platformSource: "omp",
      });
    }
    sid = undefined;
    initialized = false;
    initPromise = undefined;
    ctxCache = null;
    lastAssistant = "";
  });
}