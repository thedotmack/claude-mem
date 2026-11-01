import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { findBun } from "../../src/launcher/bun-runtime.js";

function pendingChildProcess(emitCloseOnKill = true): ChildProcess & {
  stdout: EventEmitter;
  killed: boolean;
} {
  const child = new EventEmitter() as ChildProcess & {
    stdout: EventEmitter;
    killed: boolean;
  };
  child.stdout = new EventEmitter();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    if (emitCloseOnKill) child.emit("close", null, "SIGTERM");
    return true;
  };
  return child;
}

describe("findBun Windows discovery", () => {
  it("checks an explicit Bun path before running where.exe", async () => {
    let lookupStarted = false;
    const result = await findBun({
      platform: "win32",
      env: { BUN_PATH: "C:\\tools\\bun.exe" },
      homeDirectory: "C:\\Users\\test",
      exists: (candidate) => candidate === "C:\\tools\\bun.exe",
      spawnProcess: (() => {
        lookupStarted = true;
        return pendingChildProcess();
      }) as never,
    });

    expect(result).toBe("C:\\tools\\bun.exe");
    expect(lookupStarted).toBe(false);
  });

  // Windows precedence is deliberate (#4934): BUN, BUN_PATH, BUN_INSTALL, then
  // ~/.bun win over PATH, so a Bun reported by where.exe is never consulted
  // while any of them exists.
  it("pins Windows precedence: explicit and known paths before PATH, in order", async () => {
    const env = {
      BUN: "C:\\explicit\\bun.exe",
      BUN_PATH: "C:\\bun-path\\bun.exe",
      BUN_INSTALL: "C:\\bun-install",
    };
    const ordered = [
      "C:\\explicit\\bun.exe",
      "C:\\bun-path\\bun.exe",
      join("C:\\bun-install", "bin", "bun.exe"),
      join("C:\\Users\\test", ".bun", "bin", "bun.exe"),
    ];
    for (let index = 0; index < ordered.length; index++) {
      const present = new Set(ordered.slice(index));
      let lookupStarted = false;
      const result = await findBun({
        platform: "win32",
        env,
        homeDirectory: "C:\\Users\\test",
        exists: (candidate) => present.has(candidate),
        spawnProcess: (() => {
          lookupStarted = true;
          return pendingChildProcess();
        }) as never,
      });
      expect(result).toBe(ordered[index]);
      expect(lookupStarted).toBe(false);
    }
  });

  it("kills a stalled where.exe lookup at the deadline", async () => {
    const child = pendingChildProcess();
    const result = await findBun({
      platform: "win32",
      env: { SystemRoot: "C:\\Windows" },
      homeDirectory: "C:\\Users\\test",
      exists: () => false,
      spawnProcess: (() => child) as never,
      timeoutMs: 10,
    });

    expect(result).toBeNull();
    expect(child.killed).toBe(true);
  });

  it("returns an existing Bun executable reported by where.exe", async () => {
    const child = pendingChildProcess();
    const bunPath = "C:\\tools\\bun.exe";
    let lookupStarted = false;
    const resultPromise = findBun({
      platform: "win32",
      env: { SystemRoot: "C:\\Windows" },
      homeDirectory: "C:\\Users\\test",
      exists: (candidate) => candidate === bunPath,
      spawnProcess: (() => {
        lookupStarted = true;
        return child;
      }) as never,
      timeoutMs: 100,
    });
    setTimeout(() => {
      child.stdout.emit("data", `${bunPath}\r\n`);
      child.emit("close", 0, null);
    }, 1);

    expect(await resultPromise).toBe(bunPath);
    expect(lookupStarted).toBe(true);
  });

  it("drops a where.exe hit in the current directory (a planted bun.exe)", async () => {
    // where.exe lists the current directory first; hooks run in the user's
    // project, so a bun.exe planted there must never be returned.
    const child = pendingChildProcess();
    const plantedBun = "C:\\work\\project\\bun.exe";
    const realBun = "C:\\tools\\bun.exe";
    const resultPromise = findBun({
      platform: "win32",
      env: { SystemRoot: "C:\\Windows" },
      homeDirectory: "C:\\Users\\test",
      cwd: "C:\\work\\project",
      exists: (candidate) => candidate === plantedBun || candidate === realBun,
      spawnProcess: (() => child) as never,
      timeoutMs: 100,
    });
    setTimeout(() => {
      child.stdout.emit("data", `${plantedBun}\r\n${realBun}\r\n`);
      child.emit("close", 0, null);
    }, 1);

    expect(await resultPromise).toBe(realBun);
  });

  it("returns at the deadline even when killing where.exe emits no close event", async () => {
    const child = pendingChildProcess(false);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const resultPromise = findBun({
      platform: "win32",
      env: { SystemRoot: "C:\\Windows" },
      homeDirectory: "C:\\Users\\test",
      exists: () => false,
      spawnProcess: (() => child) as never,
      timeoutMs: 10,
    });
    const result = await Promise.race([
      resultPromise,
      new Promise<never>((_, reject) => {
        deadline = setTimeout(
          () =>
            reject(new Error("where.exe lookup exceeded the test deadline")),
          250,
        );
      }),
    ]);
    if (deadline) clearTimeout(deadline);

    expect(result).toBeNull();
    expect(child.killed).toBe(true);
  });
});
