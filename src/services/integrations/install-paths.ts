/**
 * install-paths.ts — Rule B: installer-managed absolute-path bake helpers.
 *
 * See `CLAUDE.md` → "Spawn-Contract Resolution". Per-IDE config files that
 * claude-mem's own installers write (Cursor, Gemini, Windsurf, and the
 * MCP-only IDEs: Copilot CLI, Antigravity, Goose, Roo, Warp) MUST bake
 * absolute paths — those hosts perform NO `${CLAUDE_PLUGIN_ROOT}` shell
 * substitution on the `command`/`args` fields they exec. This module is the
 * single source of truth for resolving those absolute paths so each installer
 * does not re-implement (subtly divergent) probing logic.
 *
 * This is install-time resolution only. Runtime resolution (Rule C) lives in
 * `plugin/scripts/bun-runner.js` / `plugin/scripts/version-check.js` and is the
 * safety net behind both Rule A (host-managed shell templates) and Rule B.
 */
import path from 'path';
import { homedir } from 'os';
import { existsSync } from 'fs';
import { MARKETPLACE_ROOT } from '../../shared/paths.js';

function firstExisting(candidates: string[]): string | null {
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Absolute path to the installed plugin root (the directory that contains
 * `scripts/`). Probes, in order: CLAUDE_PLUGIN_ROOT env, PLUGIN_ROOT env,
 * the Claude marketplace cache root, then the current working directory's
 * `plugin/` (repo/dev checkout) and the cwd itself.
 *
 * Returns null when no candidate contains `scripts/` — callers surface a
 * "could not find" install error.
 */
export function getPluginRootAbsolutePath(): string | null {
  const candidates = [
    process.env.CLAUDE_PLUGIN_ROOT,
    process.env.PLUGIN_ROOT,
    path.join(MARKETPLACE_ROOT, 'plugin'),
    path.join(process.cwd(), 'plugin'),
    process.cwd(),
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, 'scripts'))) {
      return candidate;
    }
  }
  return null;
}

function resolvePluginScript(scriptName: string): string | null {
  const root = getPluginRootAbsolutePath();
  const candidates = [
    root ? path.join(root, 'scripts', scriptName) : '',
    path.join(MARKETPLACE_ROOT, 'plugin', 'scripts', scriptName),
    path.join(process.cwd(), 'plugin', 'scripts', scriptName),
  ];
  return firstExisting(candidates);
}

/** Absolute path to the bundled MCP server (`mcp-server.cjs`), or null. */
export function getMcpServerAbsolutePath(): string | null {
  return resolvePluginScript('mcp-server.cjs');
}

/** Absolute path to the bundled worker service (`worker-service.cjs`), or null. */
export function getWorkerServiceAbsolutePath(): string | null {
  return resolvePluginScript('worker-service.cjs');
}

/** Absolute path to the version-check script (`version-check.js`), or null. */
export function getVersionCheckAbsolutePath(): string | null {
  return resolvePluginScript('version-check.js');
}

/**
 * Absolute path to a Bun runtime. Falls back to the bare `bun` name (resolved
 * via PATH at exec time) when no known install location exists.
 */
export function getBunAbsolutePath(): string {
  const candidates = [
    path.join(homedir(), '.bun', 'bin', 'bun'),
    '/usr/local/bin/bun',
    '/usr/bin/bun',
    ...(process.platform === 'win32'
      ? [
          path.join(homedir(), '.bun', 'bin', 'bun.exe'),
          path.join(process.env.LOCALAPPDATA || '', 'bun', 'bun.exe'),
        ]
      : []),
  ];

  return firstExisting(candidates) ?? 'bun';
}

/**
 * Absolute path to the Node runtime launching this installer. MCP-only
 * integrations register `node <mcp-server.cjs>`; baking `process.execPath`
 * guarantees the same Node that ran the installer is the one that launches the
 * server.
 */
export function getNodeAbsolutePath(): string {
  return process.execPath;
}
