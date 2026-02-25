#!/usr/bin/env node

/**
 * Smart File Read — MCP Server
 *
 * Token-optimized semantic code search for Claude Code.
 * Returns folded structural views instead of raw file dumps.
 *
 * Tools:
 *   smart_search  — Search codebase, get folded structural view
 *   smart_unfold  — Expand a specific function/class to see implementation
 *   smart_outline — Get full structural outline of a single file
 *
 * Progressive disclosure: search → fold → unfold
 *
 * by Copter Labs
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { searchCodebase, formatSearchResults } from "./search.js";
import { parseFile, formatFoldedView, unfoldSymbol } from "./parser.js";

const server = new McpServer({
  name: "smart-file-read",
  version: "0.2.0",
});

// --- Tool: smart_search ---

server.registerTool(
  "smart_search",
  {
    title: "Smart Code Search",
    description: `Search a codebase and get token-optimized structural results.

Instead of returning raw file contents, returns a "folded" view:
- Function/class/method signatures
- JSDoc/docstring summaries
- File structure and hierarchy
- Import statements
- Line numbers for each symbol

This uses a fraction of the tokens compared to reading full files.
Use smart_unfold to expand specific functions when you need the implementation.

Args:
  - query: What to search for (function name, concept, class name)
  - path: Root directory to search (defaults to current working directory)
  - max_results: Maximum matching symbols to return (default: 20)
  - file_pattern: Optional filter to narrow search to specific files/paths

Returns: Folded structural view with matching symbols and file outlines.`,
    inputSchema: {
      query: z.string()
        .min(1, "Query must not be empty")
        .describe("Search query — function name, class name, concept, or keyword"),
      path: z.string()
        .default(".")
        .describe("Root directory to search (defaults to cwd)"),
      max_results: z.number()
        .int()
        .min(1)
        .max(50)
        .default(20)
        .describe("Maximum matching symbols to return"),
      file_pattern: z.string()
        .optional()
        .describe("Optional file path filter (e.g., 'utils' to only search files with 'utils' in path)"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (params) => {
    try {
      const rootDir = resolve(params.path);
      const result = await searchCodebase(rootDir, params.query, {
        maxResults: params.max_results,
        filePattern: params.file_pattern,
      });
      const formatted = formatSearchResults(result, params.query);

      return {
        content: [{ type: "text", text: formatted }],
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: `Error searching codebase: ${msg}` }],
        isError: true,
      };
    }
  }
);

// --- Tool: smart_unfold ---

server.registerTool(
  "smart_unfold",
  {
    title: "Smart Unfold",
    description: `Expand a specific function, class, or symbol to see its full implementation.

Use this after smart_search to "unfold" a symbol you want to examine.
Returns the complete source code including JSDoc/docstrings and decorators.

This is the progressive disclosure pattern:
  1. smart_search → see structure (cheap)
  2. smart_unfold → see implementation (targeted)

Args:
  - file_path: Path to the file (as returned by smart_search)
  - symbol_name: Name of the function/class/method to expand
  - path: Root directory (defaults to cwd, used to resolve relative file paths)

Returns: Full source code of the specified symbol with line numbers.`,
    inputSchema: {
      file_path: z.string()
        .min(1)
        .describe("Path to file (relative path as returned by smart_search)"),
      symbol_name: z.string()
        .min(1)
        .describe("Name of the symbol to unfold (function, class, method name)"),
      path: z.string()
        .default(".")
        .describe("Root directory to resolve relative paths from"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (params) => {
    try {
      const rootDir = resolve(params.path);
      const fullPath = resolve(rootDir, params.file_path);

      const content = await readFile(fullPath, "utf-8");
      const result = unfoldSymbol(content, params.file_path, params.symbol_name);

      if (!result) {
        // Try partial match
        const parsed = parseFile(content, params.file_path);
        const allSymbols: string[] = [];
        const collect = (symbols: typeof parsed.symbols) => {
          for (const sym of symbols) {
            allSymbols.push(`${sym.kind} ${sym.name} (L${sym.lineStart + 1})`);
            if (sym.children) collect(sym.children);
          }
        };
        collect(parsed.symbols);

        return {
          content: [{
            type: "text",
            text: `Symbol "${params.symbol_name}" not found in ${params.file_path}.\n\nAvailable symbols:\n${allSymbols.map(s => `  ${s}`).join("\n")}`,
          }],
        };
      }

      return {
        content: [{ type: "text", text: result }],
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: `Error unfolding symbol: ${msg}` }],
        isError: true,
      };
    }
  }
);

// --- Tool: smart_outline ---

server.registerTool(
  "smart_outline",
  {
    title: "Smart File Outline",
    description: `Get the full structural outline of a single file.

Returns a folded view of all symbols in the file without searching.
Useful when you know which file to examine but want the overview first.

Args:
  - file_path: Path to the file to outline
  - path: Root directory (defaults to cwd)

Returns: Complete structural outline with all functions, classes, methods, types.`,
    inputSchema: {
      file_path: z.string()
        .min(1)
        .describe("Path to the file to outline"),
      path: z.string()
        .default(".")
        .describe("Root directory to resolve relative paths from"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (params) => {
    try {
      const rootDir = resolve(params.path);
      const fullPath = resolve(rootDir, params.file_path);
      const relPath = relative(rootDir, fullPath);

      const content = await readFile(fullPath, "utf-8");
      const parsed = parseFile(content, relPath);
      const formatted = formatFoldedView(parsed);

      return {
        content: [{ type: "text", text: formatted }],
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: `Error reading file: ${msg}` }],
        isError: true,
      };
    }
  }
);

// --- Start server ---

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Smart File Read MCP server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
