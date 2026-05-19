// SPDX-License-Identifier: Apache-2.0
//
// claude-mem OpenCode plugin.
//
// OpenCode has its own plugin API (see https://opencode.ai/docs/plugins/) that
// is distinct from Claude Code's hook system. To keep memory capture symmetric
// between the two IDEs, we install this plugin into ~/.config/opencode/plugins/
// at install time. It listens to OpenCode lifecycle events and POSTs them to
// the same claude-mem server endpoints the Claude Code hooks talk to, so the
// observations from both IDEs land in the same Postgres tables.
//
// Event mapping (OpenCode → claude-mem hook contract):
//   session.created       → SessionStart  (worker auto-start signal + context)
//   message.updated       → UserPromptSubmit (when role=user, content present)
//   tool.execute.before   → PreToolUse  (privacy filter would go here)
//   tool.execute.after    → PostToolUse (observation capture)
//   session.idle          → Stop         (session-end summarize)
//
// Auth: reads ~/.claude-mem/settings.json for CLAUDE_MEM_SERVER_BETA_URL +
// CLAUDE_MEM_SERVER_BETA_API_KEY (server-beta runtime), or falls back to the
// worker HTTP URL when runtime=worker. The plugin makes a best-effort POST and
// never throws — OpenCode keeps running even if claude-mem is offline.

import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

// ─── Settings + endpoint resolution ─────────────────────────────────────────

function loadClaudeMemSettings() {
  const settingsPath = join(homedir(), '.claude-mem', 'settings.json');
  if (!existsSync(settingsPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    const flat = raw.env && typeof raw.env === 'object' ? raw.env : raw;
    return flat;
  } catch {
    return null;
  }
}

function resolveEndpoint() {
  const s = loadClaudeMemSettings();
  if (!s) return null;
  const runtime = (s.CLAUDE_MEM_RUNTIME || 'worker').trim();
  if (runtime === 'server-beta') {
    const url = (s.CLAUDE_MEM_SERVER_BETA_URL || '').trim();
    const apiKey = (s.CLAUDE_MEM_SERVER_BETA_API_KEY || '').trim();
    const projectId = (s.CLAUDE_MEM_SERVER_BETA_PROJECT_ID || '').trim();
    if (!url || !apiKey) return null;
    return { runtime, url, apiKey, projectId };
  }
  // Worker runtime — UID-derived port lives in CLAUDE_MEM_WORKER_PORT.
  const port = (s.CLAUDE_MEM_WORKER_PORT || '37703').trim();
  return { runtime: 'worker', url: `http://127.0.0.1:${port}`, apiKey: '', projectId: '' };
}

// Single endpoint resolution at plugin startup. We don't re-read settings on
// every event because the file rarely changes during a session and re-reading
// each tool call would be wasteful.
const ENDPOINT = resolveEndpoint();

// ─── HTTP post with timeout, never throws ──────────────────────────────────

async function postEvent(eventType, payload) {
  if (!ENDPOINT) return; // claude-mem not installed or settings missing.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (ENDPOINT.apiKey) headers.Authorization = `Bearer ${ENDPOINT.apiKey}`;
    await fetch(`${ENDPOINT.url}/v1/events`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        eventType,
        sourceType: 'hook',
        payload: {
          ...payload,
          // Tag observations with platformSource so the viewer's filters can
          // separate Claude Code memories from OpenCode memories.
          _platformSource: 'opencode',
        },
        ...(ENDPOINT.projectId ? { projectId: ENDPOINT.projectId } : {}),
      }),
      signal: controller.signal,
    });
  } catch {
    // Best effort; don't disrupt the OpenCode session if claude-mem is down.
  } finally {
    clearTimeout(timer);
  }
}

// ─── Plugin entry ──────────────────────────────────────────────────────────

