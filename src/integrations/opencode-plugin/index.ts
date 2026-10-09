/**
 * OpenCode plugin entry module.
 *
 * IMPORTANT: this module must export ONLY the default definition. OpenCode's
 * loader imports the entry module and treats every export as a plugin; a
 * non-default export fails the load. The event-contract constants and the
 * search-response parser therefore live in `contract.ts` (#3330).
 *
 * OpenCode ships two incompatible plugin contracts:
 *
 *   - V1 (1.3.4+): the default export is `{ id?, server }` and the host
 *     calls `server()`, then uses the hooks object it returns. Releases before
 *     1.3.4 call every export as a function and cannot load this object, so
 *     1.3.4 is the supported floor (the installer warns below it).
 *   - V2 (2.x): the default export must be `{ id, setup }` or `{ id, effect }`,
 *     validated by `Schema.Struct`. A V1 hooks object is rejected outright
 *     with "Plugin must export a default definition with an id and an effect or
 *     setup function" — the host does not translate one API into the other.
 *
 * One default export serves both, as the V2 migration guide prescribes: V1
 * reads `server`, V2 reads `id` + `setup` and ignores `server`.
 */

import { createV1Hooks, type OpenCodePluginContextV1 } from "./v1.js";
import { CLAUDE_MEM_PLUGIN_ID, setupV2, type OpenCodePluginContextV2 } from "./v2.js";

/** V1 entry point: OpenCode 1.3.4+ calls this and uses the hooks it returns. */
async function server(ctx: OpenCodePluginContextV1) {
  return createV1Hooks(ctx);
}

/** V2 entry point: registers every hook imperatively on the V2 context. */
async function setup(ctx: OpenCodePluginContextV2) {
  return setupV2(ctx);
}

export default { id: CLAUDE_MEM_PLUGIN_ID, server, setup };
