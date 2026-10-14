/**
 * Single source of truth for the on-PATH `claude-mem` launcher's protocol.
 * The launcher prints it for `--version`; the installer and the SessionStart
 * self-heal (plugin/scripts/ensure-launcher.cjs) compare against it to decide
 * whether the placed binary is current. Bump it only when the launcher's
 * contract with hooks.json or the installer changes.
 */
export const LAUNCHER_PROTOCOL = 1;
