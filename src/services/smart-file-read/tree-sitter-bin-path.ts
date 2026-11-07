// Where the tree-sitter CLI lives, and whether it is there at all. Dependency-free
// on purpose (like language-map.ts): the PreToolUse file-context hook asks "can
// smart_outline run here?" through it without pulling the tree-sitter parser
// into the worker bundle. The hook and the MCP server resolve from the same
// plugin root, so the hook's answer matches what the parser will find.
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { treeSitterBinaryName } from "./tree-sitter-bin-name.js";

const _require = typeof __filename !== 'undefined'
  ? createRequire(__filename)
  : createRequire(import.meta.url);

// tree-sitter-cli installs `tree-sitter.exe` on Windows, not a bare `tree-sitter`
// (see ChromaMcpManager.resolveUvxCommand for the same platform-suffix idiom).
// Without the `.exe` suffix the existsSync check below always misses on Windows,
// silently falling through to a bare `tree-sitter` that may not be on PATH —
// smart file parsing then returns empty results with no error.
//
// Callers resolve per use and never cache the answer: the worker provisions the
// executable in the background (tree-sitter-cli-provision.ts), and a process
// that kept the bare-name fallback could not parse for its lifetime while the
// File Read Gate, which checks on every Read, already sends Claude here.
export function resolveTreeSitterBinPath(platform: NodeJS.Platform = process.platform): string {
  const binName = treeSitterBinaryName(platform);

  let packageLocalBinPath: string | undefined;
  try {
    const pkgPath = _require.resolve("tree-sitter-cli/package.json");
    packageLocalBinPath = join(dirname(pkgPath), binName);
  } catch {
    // [ANTI-PATTERN IGNORED]: tree-sitter-cli not in node_modules is expected; falls back to PATH
  }

  if (packageLocalBinPath === undefined) return binName;
  // Probing only means something for the platform we are running on; the
  // platform parameter exists so tests can check other platforms' names.
  if (platform !== process.platform) return existsSync(packageLocalBinPath) ? packageLocalBinPath : binName;
  return resolveTreeSitterBinPathFor(packageLocalBinPath, process.env.PATH ?? '');
}

/**
 * The binary the parser runs, given the path where a tree-sitter-cli package
 * keeps its executable: the bare name (a PATH lookup) when that file does not
 * exist, otherwise pickTreeSitterBinPath's choice. resolveTreeSitterBinPath
 * uses it for this process's own package; `npx claude-mem doctor` uses it for
 * the plugin root the worker runs from, so its answer matches the runtime.
 */
export function resolveTreeSitterBinPathFor(packageLocalBinPath: string, searchPath: string): string {
  const binName = treeSitterBinaryName();
  if (!existsSync(packageLocalBinPath)) return binName;
  return pickTreeSitterBinPath(packageLocalBinPath, binName, searchPath);
}

/**
 * Which binary should the parser run when tree-sitter-cli has one on disk?
 * The package-local binary, unless the OS cannot run it and a tree-sitter on
 * PATH can (#4758: the 0.26.9 release asset needs GLIBC_2.39, so on Ubuntu
 * 22.04 / Debian 12 / RHEL 9 it is present but every spawn fails, and a
 * working build the user installed on PATH would otherwise never be used).
 * Both probes are cached per path + mtime + mode (see loadCheckFor), so this
 * stays cheap on the per-parse and per-Read paths, and a binary the worker
 * provisions later (new mtime) is re-probed.
 *
 * Exported for tests; callers use resolveTreeSitterBinPath.
 */
export function pickTreeSitterBinPath(
  packageLocalBinPath: string,
  binName: string,
  searchPath: string,
): string {
  if (loadCheckFor(packageLocalBinPath).loadable) return packageLocalBinPath;
  const onPath = resolveOnPath(binName, searchPath);
  if (onPath !== undefined && onPath !== packageLocalBinPath && loadCheckFor(onPath).loadable) {
    return onPath;
  }
  // Nothing runs: keep the package-local path so checkTreeSitterCliLoadable
  // reports why that binary fails, which is the actionable reason.
  return packageLocalBinPath;
}

