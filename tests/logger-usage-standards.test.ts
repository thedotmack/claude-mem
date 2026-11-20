import { describe, it, expect } from "bun:test";
import { readdir } from "fs/promises";
import { join, relative } from "path";
import { readFileSync } from "fs";

const PROJECT_ROOT = join(import.meta.dir, "..");
const SRC_DIR = join(PROJECT_ROOT, "src");

const EXCLUDED_PATTERNS = [
  /^ui\//,               // UI components (separate logging context)
  /index\.ts$/,          // Re-export files
  /integrations\/opencode-plugin\//,  // OpenCode plugin bundle: must stay free of worker-only imports (logger pulls in settings-document/hook-io), so it logs to the host's console; only the entry index.ts was excluded before the v1/v2 split
  /logger\.ts$/,         // Logger itself
  /worker-service\.ts$/, // CLI entry point with interactive setup wizard (console.log for user prompts)
  /integrations\/.*Installer\.ts$/, // CLI installer commands (console.log for interactive installation output)
  /SettingsDefaultsManager\.ts$/,  // Must use console.log to avoid circular dependency with logger
  /cli\/run-hook-subcommand\.ts$/,  // `claude-mem hook` usage text on missing args, printed before the hook IO window opens (moved from worker-service.ts)
  /shared\/hook-io\.ts$/,  // Canonical hook-protocol IO module: console.log emits MODEL_CONTEXT JSON to stdout (plan 01 / #2292)
  /services\/transcripts\/cli\.ts$/,  // CLI transcript subcommands use console.log for user-visible interactive output
  /services\/memory\/cli\.ts$/,  // CLI `memory ingest` prints its dry-run and import report to the user's terminal
  /services\/transcripts\/transcript-watcher-entry\.ts$/,  // CLI process entry point: console.error on fatal startup error goes to a visible stderr (own process, not a background service)
  /npx-cli\/commands\//,  // npx CLI subcommands (install/uninstall/runtime/server/etc) emit user-visible terminal output
  /npx-cli\/install\//,  // npx CLI install-time modules (error-reporter/setup-runtime/etc) emit user-visible terminal output during `npx claude-mem install`
  /npx-cli\/banner\.ts$/,  // npx CLI banner animation runs only on an interactive TTY; console.warn on frame-decode failure is user-visible terminal output
  /server\/runtime\/ServerService\.ts$/,  // server CLI entry point (status/usage output, process.exit)
  /integrations\/McpIntegrations\.ts$/,  // CLI installer for MCP integrations (interactive install output)
  /media\/smoke\.ts$/,  // `worker-service media-smoke` prints its one JSON result line to the terminal for the binary smoke check
];

interface FileAnalysis {
  path: string;
  relativePath: string;
  usesConsoleLog: boolean;
  consoleLogLines: number[];
}

async function findTypeScriptFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await findTypeScriptFiles(fullPath)));
    } else if (entry.isFile() && /\.ts$/.test(entry.name)) {
      files.push(fullPath);
    }
  }

  return files;
}

function shouldExclude(filePath: string): boolean {
  const relativePath = relative(SRC_DIR, filePath).replaceAll("\\", "/");
  return EXCLUDED_PATTERNS.some(pattern => pattern.test(relativePath));
}

function analyzeFile(filePath: string): FileAnalysis {
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  const relativePath = relative(PROJECT_ROOT, filePath).replaceAll("\\", "/");

  const consoleLogLines: number[] = [];
  lines.forEach((line, index) => {
    if (/console\.(log|error|warn|info|debug)/.test(line)) {
      consoleLogLines.push(index + 1);
    }
  });

  return {
    path: filePath,
    relativePath,
    usesConsoleLog: consoleLogLines.length > 0,
    consoleLogLines,
  };
}

const allFiles = (await findTypeScriptFiles(SRC_DIR)).map(analyzeFile);
const relevantFiles = allFiles.filter(f => !shouldExclude(f.path));

describe("Logger Usage Standards", () => {
  it("should scan all TypeScript files in src/", () => {
    expect(allFiles.length).toBeGreaterThan(0);
    expect(relevantFiles.length).toBeGreaterThan(0);
  });

  it("should NOT use console.log/console.error (these logs are invisible in background services)", () => {
    const filesWithConsole = relevantFiles.filter(f => {
      const isHookFile = /^src\/hooks\//.test(f.relativePath);
      return f.usesConsoleLog && !isHookFile;
    });

    if (filesWithConsole.length > 0) {
      const report = filesWithConsole
        .map(f => `  ${f.relativePath}:${f.consoleLogLines.join(",")}`)
        .join("\n");

      throw new Error(
        `❌ CRITICAL: Found console.log/console.error in ${filesWithConsole.length} background service file(s):\n${report}\n\n` +
        `These logs are INVISIBLE - they run in background processes where console output goes nowhere.\n` +
        `Replace with logger.debug/info/warn/error calls immediately.\n\n` +
        `Only hook files (src/hooks/*) should use console.log for their output response.`
      );
    }
  });
});
