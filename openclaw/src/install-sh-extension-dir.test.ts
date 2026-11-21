import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

/**
 * resolve_extension_dir() decides which directory `rm -rf` deletes before the
 * re-clone, and one of its inputs is the user's ~/.openclaw/openclaw.json.
 * The config may name any directory, so the function must only ever accept an
 * installPath shaped like the plugin's own writer produces (…/claude-mem);
 * anything else has to fall through to the default extensions path. These
 * tests run the real bash function (extracted from install.sh) with a real
 * config file, so a hostile installPath is exercised through the same
 * bash+node boundary the installer uses. They need a bash binary: CI's linux
 * step has one; hosts without bash skip (the guard itself is one bash
 * conditional mirroring the load.paths branch next to it).
 */
function findBash(): string | null {
  const override = process.env.CLAUDE_MEM_TEST_BASH;
  if (override && existsSync(override)) return override;
  const candidates =
    process.platform === "win32"
      ? ["C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files\\Git\\usr\\bin\\bash.exe"]
      : ["/bin/bash", "/usr/bin/bash", "/usr/local/bin/bash", "/opt/homebrew/bin/bash"];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function extractedFunctionSource(): string {
  const script = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "install.sh"), "utf8");
  const start = script.indexOf("resolve_extension_dir() {");
  assert.ok(start !== -1, "install.sh no longer defines resolve_extension_dir");
  const end = script.indexOf("\n}", start);
  assert.ok(end !== -1, "resolve_extension_dir closing brace not found");
  return script.slice(start, end + 2);
}

function resolveExtensionDir(bash: string, fixtureHome: string): string {
  return execFileSync(
    bash,
    ["-c", `${extractedFunctionSource()}\nresolve_extension_dir`],
    { env: { ...process.env, HOME: fixtureHome }, encoding: "utf8" },
  ).trim();
}

describe("install.sh resolve_extension_dir", () => {
  const bash = findBash();

  it("removes only a claude-mem-shaped installPath, not an arbitrary configured directory", () => {
    if (!bash) {
      console.log("skip reason: no bash binary on this host (CI linux runs this test)");
      return;
    }
    const home = mkdtempSync(join(tmpdir(), "oc-guard-"));
    try {
      const hostile = join(home, "important-data");
      mkdirSync(hostile, { recursive: true });
      writeFileSync(join(hostile, "marker.txt"), "must survive the installer");
      const configDir = join(home, ".openclaw");
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, "openclaw.json"),
        JSON.stringify({ plugins: { installs: { "claude-mem": { installPath: hostile } } } }),
      );

      const resolved = resolveExtensionDir(bash, home);
      assert.equal(resolved, join(home, ".openclaw", "extensions", "claude-mem"));
      assert.ok(existsSync(hostile), "the configured non-plugin directory must not be removed");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("still honors a legitimate extensions-dir installPath", () => {
    if (!bash) {
      console.log("skip reason: no bash binary on this host (CI linux runs this test)");
      return;
    }
    const home = mkdtempSync(join(tmpdir(), "oc-legit-"));
    try {
      // A path that ends in /claude-mem but is NOT the default extensions dir:
      // if the function ignored the config or rejected every installPath, the
      // answer would fall back to the default and this assertion would fail.
      const legitimate = join(home, "custom-extensions", "claude-mem");
      mkdirSync(legitimate, { recursive: true });
      const configDir = join(home, ".openclaw");
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, "openclaw.json"),
        JSON.stringify({ plugins: { installs: { "claude-mem": { installPath: legitimate } } } }),
      );

      const resolved = resolveExtensionDir(bash, home);
      assert.equal(resolved, legitimate);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
