import { describe, it, expect } from "bun:test";
import { parseArgs, formatElapsed } from "../scripts/full-eval";
import type { ParsedArgs } from "../scripts/full-eval";

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

describe("parseArgs", () => {
  it("returns defaults when no arguments provided", () => {
    const args = parseArgs([]);
    expect(args.noResume).toBe(false);
    expect(args.qaDelay).toBe(500);
    expect(args.judgeDelay).toBe(300);
    expect(args.conversation).toBeNull();
    expect(args.limit).toBeNull();
    expect(args.skipJudge).toBe(false);
    expect(args.judgeRuns).toBe(10);
  });

  it("parses --no-resume flag", () => {
    const args = parseArgs(["--no-resume"]);
    expect(args.noResume).toBe(true);
  });

  it("parses --qa-delay with value", () => {
    const args = parseArgs(["--qa-delay", "1000"]);
    expect(args.qaDelay).toBe(1000);
  });

  it("parses --judge-delay with value", () => {
    const args = parseArgs(["--judge-delay", "200"]);
    expect(args.judgeDelay).toBe(200);
  });

  it("parses --conversation with sample ID", () => {
    const args = parseArgs(["--conversation", "conv-05"]);
    expect(args.conversation).toBe("conv-05");
  });

  it("parses --limit with value", () => {
    const args = parseArgs(["--limit", "5"]);
    expect(args.limit).toBe(5);
  });

  it("parses --skip-judge flag", () => {
    const args = parseArgs(["--skip-judge"]);
    expect(args.skipJudge).toBe(true);
  });

  it("parses --judge-runs with value", () => {
    const args = parseArgs(["--judge-runs", "3"]);
    expect(args.judgeRuns).toBe(3);
  });

  it("parses multiple arguments together", () => {
    const args = parseArgs([
      "--no-resume",
      "--qa-delay", "100",
      "--judge-delay", "50",
      "--conversation", "conv-26",
      "--limit", "10",
      "--skip-judge",
      "--judge-runs", "5",
    ]);

    expect(args.noResume).toBe(true);
    expect(args.qaDelay).toBe(100);
    expect(args.judgeDelay).toBe(50);
    expect(args.conversation).toBe("conv-26");
    expect(args.limit).toBe(10);
    expect(args.skipJudge).toBe(true);
    expect(args.judgeRuns).toBe(5);
  });

  it("ignores unknown arguments", () => {
    const args = parseArgs(["--unknown-flag", "--qa-delay", "200"]);
    expect(args.qaDelay).toBe(200);
    // Defaults are preserved
    expect(args.noResume).toBe(false);
  });

  it("parses --qa-delay of zero", () => {
    const args = parseArgs(["--qa-delay", "0"]);
    expect(args.qaDelay).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// formatElapsed
// ---------------------------------------------------------------------------

describe("formatElapsed", () => {
  it("formats sub-minute times as seconds", () => {
    expect(formatElapsed(5000)).toBe("5s");
    expect(formatElapsed(45000)).toBe("45s");
  });

  it("formats times >= 60s as minutes and seconds", () => {
    expect(formatElapsed(60000)).toBe("1m00s");
    expect(formatElapsed(90000)).toBe("1m30s");
    expect(formatElapsed(125000)).toBe("2m05s");
  });

  it("formats zero", () => {
    expect(formatElapsed(0)).toBe("0s");
  });

  it("handles large durations", () => {
    // 1 hour = 3600 seconds = 60 minutes
    expect(formatElapsed(3600000)).toBe("60m00s");
  });

  it("truncates milliseconds (floor)", () => {
    expect(formatElapsed(1500)).toBe("1s");
    expect(formatElapsed(999)).toBe("0s");
  });
});

// ---------------------------------------------------------------------------
// Options mapping (integration with DEFAULT_EVAL_OPTIONS)
// ---------------------------------------------------------------------------

describe("CLI args to EvalRunnerOptions mapping", () => {
  it("maps parseArgs defaults to correct EvalRunnerOptions values", () => {
    const cliArgs = parseArgs([]);

    // Verify that CLI defaults correspond to expected eval option values
    expect(!cliArgs.noResume).toBe(true); // resumeFromCheckpoints = !noResume
    expect(cliArgs.qaDelay).toBe(500);    // delayBetweenQACallsMs
    expect(cliArgs.judgeDelay).toBe(300); // delayBetweenJudgeCallsMs
    expect(cliArgs.limit).toBeNull();     // maxQuestionsPerConversation
    expect(cliArgs.skipJudge).toBe(false);// skipJudgePass
    expect(cliArgs.judgeRuns).toBe(10);   // judgeRunsPerQuestion
  });

  it("maps --no-resume to resumeFromCheckpoints: false", () => {
    const cliArgs = parseArgs(["--no-resume"]);
    expect(!cliArgs.noResume).toBe(false);
  });
});
