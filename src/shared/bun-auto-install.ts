/**
 * Bun flag that turns off the runtime's auto-install. Every claude-mem process
 * that can load the media decoder (sharp) is started with it: the worker
 * daemon, its boot probe, the server daemon and the standalone transcript
 * watcher.
 *
 * Without it, Bun auto-installs any import it cannot find whenever no
 * `node_modules` sits in the script's directory or above it
 * (https://bun.sh/docs/runtime/autoimport). A plugin root without
 * `node_modules`, such as the Claude Code marketplace clone, then resolves
 * `import('sharp')` to `@img/sharp-wasm32`, and its first decode blocks Bun's
 * main thread forever in a WebAssembly atomic wait, so no timer, health probe
 * or deadline can fire (#5601). With the flag, a missing package fails at once
 * and the converter reports `decoder_unavailable`.
 *
 * Bun has no environment variable for this, only the CLI flag, and the flag
 * must come before the script path.
 */
export const BUN_NO_AUTO_INSTALL_FLAG = '--no-install';
