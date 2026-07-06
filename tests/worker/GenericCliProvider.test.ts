import { describe, it, expect } from "bun:test";
import { KIMI_CLI_CONFIG, isGenericCliSelected } from "../../src/services/worker/GenericCliProvider.js";

describe("GenericCliProvider config", () => {
  it("Kimi config has cmd + output-format text + resume flag", () => {
    expect(KIMI_CLI_CONFIG.cmd).toBe("kimi");
    expect(KIMI_CLI_CONFIG.baseArgs).toEqual(["--output-format", "text"]);
    expect(KIMI_CLI_CONFIG.outputFormat).toBe("text");
    expect(["-r", "-S"]).toContain(KIMI_CLI_CONFIG.resumeFlag);
    expect(KIMI_CLI_CONFIG.sessionIdRegex.test("To resume: kimi -r session_abc-123")).toBe(true);
    expect(KIMI_CLI_CONFIG.providerName).toBe("kimi-cli");
    expect(KIMI_CLI_CONFIG.syntheticIdPrefix).toBe("kimi");
  });

  it("isGenericCliSelected reads CLAUDE_MEM_PROVIDER=generic-cli", () => {
    process.env.CLAUDE_MEM_PROVIDER = "generic-cli";
    expect(isGenericCliSelected()).toBe(true);
    process.env.CLAUDE_MEM_PROVIDER = "claude";
    expect(isGenericCliSelected()).toBe(false);
  });
});
