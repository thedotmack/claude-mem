import { describe, expect, test } from "bun:test";
import { visibleClaudeRole } from "../../../src/services/history-import/native-sources.js";

describe("Claude Code native row provenance", () => {
  test("distinguishes explicitly typed rows from task notifications, tool scaffolding and compaction", () => {
    expect(
      visibleClaudeRole({ type: "user", origin: { kind: "human" } }, true),
    ).toBe("user");
    for (const row of [
      { type: "user", origin: { kind: "task-notification" } },
      { type: "user", origin: { kind: "human" }, isMeta: true },
      { type: "user", isCompactSummary: true },
      { type: "system", subtype: "compact_boundary" },
      { type: "attachment" },
      { type: "assistant", isSidechain: true },
      { type: "user" },
    ])
      expect(visibleClaudeRole(row, true)).toBeNull();
    expect(visibleClaudeRole({ type: "assistant" }, true)).toBe("assistant");
    expect(visibleClaudeRole({ type: "user" }, false)).toBe("user");
  });
});
