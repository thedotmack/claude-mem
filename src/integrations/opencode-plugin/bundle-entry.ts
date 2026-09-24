/**
 * Bundle entry point for the shipped OpenCode plugin.
 *
 * esbuild bundles this file to `dist/opencode-plugin/index.js`, which the
 * installer copies to `~/.config/opencode/plugins/claude-mem.js`.
 *
 * OpenCode's plugin loader iterates EVERY named export of the plugin file and
 * calls each one as a plugin factory, so the bundle must export ONLY the
 * plugin function. The contract constants (REAL_OPENCODE_EVENT_TYPES,
 * REGISTERED_OPENCODE_HOOKS) intentionally stay exported from ./index so the
 * contract test can assert on them, but they must not leak into the bundle —
 * otherwise opencode fails the whole plugin with
 * "Plugin export is not a function" (#4197).
 */
export { ClaudeMemPlugin, ClaudeMemPlugin as default } from "./index.js";
