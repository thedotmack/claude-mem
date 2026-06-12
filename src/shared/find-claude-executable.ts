/**
 * Shared Claude executable discovery and validation.
 *
 * Used by SDKAgent and KnowledgeAgent to locate a working Claude Code CLI.
 *
 * Every candidate is probed with the CAPABILITY PROBE — `--permission-mode
 * dontAsk --version` — not just `--version`. claude-mem passes
 * `--permission-mode dontAsk` on every Observer/KnowledgeAgent spawn (see
 * buildHardenedSdkOptions in src/sdk/hardened-options.ts), and CLIs older than
 * the 2.1.x line reject it with "argument 'dontAsk' is invalid" and exit 1
 * before doing any work. A binary that answers `--version` but fails the probe
 * would die instantly at SDK spawn time, producing the silent
 * "healthy worker, zero observations" failure mode (#2782 family; previously
 * #1857/#2049 with --setting-sources, #1866, #2142). The probe makes no API
 * call: a capable CLI short-circuits on --version (~150 ms), an incompatible
 * one errors at flag parsing.
 *
 * When several candidates are installed (PATH shadowing, abandoned npm-global
 * installs next to the auto-updating native installer), the NEWEST capable
 * version wins — PATH order is only a tie-breaker.
 *
 * Closes #2222 (desktop-app detection), hardens against stale-CLI selection.
 */

import { execSync, execFileSync } from 'child_process';
import { existsSync, realpathSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { SettingsDefaultsManager } from './SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from './paths.js';
import { logger, type Component } from '../utils/logger.js';

/**
 * How long to wait for a probe (`--version` / capability) before giving up (ms).
 *
 * The native `claude` binary is large (~225 MB) and a cold start on Windows
 * (first run after install, antivirus real-time scan) can take several seconds.
 * A too-tight timeout makes a perfectly good CLI look unusable, which on a
 * Windows npm-global path then surfaces as a misleading "desktop app" error.
 * Warm probes return in ~0.5 s, so 10 s only bites on cold starts.
 */
const VERSION_CHECK_TIMEOUT_MS = 10_000;

/**
 * The flags every Observer/KnowledgeAgent spawn passes that old CLIs reject.
 * MUST stay in sync with buildHardenedSdkOptions (src/sdk/hardened-options.ts):
 * if a new always-on SDK option maps to a CLI flag old binaries don't know,
 * add it here so the resolver rejects those binaries up front instead of
 * letting every spawn die with exit 1.
 *
 * `--version` terminates the invocation without any API call once the flags
 * before it parse cleanly.
 */
export const CAPABILITY_PROBE_ARGS = ['--permission-mode', 'dontAsk', '--version'] as const;

/**
 * Successful resolutions are cached briefly: findClaudeExecutable() runs once
 * per SDK query, and each cold resolution costs one subprocess spawn per
 * installed candidate. Failures are never cached, so a user who updates their
 * CLI is picked up on the next observation without a worker restart.
 */
const RESOLUTION_CACHE_TTL_MS = 15 * 60_000;

interface CachedResolution {
  path: string;
  version: string;
  expiresAtMs: number;
}

let cachedResolution: CachedResolution | null = null;

/** Test hook: clear the resolution cache between cases. */
export function resetClaudeExecutableCache(): void {
  cachedResolution = null;
}

/**
 * Seam for unit tests — probing and discovery shell out to real binaries,
 * which tests replace by reassigning these members (no module mocking).
 */
export const _internals = {
  execSync,
  execFileSync,
  existsSync,
  realpathSync,
  homedir,
  platform: (): NodeJS.Platform => process.platform,
  loadSettings: () => SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH),
};

/**
 * Returns true if the path looks like a Windows desktop-app installation
 * (AppData or Program Files) rather than a CLI installed via npm/volta/etc.
 */
function looksLikeDesktopAppPath(candidatePath: string): boolean {
  const normalized = candidatePath.replace(/\\/g, '/').toLowerCase();
  // npm / Node CLI installs on Windows live under %AppData%\Roaming\npm\node_modules\…
  // — the exact location `npm install -g @anthropic-ai/claude-code` uses. Those contain
  // "appdata" but are NOT the desktop app; treating them as such tells users to reinstall
  // the CLI they already have. Bail out for any npm/node_modules path first. (See #2723.)
  if (normalized.includes('/node_modules/') || normalized.includes('/npm/')) {
    return false;
  }
  return (
    normalized.includes('appdata') ||
    normalized.includes('program files') ||
    normalized.includes('program files (x86)')
  );
}

type ProbeResult =
  /** Runs and accepts every flag claude-mem passes. */
  | { kind: 'capable'; version: string }
  /** Runs (`--version` works) but rejects the capability flags — too old. */
  | { kind: 'incompatible'; version: string; detail: string }
  /** Does not run at all (desktop app, missing interpreter, corrupt install). */
  | { kind: 'broken'; detail: string };

