import { describe, it, expect, beforeEach, afterEach, afterAll, mock } from "bun:test";

// Stub ModeManager before importing modules that pull it in transitively
// (SessionRoutes -> SessionManager -> ModeManager).
mock.module("../../src/services/domain/ModeManager.js", () => ({
  ModeManager: {
    getInstance: () => ({
      getActiveMode: () => ({
        name: "code",
        prompts: { init: "i", observation: "o", summary: "s" },
        observation_types: [{ id: "discovery" }],
        observation_concepts: [],
      }),
    }),
  },
}));

import { SettingsRoutes } from "../../src/services/worker/http/routes/SettingsRoutes.js";
import { SessionRoutes } from "../../src/services/worker/http/routes/SessionRoutes.js";
import { GenericCliProvider } from "../../src/services/worker/GenericCliProvider.js";
import { SettingsManager } from "../../src/services/worker/SettingsManager.js";

// Lightweight stubs — `getSelectedProvider` / `getActiveAgent` only call
// module-level selection guards, so they never touch instance state.
function makeStubSettingsManager(): SettingsManager {
  return {} as SettingsManager;
}

function makeStubSessionRoutes(genericCliAgent: GenericCliProvider): SessionRoutes {
  return new SessionRoutes(
    // sessionManager, dbManager, sdkAgent, geminiAgent, openRouterAgent
    null as any,
    null as any,
    null as any,
    null as any,
    null as any,
    genericCliAgent,
    null as any, // eventBroadcaster
    null as any, // workerService
    null as any, // completionHandler
  );
}

describe("Task 7: provider registration", () => {
  let prevProvider: string | undefined;

  beforeEach(() => {
    prevProvider = process.env.CLAUDE_MEM_PROVIDER;
    // Clear so file-based selection (default 'claude') is the baseline.
    delete process.env.CLAUDE_MEM_PROVIDER;
  });

  afterEach(() => {
    if (prevProvider === undefined) {
      delete process.env.CLAUDE_MEM_PROVIDER;
    } else {
      process.env.CLAUDE_MEM_PROVIDER = prevProvider;
    }
  });

  afterAll(() => {
    // Defensive: ensure no env leak across files even if a nested import
    // re-reads process.env.CLAUDE_MEM_PROVIDER after the test suite exits.
    if (prevProvider === undefined) {
      delete process.env.CLAUDE_MEM_PROVIDER;
    } else {
      process.env.CLAUDE_MEM_PROVIDER = prevProvider;
    }
  });

  describe("SettingsRoutes.validateSettings", () => {
    it("accepts 'generic-cli' as a valid CLAUDE_MEM_PROVIDER", () => {
      const routes = new SettingsRoutes(makeStubSettingsManager());
      const result = (routes as any).validateSettings({
        CLAUDE_MEM_PROVIDER: "generic-cli",
      });
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it("rejects unknown provider values (regression guard)", () => {
      const routes = new SettingsRoutes(makeStubSettingsManager());
      const result = (routes as any).validateSettings({
        CLAUDE_MEM_PROVIDER: "totally-fake-provider",
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain("generic-cli");
    });

    it("still accepts the existing providers (claude/gemini/openrouter)", () => {
      const routes = new SettingsRoutes(makeStubSettingsManager());
      for (const p of ["claude", "gemini", "openrouter"]) {
        const r = (routes as any).validateSettings({ CLAUDE_MEM_PROVIDER: p });
        expect(r.valid).toBe(true);
      }
    });
  });

  describe("SessionRoutes provider selection (generic-cli)", () => {
    // NOTE: This test asserts the selection branch is wired in SessionRoutes.
    // It depends on `kimi` being on PATH (isGenericCliAvailable === true);
    // CI / dev boxes without kimi get a soft skip via the `isGenericCliAvailable`
    // preflight. Both guards (selected && available) must hold for the
    // generic-cli branch to win.
    it("getSelectedProvider() returns 'generic-cli' when env selects it and kimi is on PATH", async () => {
      process.env.CLAUDE_MEM_PROVIDER = "generic-cli";
      const { isGenericCliAvailable } = await import(
        "../../src/services/worker/GenericCliProvider.js"
      );
      const stubAgent = new GenericCliProvider(null as any, null as any);
      const routes = makeStubSessionRoutes(stubAgent);
      const selected = (routes as any).getSelectedProvider() as string;
      if (isGenericCliAvailable()) {
        expect(selected).toBe("generic-cli");
      } else {
        // No kimi binary on this host — fall back to claude is acceptable.
        expect(["generic-cli", "claude"]).toContain(selected);
      }
    });

    it("getActiveAgent() returns the registered genericCliAgent instance when generic-cli is selected", async () => {
      process.env.CLAUDE_MEM_PROVIDER = "generic-cli";
      const { isGenericCliAvailable } = await import(
        "../../src/services/worker/GenericCliProvider.js"
      );
      const stubAgent = new GenericCliProvider(null as any, null as any);
      const routes = makeStubSessionRoutes(stubAgent);
      if (!isGenericCliAvailable()) {
        console.warn("skip: kimi not on PATH");
        return;
      }
      const agent = (routes as any).getActiveAgent();
      // Identity check — the dispatch MUST hand back the same instance that
      // worker-service registers, not a fresh one.
      expect(agent).toBe(stubAgent);
    });

    it("env override is read by isGenericCliSelected (wiring sanity)", async () => {
      process.env.CLAUDE_MEM_PROVIDER = "generic-cli";
      const { isGenericCliSelected } = await import(
        "../../src/services/worker/GenericCliProvider.js"
      );
      expect(isGenericCliSelected()).toBe(true);
      process.env.CLAUDE_MEM_PROVIDER = "claude";
      expect(isGenericCliSelected()).toBe(false);
    });
  });
});
