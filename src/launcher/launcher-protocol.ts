/**
 * Single source of truth for the on-PATH `claude-mem` launcher's protocol.
 * The launcher prints it for `--version`; the installer and the SessionStart
 * self-heal (plugin/scripts/ensure-launcher.cjs) compare against it to decide
 * whether the placed binary is current. Bump it when the launcher's contract
 * with hooks.json or the installer changes, or when a launcher fix must reach
 * binaries already on PATH: an older protocol is the only signal that makes the
 * installer and the self-heal recompile an existing launcher.
 *
 * History:
 * 1 — initial on-PATH launcher.
 * 2 — Bun discovery fixes: no re-exec loop on Bun < 1.2.16 (#4933, #4940) and
 *     Windows checks explicit/known Bun paths before a bounded where.exe
 *     lookup (#4934, #4966).
 */
export const LAUNCHER_PROTOCOL = 2;
