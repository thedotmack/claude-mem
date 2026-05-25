#!/usr/bin/env node
import { existsSync, readFileSync, statSync, mkdirSync, writeFileSync, openSync, closeSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { spawn } from 'child_process';

// Throttle window between detached auto-install attempts (install may still be
// running, or it keeps failing — do not respawn every session).
const DEPS_INSTALL_COOLDOWN_MS = 10 * 60 * 1000;

function dataDir() {
  return process.env.CLAUDE_MEM_DATA_DIR || join(homedir(), '.claude-mem');
}

// When the host auto-upgrades the plugin it creates a fresh version directory in the
// plugin cache WITHOUT node_modules, so the worker and MCP server cannot resolve their
// runtime deps (zod, ajv via @modelcontextprotocol/sdk, tree-sitter grammars, ...) and
// claude-mem silently stops working until the user happens to run the install command.
// Kick off a detached, throttled `bun install` to self-heal. This is a no-op when
// node_modules already exists, so healthy installs are completely unaffected — it only
// acts on the broken post-upgrade state.
function ensureRuntimeDeps(root) {
  try {
    if (existsSync(join(root, 'node_modules'))) return; // healthy — nothing to do
  } catch {
    return;
  }

  // Scope the cooldown marker to this version directory (not the global data dir),
  // so a second upgrade landing within the window still installs its own deps. `root`
  // is writable — `bun install` writes node_modules into it below.
  const marker = join(root, '.deps-install-attempted');
  try {
    if (existsSync(marker) && Date.now() - statSync(marker).mtimeMs < DEPS_INSTALL_COOLDOWN_MS) {
      return;
    }
  } catch {}

  try {
    writeFileSync(marker, String(Date.now()));
  } catch {
    // If we cannot record the throttle marker, skip rather than risk a respawn loop.
    return;
  }

  const dir = dataDir();
  let out = 'ignore';
  try {
    mkdirSync(dir, { recursive: true });
    out = openSync(join(dir, 'deps-install.log'), 'a');
  } catch {}

  try {
    // shell:true lets the host PATH resolve `bun` (bun.cmd on Windows, bun on Unix).
    // detached + unref keeps the Setup hook non-blocking; deps land within ~1 min.
    const child = spawn('bun install', {
      cwd: root,
      detached: true,
      shell: true,
      windowsHide: true,
      stdio: ['ignore', out, out],
    });
    child.on('error', () => {});
    child.unref();
    // Hand the log fd entirely to the detached child; the parent does not need it.
    if (typeof out === 'number') {
      try { closeSync(out); } catch {}
    }
  } catch {
    // best-effort; the upgrade hint below still explains the manual recovery command.
  }
}

function resolveRoot() {
  if (process.env.CLAUDE_PLUGIN_ROOT) {
    const root = process.env.CLAUDE_PLUGIN_ROOT;
    if (existsSync(join(root, 'package.json'))) return root;
  }
  try {
    const scriptDir = dirname(fileURLToPath(import.meta.url));
    const candidate = dirname(scriptDir);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
  } catch {}
  return null;
}

const ROOT = resolveRoot();
if (!ROOT) process.exit(0);

ensureRuntimeDeps(ROOT);

function emitUpgradeHint(message) {
  if (process.env.CLAUDE_MEM_CODEX_HOOK === '1') {
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: message,
      },
    }));
  } else {
    console.error(message);
  }
}

const LEGACY_VERSION_MARKER_RE =
  /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function readInstallMarkerVersion(markerPath) {
  const content = readFileSync(markerPath, 'utf-8');
  try {
    const marker = JSON.parse(content);
    return marker && typeof marker === 'object' && typeof marker.version === 'string'
      ? marker.version
      : null;
  } catch {
    const legacyVersion = content.trim();
    return LEGACY_VERSION_MARKER_RE.test(legacyVersion)
      ? legacyVersion.replace(/^v/i, '')
      : null;
  }
}

try {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
  const markerPath = join(ROOT, '.install-version');
  if (!existsSync(markerPath)) {
    emitUpgradeHint('claude-mem: runtime not yet set up - run: npx claude-mem@latest install');
    process.exit(0);
  }
  const markerVersion = readInstallMarkerVersion(markerPath);
  if (!markerVersion) {
    emitUpgradeHint('claude-mem: install marker unreadable - run: npx claude-mem@latest install');
  } else if (markerVersion !== pkg.version) {
    emitUpgradeHint(`claude-mem: upgraded to v${pkg.version} - run: npx claude-mem@latest install`);
  }
} catch {
  emitUpgradeHint('claude-mem: install marker unreadable - run: npx claude-mem@latest install');
}
process.exit(0);
