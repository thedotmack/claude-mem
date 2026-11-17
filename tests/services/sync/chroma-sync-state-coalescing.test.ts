import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ChromaSyncState } from "../../../src/services/sync/ChromaSyncState.js";

const project = "coalesced-project";

function statePath(dataDir: string): string {
  return join(dataDir, "chroma-sync-state.json");
}

function readWatermark(dataDir: string): number {
  return JSON.parse(readFileSync(statePath(dataDir), "utf8"))[project]
    .observations;
}

/** Wait for the coalesced timer to write, without a fixed sleep margin. */
async function waitForFile(path: string): Promise<void> {
  const started = Date.now();
  while (!existsSync(path)) {
    if (Date.now() - started > 2_000) {
      throw new Error(`Checkpoint was not written within 2s: ${path}`);
    }
    await Bun.sleep(25);
  }
}

/**
 * #6203: a backfill bumps the watermark once per indexed row. Persisting every
 * bump rewrote the whole pending list each time, so a 2,000-row backfill wrote
 * ~28 MB of checkpoint data. Progress is coalesced into one write per window
 * instead; `flush()` still makes it durable at the end of a run.
 */
describe("ChromaSyncState write coalescing", () => {
  let dataDir: string;
  let previousDataDir: string | undefined;

  beforeEach(() => {
    previousDataDir = process.env.CLAUDE_MEM_DATA_DIR;
    dataDir = mkdtempSync(join(tmpdir(), "claude-mem-state-coalescing-"));
    process.env.CLAUDE_MEM_DATA_DIR = dataDir;
    ChromaSyncState.resetCacheForTests();
  });

  afterEach(() => {
    ChromaSyncState.resetCacheForTests();
    if (previousDataDir === undefined) {
      delete process.env.CLAUDE_MEM_DATA_DIR;
    } else {
      process.env.CLAUDE_MEM_DATA_DIR = previousDataDir;
    }
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("writes a burst of bumps once instead of once per row", async () => {
    ChromaSyncState.bump(project, "observations", 1);

    // Still inside the coalesce window: nothing has hit the disk yet.
    expect(existsSync(statePath(dataDir))).toBe(false);

    for (let id = 2; id <= 200; id += 1) {
      ChromaSyncState.bump(project, "observations", id);
    }
    expect(existsSync(statePath(dataDir))).toBe(false);

    await waitForFile(statePath(dataDir));

    expect(readWatermark(dataDir)).toBe(200);
  });

  it("flush makes pending progress durable immediately", () => {
    ChromaSyncState.bump(project, "observations", 5);
    expect(existsSync(statePath(dataDir))).toBe(false);

    ChromaSyncState.flush();

    expect(existsSync(statePath(dataDir))).toBe(true);
    expect(readWatermark(dataDir)).toBe(5);
  });

  it("leaves an unflushed bump out of the file, so a crash repeats those rows", () => {
    ChromaSyncState.bump(project, "observations", 1);
    ChromaSyncState.flush();
    expect(readWatermark(dataDir)).toBe(1);

    ChromaSyncState.bump(project, "observations", 2);

    // The file still records the last durable position; row 2 stays pending or
    // above the watermark and is indexed again after a restart.
    expect(readWatermark(dataDir)).toBe(1);

    ChromaSyncState.flush();
    expect(readWatermark(dataDir)).toBe(2);
  });

  it("writes a pending change next to the state it describes, not a later data directory", () => {
    const laterDataDir = mkdtempSync(
      join(tmpdir(), "claude-mem-state-coalescing-later-"),
    );
    try {
      ChromaSyncState.bump(project, "observations", 7);

      // The data directory changes while the change is still dirty (a settings
      // reload, or the next test's beforeEach).
      process.env.CLAUDE_MEM_DATA_DIR = laterDataDir;
      ChromaSyncState.flush();

      expect(existsSync(statePath(laterDataDir))).toBe(false);
      expect(readWatermark(dataDir)).toBe(7);
    } finally {
      process.env.CLAUDE_MEM_DATA_DIR = dataDir;
      rmSync(laterDataDir, { recursive: true, force: true });
    }
  });
});
