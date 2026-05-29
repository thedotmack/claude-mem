/**
 * OpenCode plugin build entry.
 *
 * OpenCode's plugin loader (v1.15.x) iterates over EVERY export of the plugin
 * module and requires each one to be a function (or an object exposing a
 * `server` function) — it throws `TypeError("Plugin export is not a function")`
 * on the first export that is not, and aborts loading the entire plugin.
 *
 * Therefore this build entry must export ONLY the plugin factory. All the
 * implementation — including the named exports the contract test relies on
 * (`ClaudeMemPlugin`, `parseSearchResponse`, `REAL_OPENCODE_EVENT_TYPES`,
 * `REGISTERED_OPENCODE_HOOKS`) — lives in ./plugin and is imported there, NOT
 * re-exported here. Re-exporting the non-function constants from this entry is
 * exactly what broke real OpenCode loading (capture silently did nothing).
 *
 * The `tests/integrations/opencode-plugin-contract.test.ts` "single function
 * export" case guards this invariant by asserting every export of THIS module
 * is a function.
 */
export { default } from "./plugin.js";
