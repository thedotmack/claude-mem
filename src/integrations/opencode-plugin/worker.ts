import { join } from "node:path";
import { SettingsDefaultsManager } from "../../shared/SettingsDefaultsManager.js";
import { normalizePlatformSource } from "../../shared/platform-source.js";
// Dependency-free, so it stays bundle-safe for the plugin (no worker-only imports).
import { isConnectionRefusedError } from "../../shared/connection-errors.js";

/**
 * Worker HTTP client for the OpenCode plugin. Kept separate from index.ts so the
 * bundled plugin module exports nothing but its default V2 plugin definition.
 */

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

// A refused connection means the worker is simply not running and must stay
// quiet. isConnectionRefusedError recognizes Bun's and undici's shapes, which a
// message.includes('ECONNREFUSED') check misses (OpenCode hosts plugins under Bun).
export function workerPostFireAndForget(
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
    if (!isConnectionRefusedError(error)) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[claude-mem] Worker POST ${path} failed: ${message}`);
    }
  });
}

export async function workerGetText(path: string): Promise<string | null> {
  try {
    const response = await fetch(`${WORKER_BASE_URL}${path}`, { headers: JSON_HEADERS });
    if (!response.ok) {
      console.warn(`[claude-mem] Worker GET ${path} returned ${response.status}`);
      return null;
    }
    return await response.text();
  } catch (error: unknown) {
    if (!isConnectionRefusedError(error)) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[claude-mem] Worker GET ${path} failed: ${message}`);
    }
    return null;
  }
}

export function truncate(text: string): string {
  return text.length > MAX_TOOL_RESPONSE_LENGTH
    ? text.slice(0, MAX_TOOL_RESPONSE_LENGTH)
    : text;
}

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