/**
 * Run `<candidate> <args>` and return trimmed stdout, or null on any failure.
 *
 * Uses execFileSync (not execSync) so the candidate path is passed as a
 * separate argument and never interpreted by a shell. This prevents shell
 * injection if the path contains characters like `"`, `;`, `&` — reachable
 * on Windows via a crafted CLAUDE_CODE_PATH in settings.json.
 */
function runProbe(candidate: string, args: readonly string[]): { stdout: string } | { error: string } {
  try {
    const stdout = _internals.execFileSync(candidate, [...args], {
      encoding: 'utf8',
      timeout: VERSION_CHECK_TIMEOUT_MS,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    return { stdout };
  } catch (error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    const firstLine = String(stderr ?? (error instanceof Error ? error.message : error))
      .split('\n')[0]
      .trim();
    return { error: firstLine || 'probe failed' };
  }
}

/**
 * Probe one candidate. A capable CLI is classified in a single spawn
 * (capability flags + --version). Only when that probe fails does a second
 * plain `--version` spawn run, to split "runs but too old" from "doesn't run
 * at all" without pattern-matching stderr wording — so the two-spawn cost is
 * paid only for stale/broken installs, and the result is cached.
 */
function probeCandidate(candidate: string): ProbeResult {
  const capability = runProbe(candidate, CAPABILITY_PROBE_ARGS);
  if ('stdout' in capability && capability.stdout) {
    return { kind: 'capable', version: capability.stdout };
  }

  // Capability probe failed. Distinguish "runs but rejects our flags" (old
  // CLI) from "doesn't run at all" (desktop app, broken install) via a plain
  // --version. Any error wording ("invalid", "unknown option", localized
  // variants) classifies the same way, so no stderr pattern-matching.
  const plain = runProbe(candidate, ['--version']);
  if ('stdout' in plain && plain.stdout) {
    const detail = 'error' in capability ? capability.error : 'rejects capability flags';
    return { kind: 'incompatible', version: plain.stdout, detail };
  }

  const detail = 'error' in capability ? capability.error : 'failed --version check';
  return { kind: 'broken', detail };
}

/** Parse "2.1.176 (Claude Code)" → [2, 1, 176]; unparseable sorts lowest. */
function parseVersionKey(version: string): [number, number, number] {
  const match = version.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return [0, 0, 0];
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersionKeysDesc(a: [number, number, number], b: [number, number, number]): number {
  return b[0] - a[0] || b[1] - a[1] || b[2] - a[2];
}

/**
 * All places a Claude CLI might live, best-effort and deduplicated:
 *   - every PATH match (`which -a` / `where`), not just the first — a stale
 *     binary earlier in PATH must not hide a current one later in PATH
 *   - the native installer's symlink (~/.local/bin/claude) and the legacy
 *     local-install location (~/.claude/local/claude), which may not be on the
 *     worker's PATH at all depending on how the daemon was spawned
 *
 * Order is preserved (PATH order first) and only used to break version ties.
 */
function discoverCandidates(): string[] {
  const candidates: string[] = [];

  if (_internals.platform() === 'win32') {
    // claude.cmd first: spawning the .cmd wrapper avoids spawn issues with
    // spaces in the .exe path (long-standing Windows preference).
    for (const command of ['where claude.cmd', 'where claude']) {
      try {
        const output = _internals.execSync(command, {
          encoding: 'utf8',
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        candidates.push(...output.split('\n').map((line) => line.trim()).filter(Boolean));
      } catch {
        // Not found via this lookup — try the next discovery source.
      }
    }
  } else {
    try {
      const output = _internals.execSync('which -a claude', {
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      candidates.push(...output.split('\n').map((line) => line.trim()).filter(Boolean));
    } catch {
      // which -a found nothing — known install locations below still apply.
    }
    for (const knownPath of [
      join(_internals.homedir(), '.local', 'bin', 'claude'),
      join(_internals.homedir(), '.claude', 'local', 'claude'),
    ]) {
      if (_internals.existsSync(knownPath)) {
        candidates.push(knownPath);
      }
    }
  }

  // Dedupe literal paths, then symlink targets (PATH often repeats dirs, and
  // several entries may point at the same real binary).
  const seenPaths = new Set<string>();
  const seenRealPaths = new Set<string>();
  const deduped: string[] = [];
  for (const candidate of candidates) {
    if (seenPaths.has(candidate)) continue;
    seenPaths.add(candidate);
    let realPath = candidate;
    try {
      realPath = _internals.realpathSync(candidate);
    } catch {
      // Dangling symlink or permission issue — keep the literal path; the
      // probe will classify it as broken.
    }
    if (seenRealPaths.has(realPath)) continue;
    seenRealPaths.add(realPath);
    deduped.push(candidate);
  }
  return deduped;
}

function updateInstructions(): string {
  return (
    'Update it (`claude update`, or `npm install -g @anthropic-ai/claude-code@latest` for npm installs), ' +
    'remove stale duplicate installs, or set CLAUDE_CODE_PATH in ~/.claude-mem/settings.json to a current CLI.'
  );
}

/**
 * Find and validate a Claude Code CLI executable.
 *
 * Discovery order:
 *   1. `CLAUDE_CODE_PATH` from settings.json (explicit user override — wins,
 *      but fails loud if it is too old rather than dying silently at spawn)
 *   2. Every `claude` on PATH plus known install locations, probed for
 *      capability; the newest capable version is returned
 *
 * @param logComponent  Logger {@link Component} tag (e.g. 'SDK', 'WORKER')
 * @throws {Error} when no Claude CLI compatible with claude-mem can be found
 */
export function findClaudeExecutable(logComponent: Component = 'SDK'): string {
  if (cachedResolution && cachedResolution.expiresAtMs > Date.now() && _internals.existsSync(cachedResolution.path)) {
    return cachedResolution.path;
  }
  cachedResolution = null;

  const settings = _internals.loadSettings();

  // --- 1. Explicit configured path ----------------------------------------
  if (settings.CLAUDE_CODE_PATH) {
    if (!_internals.existsSync(settings.CLAUDE_CODE_PATH)) {
      throw new Error(
        `CLAUDE_CODE_PATH is set to "${settings.CLAUDE_CODE_PATH}" but the file does not exist.`
      );
    }

    const probe = probeCandidate(settings.CLAUDE_CODE_PATH);
    if (probe.kind === 'capable') {
      logger.info(logComponent, `Using configured CLAUDE_CODE_PATH: ${settings.CLAUDE_CODE_PATH} (${probe.version})`);
      cachedResolution = {
        path: settings.CLAUDE_CODE_PATH,
        version: probe.version,
        expiresAtMs: Date.now() + RESOLUTION_CACHE_TTL_MS,
      };
      return settings.CLAUDE_CODE_PATH;
    }
    if (probe.kind === 'incompatible') {
      throw new Error(
        `CLAUDE_CODE_PATH is set to "${settings.CLAUDE_CODE_PATH}" (${probe.version}) but that CLI is too old for claude-mem — ` +
        `it rejects flags every memory agent spawn requires (${probe.detail}). ${updateInstructions()}`
      );
    }
    if (looksLikeDesktopAppPath(settings.CLAUDE_CODE_PATH)) {
      throw new Error(
        `Found desktop app at "${settings.CLAUDE_CODE_PATH}" but it doesn't support headless mode. ` +
        `Install Claude Code CLI: npm install -g @anthropic-ai/claude-code`
      );
    }
    throw new Error(
      `CLAUDE_CODE_PATH is set to "${settings.CLAUDE_CODE_PATH}" but it failed the --version check (${probe.detail}). ` +
      `Ensure this is a working Claude Code CLI binary.`
    );
  }

  // --- 2. Probe every discovered candidate ---------------------------------
  const capable: Array<{ path: string; version: string; key: [number, number, number]; order: number }> = [];
  const incompatible: Array<{ path: string; version: string; detail: string }> = [];

  const candidates = discoverCandidates();
  for (let order = 0; order < candidates.length; order++) {
    const candidate = candidates[order];
    const probe = probeCandidate(candidate);

    if (probe.kind === 'capable') {
      capable.push({ path: candidate, version: probe.version, key: parseVersionKey(probe.version), order });
      continue;
    }

    if (probe.kind === 'incompatible') {
      incompatible.push({ path: candidate, version: probe.version, detail: probe.detail });
      logger.warn(
        logComponent,
        `Skipping "${candidate}" (${probe.version}) — too old for claude-mem: ${probe.detail}`
      );
      continue;
    }

    if (looksLikeDesktopAppPath(candidate)) {
      logger.warn(
        logComponent,
        `Skipping desktop app at "${candidate}" — it doesn't support headless mode. ` +
        `Install Claude Code CLI: npm install -g @anthropic-ai/claude-code`
      );
    } else {
      logger.warn(logComponent, `Skipping "${candidate}" — failed --version check (${probe.detail})`);
    }
  }

  if (capable.length > 0) {
    capable.sort((a, b) => compareVersionKeysDesc(a.key, b.key) || a.order - b.order);
    const winner = capable[0];
    // INFO, not DEBUG: when observations silently stop, which binary the
    // worker picked is the first question — make it answerable from default logs.
    logger.info(logComponent, `Using Claude CLI v${winner.version} at ${winner.path}`, {
      candidatesProbed: candidates.length,
      skippedTooOld: incompatible.length,
    });
    cachedResolution = {
      path: winner.path,
      version: winner.version,
      expiresAtMs: Date.now() + RESOLUTION_CACHE_TTL_MS,
    };
    return winner.path;
  }

  if (incompatible.length > 0) {
    const lines = incompatible
      .map((entry) => `  - ${entry.path} (${entry.version}) — ${entry.detail}`)
      .join('\n');
    throw new Error(
      `Every Claude CLI found is too old for claude-mem (each rejects flags the memory agent passes on every spawn):\n` +
      `${lines}\n${updateInstructions()}`
    );
  }

  throw new Error(
    'Claude executable not found. Please either:\n' +
    '1. Add "claude" to your system PATH, or\n' +
    '2. Set CLAUDE_CODE_PATH in ~/.claude-mem/settings.json'
  );
}
