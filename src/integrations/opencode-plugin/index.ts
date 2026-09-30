import { serverV1 } from "./v1.js";
import { setupV2 } from "./v2.js";

/**
 * OpenCode plugin entry — one module that both OpenCode generations accept.
 *
 * - OpenCode 2.x decodes the default export as `{ id, effect }` or
 *   `{ id, setup }` (packages/core/src/plugin/module.ts @ v2.0.20) and ignores
 *   other keys, so it calls `setup`.
 * - OpenCode 1.18 reads a default `{ id, server }` (readV1Plugin in
 *   packages/opencode/src/plugin/shared.ts @ v1.18.33) and ignores other keys,
 *   so it calls `server`. Earlier 1.x loaders walk every export and accept an
 *   object with a `server` function.
 *
 * This module must export nothing but `default`: the 1.x legacy loader rejects
 * any export that is not a function or `{ server }` ("Plugin export is not a
 * function", #4197), and there must be no `effect` key, which would switch
 * OpenCode 2 to its Effect plugin path.
 */
const ClaudeMemPlugin = {
  id: "claude-mem",
  server: serverV1,
  setup: setupV2,
};

export default ClaudeMemPlugin;
