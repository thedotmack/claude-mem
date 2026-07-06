import { describe, it, expect } from "bun:test";
import {
  KIMI_CLI_CONFIG,
  isGenericCliSelected,
  parseCliOutput,
  buildKimiArgs,
} from "../../src/services/worker/GenericCliProvider.js";

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

describe("parseCliOutput", () => {
  it("extracts session_id from kimi tail + keeps observation XML", () => {
    const raw = `• thinking prose...\n<observation><type>discovery</type><title>x</title></observation>\nTo resume this session: kimi -r session_abc-123-def`;
    const result = parseCliOutput(raw, KIMI_CLI_CONFIG);
    expect(result.sessionId).toBe("session_abc-123-def");
    expect(result.content).toContain("<observation>");
    expect(result.content).toContain("<type>discovery</type>");
  });

  it("returns null sessionId when no resume marker", () => {
    const result = parseCliOutput("just XML no marker", KIMI_CLI_CONFIG);
    expect(result.sessionId).toBeNull();
  });
});

describe("buildKimiArgs", () => {
  it("first call: no resume flag, prompt + baseArgs", () => {
    const args = buildKimiArgs("hello", KIMI_CLI_CONFIG);
    // -p <prompt> + baseArgs (no resume)
    expect(args[0]).toBe("-p");
    expect(args[1]).toBe("hello");
    expect(args).toContain("--output-format");
    expect(args).toContain("text");
    expect(args).not.toContain(KIMI_CLI_CONFIG.resumeFlag);
  });

  it("retry: resume flag + sid prepended before -p", () => {
    const args = buildKimiArgs("hello", KIMI_CLI_CONFIG, "session_deadbeef-1234");
    // resumeFlag + sid must be in front
    expect(args[0]).toBe(KIMI_CLI_CONFIG.resumeFlag);
    expect(args[1]).toBe("session_deadbeef-1234");
    // -p <prompt> still present after
    const pIdx = args.indexOf("-p");
    expect(pIdx).toBeGreaterThan(-1);
    expect(args[pIdx + 1]).toBe("hello");
    // baseArgs still present
    expect(args).toContain("--output-format");
    expect(args).toContain("text");
  });

  it("resumeSessionId empty/null → no resume flag", () => {
    expect(buildKimiArgs("p", KIMI_CLI_CONFIG, null)).not.toContain(KIMI_CLI_CONFIG.resumeFlag);
    expect(buildKimiArgs("p", KIMI_CLI_CONFIG, "")).not.toContain(KIMI_CLI_CONFIG.resumeFlag);
  });
});
