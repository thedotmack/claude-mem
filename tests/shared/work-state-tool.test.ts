import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { WORK_STATE_WRITE_TOOL, CLAUDE_MEM_TOOL, isClaudeMemTool } from "../../src/shared/work-state-tool";

describe("shared claude-mem tool identity", () => {
  it("matches the real OpenCode V2 name and never work_state_read", () => {
    expect(WORK_STATE_WRITE_TOOL.test("claude-mem_work_state_write")).toBe(true); // effectiveName()
    expect(WORK_STATE_WRITE_TOOL.test("claude-mem.work_state_write")).toBe(true); // qualifiedName(), Code Mode
    expect(WORK_STATE_WRITE_TOOL.test("work_state_write")).toBe(true);
    expect(WORK_STATE_WRITE_TOOL.test("mcp__plugin_claude-mem_mcp-search__work_state_write")).toBe(true);
    expect(WORK_STATE_WRITE_TOOL.test("work_state_read")).toBe(false);
  });

  it("recognises every namespace form and internal tool", () => {
    expect(CLAUDE_MEM_TOOL.test("claude-mem.work_state_write")).toBe(true);
    expect(isClaudeMemTool("claude-mem_work_state_write")).toBe(true);
    expect(isClaudeMemTool("claude-mem.work_state_write")).toBe(true);
    expect(isClaudeMemTool("claude_mem_search")).toBe(true);
    expect(isClaudeMemTool("mcp__plugin_claude-mem_mcp-search__work_state_write")).toBe(true);
    expect(isClaudeMemTool("plugin_claude-mem_mcp-search_work_state_write")).toBe(true);
    expect(isClaudeMemTool("shell")).toBe(false);
  });

  it("covers every MCP tool the server actually advertises", () => {
    const source = readFileSync("src/servers/mcp-server.ts", "utf8");
    const names = [...source.matchAll(/name: ['"]([a-z_0-9]+)['"]/g)].map(m => m[1]);
    expect(names.length).toBeGreaterThanOrEqual(28);
    for (const known of ["dumb_search", "save_memory", "search", "timeline", "work_state_write", "work_state_read", "observation_add", "reprime_corpus"]) {
      expect(names).toContain(known);
    }
    // A bare MCP name carries no namespace: only work_state_write is intrinsically claude-mem.
    expect(isClaudeMemTool("work_state_write")).toBe(true);
    expect(isClaudeMemTool("search")).toBe(false);
    for (const name of names) {
      for (const prefix of ["claude-mem_", "claude-mem.", "mcp__plugin_claude-mem_mcp-search__"]) {
        expect(isClaudeMemTool(`${prefix}${name}`)).toBe(true);
      }
    }
  });

  it("leaves no second copy of the matcher in its two consumers", () => {
    for (const file of ["src/shared/deliverables-transcript.ts", "src/mods/auto-clear/controller.ts"]) {
      const source = readFileSync(file, "utf8");
      expect(source).not.toContain("/(?:^|__)work_state_write$/");
      expect(source).toContain("work-state-tool.js");
    }
    // register.ts imports the symbol from controller.ts; keep that export alive.
    expect(readFileSync("src/mods/auto-clear/controller.ts", "utf8")).toContain("export { WORK_STATE_WRITE_TOOL }");
  });
});