export const ClaudeMemPlugin = async ({ project, directory, worktree }) => {
  if (!ENDPOINT) {
    // Settings missing — keep plugin silent. The user might be running
    // OpenCode without claude-mem installed yet.
    return {};
  }

  // Cache tool args from tool.execute.before so tool.execute.after can
  // include them in the PostToolUse event. OpenCode's plugin API only
  // surfaces args in the 'before' callback (the 'after' callback receives
  // { title, output, metadata }); without this cache, PostToolUse events
  // would always carry tool_input: undefined.
  // Keyed by sessionID + tool name; capacity-bounded to prevent unbounded
  // growth if a session triggers more 'before' than 'after' callbacks.
  const pendingArgs = new Map();
  const PENDING_CAP = 256;
  const cachePut = (key, value) => {
    if (pendingArgs.size >= PENDING_CAP) {
      const firstKey = pendingArgs.keys().next().value;
      if (firstKey !== undefined) pendingArgs.delete(firstKey);
    }
    pendingArgs.set(key, value);
  };
  const argsKey = (sessionID, tool) => `${sessionID ?? ''}::${tool ?? ''}`;

  // session.idle fires after every assistant turn, not just at session end.
  // We debounce so the server only sees one 'Stop' per N seconds of true
  // inactivity, preventing summarize-storms on multi-turn conversations.
  const STOP_DEBOUNCE_MS = 30_000;
  const idleTimers = new Map();
  const scheduleStop = (sessionID) => {
    const key = sessionID ?? 'unknown';
    const existing = idleTimers.get(key);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      idleTimers.delete(key);
      postEvent('Stop', { session_id: sessionID }).catch(() => {});
    }, STOP_DEBOUNCE_MS);
    if (typeof t.unref === 'function') t.unref();
    idleTimers.set(key, t);
  };
  if (!ENDPOINT) {
    // Settings missing — keep plugin silent. The user might be running
    // OpenCode without claude-mem installed yet.
    return {};
  }

  return {
    // SessionStart equivalent
    'session.created': async ({ event }) => {
      await postEvent('SessionStart', {
        session_id: event?.properties?.sessionID ?? event?.id ?? 'opencode-session',
        project_directory: directory,
        worktree,
        project_name: project?.id ?? project?.name,
      });
    },

    // UserPromptSubmit equivalent — fires on every assistant/user message update.
    // We only care about user role + non-empty text content.
    'message.updated': async ({ event }) => {
      const msg = event?.properties?.info ?? event?.info;
      if (!msg || msg.role !== 'user') return;
      const parts = Array.isArray(msg.parts) ? msg.parts : [];
      const text = parts
        .filter((p) => p?.type === 'text' && typeof p.text === 'string')
        .map((p) => p.text)
        .join('\n')
        .trim();
      if (!text) return;
      await postEvent('UserPromptSubmit', {
        session_id: msg.sessionID,
        prompt: text,
      });
    },

    // PreToolUse equivalent — would block on privacy violations; for now just
    // surface the event so the server can audit it.
    'tool.execute.before': async (input, output) => {
      // Cache args for the matching tool.execute.after callback.
      // The 'output' arg of 'before' is the tool args object.
      cachePut(argsKey(input?.sessionID, input?.tool), output);
      await postEvent('PreToolUse', {
        tool_name: input?.tool,
        tool_input: output,
        session_id: input?.sessionID,
      });
    },

    // PostToolUse equivalent — this is the main observation-capture event.
    'tool.execute.after': async (input, output) => {
      // OpenCode's 'after' callback receives { title, output, metadata } —
      // no args. Look up the args cached by 'before' for the same
      // sessionID + tool. Falls back to undefined if no matching 'before'
      // was seen (rare, e.g. plugin loaded mid-execution).
      const key = argsKey(input?.sessionID, input?.tool);
      const tool_input = pendingArgs.get(key);
      pendingArgs.delete(key);
      await postEvent('PostToolUse', {
        tool_name: input?.tool,
        tool_input,
        tool_response: output?.output,
        tool_metadata: output?.metadata,
        tool_title: output?.title,
        session_id: input?.sessionID,
      });
    },

    // Stop equivalent — fires when OpenCode goes idle (the LLM is done
    // responding, the user is reading). We use it to flush any pending session
    // summarization on the claude-mem server side.
    'session.idle': async ({ event }) => {
      // session.idle fires after every assistant turn. Debounce so the
      // Stop event only reaches the server after N seconds of true
      // inactivity — prevents summarize-storms on multi-turn chats.
      const sessionID = event?.properties?.sessionID ?? event?.id;
      scheduleStop(sessionID);
    },
  };
};
