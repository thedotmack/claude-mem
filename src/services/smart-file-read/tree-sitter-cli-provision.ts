// Puts the tree-sitter CLI executable into a plugin root's own tree-sitter-cli
// package. Every install path installs that package with lifecycle scripts off:
// Claude Code's marketplace install, `bun install --ignore-scripts` and
// `npm install --ignore-scripts` alike. So tree-sitter-cli's install.js, the
// step that downloads the executable, never runs, and smart_search,
// smart_outline and smart_unfold cannot parse anything (#2910). Dependency-free
// like tree-sitter-bin-path.ts, so the npx installer and the worker share it.
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { treeSitterBinaryName } from "./tree-sitter-bin-name.js";

const TREE_SITTER_VERSION_TIMEOUT_MS = 10_000;

function treeSitterCliPackageDir(pluginRoot: string): string {
  return join(pluginRoot, "node_modules", "tree-sitter-cli");
}

/** The tree-sitter executable inside `pluginRoot`'s own tree-sitter-cli package. */
export function treeSitterCliBinaryPath(pluginRoot: string): string {
  return join(treeSitterCliPackageDir(pluginRoot), treeSitterBinaryName());
}

async function answersTreeSitterVersion(executablePath: string): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const child = execFile(executablePath, ["--version"], {
      encoding: "utf-8",
      timeout: TREE_SITTER_VERSION_TIMEOUT_MS,
      windowsHide: true,
    }, (error, stdout) => {
      resolve(!error && /^tree-sitter \d+\.\d+\.\d+(?:\s|$)/.test((stdout ?? "").trim()));
    });
    child.stdin?.end();
  });
}

/** True when the package-local tree-sitter CLI answers `--version`. */
export async function isTreeSitterCliBinaryUsable(pluginRoot: string): Promise<boolean> {
  return await answersTreeSitterVersion(treeSitterCliBinaryPath(pluginRoot));
}

function runInstallScript(
  installScript: string,
  workingDirectory: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [installScript], {
      cwd: workingDirectory,
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stdout, stderr }));
        return;
      }
      resolve({ stdout, stderr });
    });
    child.stdin?.end();
  });
}

/**
 * Run tree-sitter-cli's own install.js when the package-local CLI is not
 * usable. The script downloads the executable into its working directory, so
 * it runs in a staging directory inside the package, and the executable is
 * renamed into place only once it answers `--version`. The File Read Gate and
 * the parser only check that the file exists, so a download that fails, times
 * out or dies with its process must never leave a partial executable there.
 * Throws when no working executable results.
 */
export async function ensureTreeSitterCliBinary(pluginRoot: string, installTimeoutMs: number): Promise<void> {
  const cliDir = treeSitterCliPackageDir(pluginRoot);
  if (existsSync(cliDir) && !statSync(cliDir).isDirectory()) {
    throw new Error(`tree-sitter-cli package path is not a directory: ${cliDir}`);
  }
  if (await isTreeSitterCliBinaryUsable(pluginRoot)) return;

  const installScript = join(cliDir, "install.js");
  if (!existsSync(installScript)) {
    throw new Error(`tree-sitter-cli install script not found: ${installScript}`);
  }

  // Inside the package, so the final rename stays on one filesystem.
  const stagingDir = mkdtempSync(join(cliDir, ".provision-"));
  try {
    const installOutput = await runInstallScript(installScript, stagingDir, installTimeoutMs);
    const stagedExecutable = join(stagingDir, treeSitterBinaryName());
    if (!(await answersTreeSitterVersion(stagedExecutable))) {
      throw Object.assign(
        new Error(`tree-sitter-cli install completed without creating a working executable ${treeSitterCliBinaryPath(pluginRoot)}`),
        installOutput,
      );
    }
    renameSync(stagedExecutable, treeSitterCliBinaryPath(pluginRoot));
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }
}
