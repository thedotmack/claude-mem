// Where the tree-sitter CLI lives, and whether it is there at all. Dependency-free
// on purpose (like language-map.ts): the PreToolUse file-context hook asks "can
// smart_outline run here?" through it without pulling the tree-sitter parser
// into the worker bundle. The hook and the MCP server resolve from the same
// plugin root, so the hook's answer matches what the parser will find.
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
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