/**
 * Can smart_outline / smart_unfold parse anything here? True when the CLI
 * resolves to an existing file inside tree-sitter-cli, or when its bare name is
 * in a PATH directory (where the parser's execFileSync would find it). An
 * install whose tree-sitter-cli package never downloaded its binary answers
 * false, and every smart_outline call there reports "Could not parse".
 *
 * The parameters exist for tests; callers pass none.
 */
export function isTreeSitterCliAvailable(
  resolvedBinPath: string = resolveTreeSitterBinPath(),
  searchPath: string = process.env.PATH ?? '',
): boolean {
  if (isAbsolute(resolvedBinPath)) return existsSync(resolvedBinPath);
  return searchPath
    .split(delimiter)
    .some(directory => directory !== '' && existsSync(join(directory, resolvedBinPath)));
}

/** The fix when no tree-sitter release build runs here (#4858: musl). */
export const TREE_SITTER_CLI_PATH_WORKAROUND = "put a tree-sitter 0.26 or newer build that runs on this system on PATH";

const TREE_SITTER_LOAD_PROBE_TIMEOUT_MS = 2_000;
const TREE_SITTER_VERSION_OUTPUT = /^tree-sitter (\d+)\.(\d+)\.(\d+)(?:\s|$)/;

export interface TreeSitterCliLoadCheck {
  /** A tree-sitter CLI binary file was found (it may still not run). */
  present: boolean;
  /** The binary executed and answered `--version` as a compatible tree-sitter. */
  loadable: boolean;
  /** Why the binary is absent or not loadable; undefined when loadable. */
  reason?: string;
}

interface CachedLoadCheck {
  mtimeMs: number;
  mode: number;
  check: TreeSitterCliLoadCheck;
}

// The --version probe spawns a process, so it runs at most once per binary
// state: results are cached per process keyed by resolved path + mtime + mode.
// A worker provisioning a replacement (new mtime) or a `chmod +x` repairing
// permissions (new mode) is re-probed, while the hot path pays one statSync +
// Map lookup. Note the cache is per process: each PreToolUse hook invocation
// is a fresh process, so a qualifying Read pays one ~millisecond spawn; the
// 2s probe timeout above bounds the worst case of a stalled binary.
const loadCheckCache = new Map<string, CachedLoadCheck>();

/**
 * True when the OS would execute this file. On Windows there is no POSIX exec
 * bit, so existence decides and CreateProcess reports the real failure.
 */
