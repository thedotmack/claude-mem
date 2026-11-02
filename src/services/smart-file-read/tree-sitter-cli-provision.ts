// Puts the tree-sitter CLI executable into a plugin root's own tree-sitter-cli
// package. Every install path installs that package with lifecycle scripts off:
// Claude Code's marketplace install, `bun install --ignore-scripts` and
// `npm install --ignore-scripts` alike. So tree-sitter-cli's install.js, the
// step that downloads the executable, never runs, and smart_search,
// smart_outline and smart_unfold cannot parse anything (#2910). Dependency-free
// like tree-sitter-bin-path.ts, so the npx installer and the worker share it.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { treeSitterBinaryName } from "./tree-sitter-bin-name.js";
import { isExecutableFile } from "./tree-sitter-bin-path.js";
import {
  glibcCompatibleTreeSitterBuild,
  pinnedTreeSitterExecutableSha256,
  type GlibcCompatibleTreeSitterBuild,
} from "./tree-sitter-cli-checksums.js";
import { condaPackageUnsupportedReason, treeSitterExecutableFromCondaPackage } from "./tree-sitter-cli-conda.js";

const TREE_SITTER_VERSION_TIMEOUT_MS = 10_000;
const TREE_SITTER_VERSION_OUTPUT = /^tree-sitter \d+\.\d+\.\d+(?:\s|$)/;

/**
 * Every provisioning error for a verified release executable that the OS
 * cannot run (#4758: glibc too old; #4858: musl) contains this text. The
 * installer error taxonomy uses it to tell this case apart from a failed
 * download.
 */
export const TREE_SITTER_CLI_CANNOT_RUN = "cannot run on this system";

function treeSitterCliPackageDir(pluginRoot: string): string {
  return join(pluginRoot, "node_modules", "tree-sitter-cli");
}

/** The tree-sitter executable inside `pluginRoot`'s own tree-sitter-cli package. */
export function treeSitterCliBinaryPath(pluginRoot: string): string {
  return join(treeSitterCliPackageDir(pluginRoot), treeSitterBinaryName());
}

export interface TreeSitterCliVersionProbe {
  usable: boolean;
  /** The spawn failure's stderr (or error) first line when not usable. */
  reason?: string;
}

/** How the probe runs the executable; tests pass a stub to control the callback. */
export type TreeSitterProbeExec = (
  file: string,
  args: readonly string[],
  options: { encoding: "utf-8"; timeout: number; windowsHide: boolean },
  callback: (error: NodeJS.ErrnoException | null, stdout: string | Buffer, stderr: string | Buffer) => void,
) => { stdin?: { end(): void } | null } | undefined;

/**
 * Bun can pass the callback a Buffer even with `encoding: "utf-8"` set
 * (#5019), and a Buffer has no `.trim`. Read either shape as text.
 */
function probeText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return String(value);
}

/** Answers `--version` for `executablePath`; exported for its output-shape test. */
export async function answersTreeSitterVersion(
  executablePath: string,
  execFileImpl: TreeSitterProbeExec = execFile as unknown as TreeSitterProbeExec,
): Promise<TreeSitterCliVersionProbe> {
  return await new Promise<TreeSitterCliVersionProbe>((resolve) => {
    // Bun can throw synchronously when the OS refuses the file outright (a
    // truncated Mach-O is EBADMACHO on macOS); that is "not usable", the same
    // as a spawn failure reported through the callback.
    try {
      const child = execFileImpl(executablePath, ["--version"], {
        encoding: "utf-8",
        timeout: TREE_SITTER_VERSION_TIMEOUT_MS,
        windowsHide: true,
      }, (error, stdout, stderr) => {
        const stdoutText = probeText(stdout);
        if (!error && TREE_SITTER_VERSION_OUTPUT.test(stdoutText.trim())) {
          resolve({ usable: true });
          return;
        }
        const detail = probeText(stderr).trim().split("\n")[0]
          || (error?.message ?? "").split("\n")[0]
          || undefined;
        resolve({ usable: false, reason: detail });
      });
      child?.stdin?.end();
    } catch (spawnError) {
      const message = spawnError instanceof Error ? spawnError.message : String(spawnError);
      resolve({ usable: false, reason: message.split("\n")[0] || undefined });
    }
  });
}

