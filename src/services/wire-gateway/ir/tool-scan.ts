// SPDX-License-Identifier: Apache-2.0
//
// Whether a reply going to the agent asks it to run a tool, in any wire
// format (plan Phase 3 task 5). Ported from magpie `toolScan`
// (internal/gateway/turndone.go:151-209, MIT, Copyright (c) 2026 yetone):
// only a JSON *value* counts ("type":"tool_use"), never a key, since a Chat
// delta may hold "tool_calls":[] with no call; a string's escaped quotes
// (\"tool_use\") never match. Gemini's call is the key "functionCall": with
// a colon after it.

const TOOL_CALL_VALUES = [
  '"tool_use"', '"tool_calls"', '"function_call"',
  '"custom_tool_call"', '"local_shell_call"', '"shell_call"',
  '"apply_patch_call"', '"computer_call"', '"mcp_approval_request"',
];

const GEMINI_FUNCTION_CALL_KEY = '"functionCall"';

/** Longer than any value with its colon and spaces, so a value split across chunks is still seen. */
const TOOL_SCAN_CARRY_BYTES = 64;

const WHITESPACE = new Set([' ', '\t', '\r', '\n']);

function containsToolCall(text: string): boolean {
  for (const value of TOOL_CALL_VALUES) {
    for (let from = 0; ;) {
      const at = text.indexOf(value, from);
      if (at < 0) break;
      let before = at - 1;
      while (before >= 0 && WHITESPACE.has(text[before])) before--;
      if (before >= 0 && text[before] === ':') return true;
      from = at + 1;
    }
  }
  for (let from = 0; ;) {
    const at = text.indexOf(GEMINI_FUNCTION_CALL_KEY, from);
    if (at < 0) return false;
    let after = at + GEMINI_FUNCTION_CALL_KEY.length;
    while (after < text.length && WHITESPACE.has(text[after])) after++;
    if (after < text.length && text[after] === ':') return true;
    from = at + GEMINI_FUNCTION_CALL_KEY.length;
  }
}

/**
 * Fed each chunk of a reply. Latin-1 decoding keeps one char per byte, so the
 * 64-byte carry is exact and a split UTF-8 sequence can never hide an ASCII
 * marker (the same approach as StreamEndMarkerDetector).
 */
export class ToolCallScanner {
  private carry = '';
  calledTool = false;
  private readonly decoder = new TextDecoder('latin1');

  observe(chunk: Uint8Array): void {
    if (this.calledTool || chunk.length === 0) return;
    const text = this.carry + this.decoder.decode(chunk);
    this.calledTool = containsToolCall(text);
    this.carry = text.slice(-TOOL_SCAN_CARRY_BYTES);
  }
}