export function isExecutableFile(filePath: string): boolean {
  if (process.platform === 'win32') return true;
  try {
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function firstStderrLine(error: unknown): string {
  const stderr = (error as { stderr?: unknown } | null)?.stderr;
  const text = typeof stderr === "string" ? stderr
    : stderr instanceof Buffer ? stderr.toString("utf-8")
    : "";
  return text.trim().split("\n")[0] ?? "";
}

function probeTreeSitterCliLoadable(absoluteBinPath: string): TreeSitterCliLoadCheck {
  try {
    const stdout = execFileSync(absoluteBinPath, ["--version"], {
      encoding: "utf-8",
      timeout: TREE_SITTER_LOAD_PROBE_TIMEOUT_MS,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const version = TREE_SITTER_VERSION_OUTPUT.exec(stdout.trim());
    if (version) {
      // parser.ts uses query --grammar-path / --lib-path / --lang-name,
      // which first appeared in tree-sitter 0.26.0.
      if (Number(version[1]) === 0 && Number(version[2]) < 26) {
        return {
          present: true,
          loadable: false,
          reason: `tree-sitter CLI at ${absoluteBinPath} is ${version[1]}.${version[2]}.${version[3]}; smart parsing requires tree-sitter >= 0.26.0`,
        };
      }
      return { present: true, loadable: true };
    }
    return {
      present: true,
      loadable: false,
      reason: `tree-sitter CLI at ${absoluteBinPath} ran but did not answer --version as tree-sitter`,
    };
  } catch (error) {
    const detail = firstStderrLine(error)
      || (error instanceof Error ? error.message.split("\n")[0] : String(error));
    return {
      present: true,
      loadable: false,
      reason: `tree-sitter CLI at ${absoluteBinPath} could not be executed`
        + (detail ? `: ${detail}` : ""),
    };
  }
}

function resolveOnPath(binName: string, searchPath: string): string | undefined {
  for (const directory of searchPath.split(delimiter)) {
    if (directory === '') continue;
    const candidate = join(directory, binName);
    try {
      // Mirror the OS's own PATH lookup: a non-executable file does not shadow
      // a working executable later in PATH (the parser's bare-name spawn skips
      // it the same way).
      if (statSync(candidate).isFile() && isExecutableFile(candidate)) return resolve(candidate);
    } catch {
      // Not in this directory; keep looking.
    }
  }
  return undefined;
}

/**
 * Does the resolved tree-sitter CLI actually run here? isTreeSitterCliAvailable
 * answers "is the file there"; this answers "can the smart tools parse with
 * it". A binary can be present but unloadable — e.g. tree-sitter-cli 0.26.9
 * links against GLIBC_2.39, so on Ubuntu 22.04 (glibc 2.35), Debian 12 or
 * RHEL 9 it exists yet every spawn fails (#4758). Callers should treat
 * present-but-not-loadable as "smart parsing unavailable" and say why
 * (reason) instead of the misleading "unsupported language" fallbacks.
 *
 * Synchronous so the PreToolUse File Read Gate can use it per Read. The --version
 * probe runs at most once per binary state (path + mtime + mode), so a
 * provisioned replacement or a `chmod +x` repair is re-probed while the hot
 * path pays one statSync + Map lookup; each hook invocation is a fresh
 * process, so a qualifying Read pays one short spawn, bounded by the 2s probe
 * timeout.
 * The parameters exist for tests; callers pass none.
 */
export function checkTreeSitterCliLoadable(
  resolvedBinPath: string = resolveTreeSitterBinPath(),
  searchPath: string = process.env.PATH ?? '',
): TreeSitterCliLoadCheck {
  const absoluteBinPath = isAbsolute(resolvedBinPath)
    ? resolvedBinPath
    : resolveOnPath(resolvedBinPath, searchPath);
  if (!absoluteBinPath) {
    return {
      present: false,
      loadable: false,
      reason: `tree-sitter CLI not found (looked for ${resolvedBinPath})`,
    };
  }
  return loadCheckFor(absoluteBinPath);
}

/** The cached --version probe for one absolute binary path. */
function loadCheckFor(absoluteBinPath: string): TreeSitterCliLoadCheck {
  let stats: { mtimeMs: number; mode: number };
  try {
    const s = statSync(absoluteBinPath);
    stats = { mtimeMs: s.mtimeMs, mode: s.mode };
  } catch {
    return {
      present: false,
      loadable: false,
      reason: `tree-sitter CLI not found at ${absoluteBinPath}`,
    };
  }
  const cached = loadCheckCache.get(absoluteBinPath);
  if (cached && cached.mtimeMs === stats.mtimeMs && cached.mode === stats.mode) return cached.check;
  const check = probeTreeSitterCliLoadable(absoluteBinPath);
  loadCheckCache.set(absoluteBinPath, { mtimeMs: stats.mtimeMs, mode: stats.mode, check });
  return check;
}

/**
 * Why the smart tools cannot parse here, or null when the CLI runs. Without
 * it, smart_outline answers "Could not parse … unsupported language or empty"
 * and smart_search reports "found 0 symbols", which read like a grammar
 * problem instead of the missing (#4858) or broken (#4758) CLI they are.
 *
 * The parameter exists for tests; callers pass none.
 */
export function treeSitterCliUnavailableMessage(
  check: TreeSitterCliLoadCheck = checkTreeSitterCliLoadable(),
): string | null {
  if (check.loadable) return null;
  const problem = check.present
    ? `the installed tree-sitter CLI cannot run on this system${check.reason ? ` (${check.reason})` : ""}`
    : "the tree-sitter CLI is not installed (not in the plugin's tree-sitter-cli package and not on PATH)";
  const fix = check.present ? "" : `; run \`npx claude-mem repair\`, or ${TREE_SITTER_CLI_PATH_WORKAROUND}`;
  return `${problem}: this is a broken-install/environment issue, not an unsupported language${fix}`;
}
