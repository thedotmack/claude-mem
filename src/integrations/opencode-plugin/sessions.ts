import { basename } from "node:path";
import { workerPostFireAndForget } from "./worker.js";

/**
 * OpenCode session → claude-mem content session mapping, shared by the V1
 * (`server`) and V2 (`setup`) plugin entry points.
 */

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

/** Register a user prompt for the session (the worker counts one prompt per init). */
export function initSession(openCodeSessionId: string, projectName: string, prompt: string): string {
  const contentSessionId = getOrCreateContentSessionId(openCodeSessionId);
  initializedSessionIds.add(openCodeSessionId);
  workerPostFireAndForget("/api/sessions/init", {
    contentSessionId,
    project: projectName,
    prompt,
  });
  return contentSessionId;
}

/**
 * Sessions normally initialize from their user prompt, but the plugin can load
 * mid-session (e.g. after an OpenCode restart), so any activity for an unseen
 * session initializes it first. This guarantees a session row exists before
 * observations arrive.
 */
export function ensureSessionInitialized(openCodeSessionId: string, projectName: string): string {
  if (initializedSessionIds.has(openCodeSessionId)) {
    return getOrCreateContentSessionId(openCodeSessionId);
  }
  return initSession(openCodeSessionId, projectName, "");
}

export function forgetSession(openCodeSessionId: string): void {
  contentSessionIdsByOpenCodeSessionId.delete(openCodeSessionId);
  initializedSessionIds.delete(openCodeSessionId);
}

/**
 * Name sessions like the Claude Code hooks do: the git root's basename, else
 * the working directory's basename (#4275). OpenCode reports a `/` root
 * outside a repository.
 */
export function resolveProjectName(root: string | undefined, directory: string | undefined): string {
  const base = root && root !== "/" ? root : directory;
  return (base && basename(base)) || "opencode";
}