/** True when the package-local tree-sitter CLI answers `--version`. */
export async function isTreeSitterCliBinaryUsable(pluginRoot: string): Promise<boolean> {
  return (await answersTreeSitterVersion(treeSitterCliBinaryPath(pluginRoot))).usable;
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

function sha256OfFile(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function sha256OfBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Where a glibc-compatible build comes from; tests replace both. */
export interface GlibcCompatibleFallback {
  buildFor: (version: string) => GlibcCompatibleTreeSitterBuild | undefined;
  download: (url: string, timeoutMs: number) => Promise<Buffer>;
}

async function downloadArchive(url: string, timeoutMs: number): Promise<Buffer> {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "follow" });
  if (!response.ok) throw new Error(`GET ${url} answered HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

const CONDA_FORGE_FALLBACK: GlibcCompatibleFallback = {
  buildFor: glibcCompatibleTreeSitterBuild,
  download: downloadArchive,
};

/** The OS refused the release asset because this glibc is too old (#4758). */
function refusedForOlderGlibc(probe: TreeSitterCliVersionProbe): boolean {
  return process.platform === "linux" && /GLIBC_\d/.test(probe.reason ?? "");
}

/**
 * Install the glibc-compatible build of `version` at the package-local path.
 * The package must match its pinned SHA-256 before it is opened, and the
 * executable inside it must match its own pinned SHA-256 before it is run.
 * Throws when either does not, or when the result does not answer --version.
 */
async function installGlibcCompatibleBuild(
  pluginRoot: string,
  build: GlibcCompatibleTreeSitterBuild,
  timeoutMs: number,
  download: GlibcCompatibleFallback["download"],
): Promise<void> {
  // The worker runs under Bun, which can; Node 20 (the npx installer) cannot.
  // Say so before downloading anything.
  const unsupported = condaPackageUnsupportedReason();
  if (unsupported) throw new Error(unsupported);
  const archive = await download(build.url, timeoutMs);
  const archiveSha256 = sha256OfBytes(archive);
  if (archiveSha256 !== build.archiveSha256) {
    throw new Error(`${build.url} has SHA-256 ${archiveSha256}, not the pinned ${build.archiveSha256}; it was not opened`);
  }
  const executable = treeSitterExecutableFromCondaPackage(archive);
  const executableSha256 = sha256OfBytes(executable);
  if (executableSha256 !== build.executableSha256) {
    throw new Error(`bin/tree-sitter in ${build.url} has SHA-256 ${executableSha256}, not the pinned ${build.executableSha256}; it was not run`);
  }
  const stagingDir = mkdtempSync(join(treeSitterCliPackageDir(pluginRoot), ".provision-"));
  try {
    const stagedExecutable = join(stagingDir, treeSitterBinaryName());
    writeFileSync(stagedExecutable, executable);
    chmodSync(stagedExecutable, 0o755);
    const probe = await answersTreeSitterVersion(stagedExecutable);
    if (!probe.usable) {
      throw new Error(`the glibc-compatible tree-sitter build does not run either${probe.reason ? `: ${probe.reason}` : ""}`);
    }
    renameSync(stagedExecutable, treeSitterCliBinaryPath(pluginRoot));
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }
}

export type TreeSitterCliBinarySource = "already-usable" | "release" | "glibc-compatible";

/**
 * Run tree-sitter-cli's own install.js when the package-local CLI is not
 * usable. The script downloads the executable into its working directory, so
 * it runs in a staging directory inside the package. The executable must match
 * the SHA-256 pinned for the package's version and this platform before it is
 * run at all (a replaced release asset never executes), and is renamed into
 * place only once it then answers `--version`. The File Read Gate and the
 * parser only check that the file exists, so a download that fails, times out
 * or dies with its process must never leave a partial executable there.
 * Throws when no verified, working executable results. When the existing
 * executable is intact (matches the pinned SHA-256) but the OS cannot run it
 * (#4758), the download would fetch identical bytes, so it throws immediately
 * with the spawn failure's reason instead.
 *
 * When the OS refuses the release asset because its glibc is too old, the
 * conda-forge build of the same version is installed instead, if one is pinned
 * for this platform (linux-x64, linux-arm64); see
 * GLIBC_COMPATIBLE_TREE_SITTER_BUILDS. Resolves to where the working
 * executable came from.
 *
 * `pinnedSha256ForVersion` and `glibcFallback` exist for tests; callers pass none.
 */
export async function ensureTreeSitterCliBinary(
  pluginRoot: string,
  installTimeoutMs: number,
  pinnedSha256ForVersion: (version: string) => string | undefined = pinnedTreeSitterExecutableSha256,
  glibcFallback: GlibcCompatibleFallback = CONDA_FORGE_FALLBACK,
): Promise<TreeSitterCliBinarySource> {
  const cliDir = treeSitterCliPackageDir(pluginRoot);
  if (existsSync(cliDir) && !statSync(cliDir).isDirectory()) {
    throw new Error(`tree-sitter-cli package path is not a directory: ${cliDir}`);
  }
  const existingBinaryPath = treeSitterCliBinaryPath(pluginRoot);
  const existingProbe = await answersTreeSitterVersion(existingBinaryPath);
  if (existingProbe.usable) return "already-usable";

  const installScript = join(cliDir, "install.js");
  if (!existsSync(installScript)) {
    throw new Error(`tree-sitter-cli install script not found: ${installScript}`);
  }
  const version = String((JSON.parse(readFileSync(join(cliDir, "package.json"), "utf-8")) as { version?: unknown }).version);
  const pinnedSha256 = pinnedSha256ForVersion(version);

  // Falls back to the glibc-compatible build when the OS refused the release
  // asset for its glibc; otherwise, or when that fails too, throws `failure`.
  const useGlibcCompatibleBuildOrThrow = async (
    probe: TreeSitterCliVersionProbe,
    failure: Error,
  ): Promise<TreeSitterCliBinarySource> => {
    const build = refusedForOlderGlibc(probe) ? glibcFallback.buildFor(version) : undefined;
    if (!build) throw failure;
    try {
      await installGlibcCompatibleBuild(pluginRoot, build, installTimeoutMs, glibcFallback.download);
      return "glibc-compatible";
    } catch (fallbackError) {
      const detail = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      failure.message += ` The glibc-compatible build (${build.url}) could not be installed either: ${detail}`;
      throw failure;
    }
  };
  if (!pinnedSha256) {
    throw new Error(
      `No SHA-256 is pinned for the tree-sitter ${version} executable on ${process.platform}-${process.arch}, `
      + "so it is not downloaded (src/services/smart-file-read/tree-sitter-cli-checksums.ts)",
    );
  }

  // The executable is intact (it matches the pinned SHA-256) but the OS cannot
  // run it — e.g. tree-sitter-cli 0.26.9 links against GLIBC_2.39, which
  // Ubuntu 22.04 / Debian 12 / RHEL 9 do not have (#4758). Downloading the
  // same release asset again cannot help, so fail fast with the real reason
  // instead of burning a download on every worker start. A corrupt or stale
  // binary (SHA mismatch) still falls through to the download below, as does
  // a binary that merely lost its executable bit: the download restores 755.
  if (existsSync(existingBinaryPath)) {
    let existingSha256 = "(unreadable)";
    try {
      existingSha256 = sha256OfFile(existingBinaryPath);
    } catch {
      // Fall through to the download; it cannot make things worse.
    }
    if (existingSha256 === pinnedSha256 && isExecutableFile(existingBinaryPath)) {
      return await useGlibcCompatibleBuildOrThrow(existingProbe, new Error(
        `The tree-sitter ${version} executable at ${existingBinaryPath} is intact (SHA-256 matches the pinned value) `
        + `but ${TREE_SITTER_CLI_CANNOT_RUN}${existingProbe.reason ? `: ${existingProbe.reason}` : ""}. `
        + "smart_search, smart_outline and smart_unfold cannot parse here, and the File Read Gate stays off.",
      ));
    }
  }

  // Inside the package, so the final rename stays on one filesystem.
  const stagingDir = mkdtempSync(join(cliDir, ".provision-"));
  try {
    const installOutput = await runInstallScript(installScript, stagingDir, installTimeoutMs);
    const stagedExecutable = join(stagingDir, treeSitterBinaryName());
    const downloadedSha256 = existsSync(stagedExecutable) ? sha256OfFile(stagedExecutable) : "(no file)";
    if (downloadedSha256 !== pinnedSha256) {
      throw Object.assign(
        new Error(`The downloaded tree-sitter ${version} executable has SHA-256 ${downloadedSha256}, not the pinned ${pinnedSha256}; it was not run`),
        installOutput,
      );
    }
    const stagedProbe = await answersTreeSitterVersion(stagedExecutable);
    if (!stagedProbe.usable) {
      // The verified release asset stays out of place, so the next start does
      // not find an intact-but-unrunnable binary either way.
      return await useGlibcCompatibleBuildOrThrow(stagedProbe, Object.assign(
        new Error(
          `The downloaded tree-sitter ${version} executable matches the pinned SHA-256 but ${TREE_SITTER_CLI_CANNOT_RUN}`
          + `${stagedProbe.reason ? `: ${stagedProbe.reason}` : ""}; it was not moved to ${treeSitterCliBinaryPath(pluginRoot)}`,
        ),
        installOutput,
      ));
    }
    renameSync(stagedExecutable, treeSitterCliBinaryPath(pluginRoot));
    return "release";
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }
}
