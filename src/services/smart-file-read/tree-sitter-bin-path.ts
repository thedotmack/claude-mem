// Where the tree-sitter CLI lives, and whether it is there at all. Dependency-free
// on purpose (like language-map.ts): the PreToolUse file-context hook asks "can
// smart_outline run here?" through it without pulling the tree-sitter parser
// into the worker bundle. The hook and the MCP server resolve from the same
// plugin root, so the hook's answer matches what the parser will find.
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";
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

  try {
    const pkgPath = _require.resolve("tree-sitter-cli/package.json");
    const binPath = join(dirname(pkgPath), binName);
    if (existsSync(binPath)) {
      return binPath;
    }
  } catch {
    // [ANTI-PATTERN IGNORED]: tree-sitter-cli not in node_modules is expected; falls back to PATH
  }

  return binName;
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

const TREE_SITTER_LOAD_PROBE_TIMEOUT_MS = 10_000;
const TREE_SITTER_VERSION_OUTPUT = /^tree-sitter \d+\.\d+\.\d+(?:\s|$)/;

export interface TreeSitterCliLoadCheck {
  /** A tree-sitter CLI binary file was found (it may still not run). */
  present: boolean;
  /** The binary executed and answered `--version` as tree-sitter. */
  loadable: boolean;
  /** Why the binary is absent or not loadable; undefined when loadable. */
  reason?: string;
}

interface CachedLoadCheck {
  mtimeMs: number;
  check: TreeSitterCliLoadCheck;
}

// The --version probe spawns a process, so it runs at most once per binary:
// results are cached per process keyed by resolved path + mtime. A worker
// provisioning a replacement (new mtime) is re-probed, while the hot path
// (the File Read Gate runs this per Read) pays one statSync + Map lookup.
const loadCheckCache = new Map<string, CachedLoadCheck>();

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
    if (TREE_SITTER_VERSION_OUTPUT.test(stdout.trim())) {
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
      if (statSync(candidate).isFile()) return candidate;
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
 * Synchronous so the PreToolUse File Read Gate can use it per Read.
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
  let mtimeMs: number;
  try {
    mtimeMs = statSync(absoluteBinPath).mtimeMs;
  } catch {
    return {
      present: false,
      loadable: false,
      reason: `tree-sitter CLI not found at ${absoluteBinPath}`,
    };
  }
  const cached = loadCheckCache.get(absoluteBinPath);
  if (cached && cached.mtimeMs === mtimeMs) return cached.check;
  const check = probeTreeSitterCliLoadable(absoluteBinPath);
  loadCheckCache.set(absoluteBinPath, { mtimeMs, check });
  return check;
}
