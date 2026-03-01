import { describe, it, expect } from 'vitest';
import { readdir } from "fs/promises";
import { join, relative } from "path";
import { readFileSync } from "fs";

/**
 * Logger Usage Standards - Enforces coding standards for logging
 *
 * This test enforces logging standards by:
 * 1. Detecting console.log/console.error usage in background services (invisible logs)
 * 2. Ensuring high-priority service files import the logger
 * 3. Validating logger calls use valid Component string literals
 * 4. Reporting coverage statistics for observability
 *
 * Note: This is a legitimate coding standard enforcement test, not a coverage metric.
 */

const PROJECT_ROOT = join(import.meta.dirname, "..");
const SRC_DIR = join(PROJECT_ROOT, "src");

// Files/directories that don't require logging
const EXCLUDED_PATTERNS = [
  /types\//,             // Type definition files
  /types\.ts$/,          // Type definition files (nested, e.g. observations/types.ts)
  /constants\//,         // Pure constants
  /\.d\.ts$/,            // Type declaration files
  /^ui\//,               // UI components (separate logging context)
  /^bin\//,              // CLI utilities (may use console.log for output)
  /^scripts\//,          // Standalone CLI scripts (console.log for user output)
  /index\.ts$/,          // Re-export files
  /logger\.ts$/,         // Logger itself
  /hook-constants\.ts$/, // Pure constants
  /paths\.ts$/,          // Path utilities
  /sqlite-compat\.ts$/,  // Thin SQLite compatibility wrapper (no logging needed)
  /migrations\.ts$/,     // Database migrations (console.log for migration output)
  /worker-service\.ts$/, // CLI entry point with interactive setup wizard (console.log for user prompts)
  /integrations\/.*Installer\.ts$/, // CLI installer commands (console.log for interactive installation output)
  /SettingsDefaultsManager\.ts$/,  // Must use console.log to avoid circular dependency with logger
  /user-message-hook\.ts$/,  // Deprecated - kept for reference only, not registered in hooks.json
  /cli\/hook-command\.ts$/,  // CLI hook command uses console.log/error for hook protocol output
  /cli\/handlers\/user-message\.ts$/,  // User message handler uses console.error for user-visible context
  /sqlite\/Import\.ts$/,       // Thin facade re-exporting sqlite sub-modules
  /sqlite\/Observations\.ts$/, // Thin facade re-exporting sqlite sub-modules
  /sqlite\/Prompts\.ts$/,      // Thin facade re-exporting sqlite sub-modules
  /sqlite\/Sessions\.ts$/,     // Thin facade re-exporting sqlite sub-modules
  /sqlite\/Summaries\.ts$/,    // Thin facade re-exporting sqlite sub-modules
  /sqlite\/Timeline\.ts$/,     // Thin facade re-exporting sqlite sub-modules
  /sqlite\/\w+\/\w+\.ts$/,    // SQLite leaf modules (get.ts, store.ts, etc.) — pure DB queries
  /search\/filters\//,         // Pure filter functions with no error paths
  /search\/strategies\/SearchStrategy\.ts$/, // Interface/base class definition
  /FormattingService\.ts$/,    // Pure formatting with no error paths
  /TimelineService\.ts$/,      // Pure data transformation with no error paths
  /ResultFormatter\.ts$/,      // Pure data transformation with no error paths
  /TimelineBuilder\.ts$/,      // Pure data transformation with no error paths
  /context-generator\.ts$/,    // Pure data assembly with no error paths
  /search\/strategies\/scoring\.ts$/, // Pure math utility — min-max normalization and score blending, no error paths
];

// Files that should always use logger (core business logic)
// Excludes UI files, type files, and pure utilities
const HIGH_PRIORITY_PATTERNS = [
  /^services\/worker\/(?!.*types\.ts$)/,  // Worker services (not type files)
  /^services\/sqlite\/(?!types\.ts$|index\.ts$)/,  // SQLite services
  /^services\/sync\//,
  /^services\/context-generator\.ts$/,
  /^hooks\//,  // All src/hooks/* (NOT ui/hooks)
  /^sdk\/(?!.*types?\.ts$)/,  // SDK files (not type files)
  /^servers\/(?!.*types?\.ts$)/,  // Server files (not type files)
];

// Additional check: exclude UI files from high priority
const isUIFile = (path: string) => /^ui\//.test(path);

interface FileAnalysis {
  path: string;
  relativePath: string;
  hasLoggerImport: boolean;
  usesConsoleLog: boolean;
  consoleLogLines: number[];
  loggerCallCount: number;
  isHighPriority: boolean;
}

/**
 * Recursively find all TypeScript files in a directory
 */
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

/**
 * Check if a file should be excluded from logger requirements
 */
function shouldExclude(filePath: string): boolean {
  const relativePath = relative(SRC_DIR, filePath);
  return EXCLUDED_PATTERNS.some(pattern => pattern.test(relativePath));
}

/**
 * Check if a file is high priority for logging
 */
function isHighPriority(filePath: string): boolean {
  const relativePath = relative(SRC_DIR, filePath);

  // UI files are never high priority
  if (isUIFile(relativePath)) {
    return false;
  }

  return HIGH_PRIORITY_PATTERNS.some(pattern => pattern.test(relativePath));
}

/**
 * Analyze a single TypeScript file for logger usage
 */
function analyzeFile(filePath: string): FileAnalysis {
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  const relativePath = relative(PROJECT_ROOT, filePath);

  // Check for logger import (handles both .ts and .js extensions in import paths)
  const hasLoggerImport = /import\s+.*logger.*from\s+['"].*logger(\.(js|ts))?['"]/.test(content);

  // Find console.log/console.error usage with line numbers
  const consoleLogLines: number[] = [];
  lines.forEach((line, index) => {
    if (/console\.(log|error|warn|info|debug)/.test(line)) {
      consoleLogLines.push(index + 1);
    }
  });

  // Count logger method calls
  const loggerCallMatches = content.match(/logger\.(debug|info|warn|error|success|failure|timing|dataIn|dataOut|happyPathError)\(/g);
  const loggerCallCount = loggerCallMatches ? loggerCallMatches.length : 0;

  return {
    path: filePath,
    relativePath,
    hasLoggerImport,
    usesConsoleLog: consoleLogLines.length > 0,
    consoleLogLines,
    loggerCallCount,
    isHighPriority: isHighPriority(filePath),
  };
}

describe("Logger Usage Standards", () => {
  let allFiles: FileAnalysis[] = [];
  let relevantFiles: FileAnalysis[] = [];

  it("should scan all TypeScript files in src/", async () => {
    const files = await findTypeScriptFiles(SRC_DIR);
    allFiles = files.map(analyzeFile);
    relevantFiles = allFiles.filter(f => !shouldExclude(f.path));

    expect(allFiles.length).toBeGreaterThan(0);
    expect(relevantFiles.length).toBeGreaterThan(0);
  });

  // eslint-disable-next-line vitest/expect-expect -- uses throw Error as assertion
  it("should NOT use console.log/console.error (these logs are invisible in background services)", () => {
    // Only hook files can use console.log for their final output response
    // Everything else (services, workers, sqlite, etc.) runs in background - console.log is USELESS there
    const filesWithConsole = relevantFiles.filter(f => {
      const isHookFile = /^src\/hooks\//.test(f.relativePath);
      return f.usesConsoleLog && !isHookFile;
    });

    if (filesWithConsole.length > 0) {
      const report = filesWithConsole
        .map(f => `  ${f.relativePath}:${f.consoleLogLines.join(",")}`)
        .join("\n");

      throw new Error(
        `❌ CRITICAL: Found console.log/console.error in ${String(filesWithConsole.length)} background service file(s):\n${report}\n\n` +
        `These logs are INVISIBLE - they run in background processes where console output goes nowhere.\n` +
        `Replace with logger.debug/info/warn/error calls immediately.\n\n` +
        `Only hook files (src/hooks/*) should use console.log for their output response.`
      );
    }
  });

  // eslint-disable-next-line vitest/expect-expect -- uses throw Error as assertion
  it("should have logger coverage in high-priority files", () => {
    const highPriorityFiles = relevantFiles.filter(f => f.isHighPriority);
    const withoutLogger = highPriorityFiles.filter(f => !f.hasLoggerImport);

    if (withoutLogger.length > 0) {
      const report = withoutLogger
        .map(f => `  ${f.relativePath}`)
        .join("\n");

      throw new Error(
        `High-priority files missing logger import (${String(withoutLogger.length)}):\n${report}\n\n` +
        `These files should import and use logger for debugging and observability.`
      );
    }
  });

  // eslint-disable-next-line vitest/expect-expect -- uses throw Error as assertion
  it("should only use valid Component string literals in logger calls", () => {
    // Extract valid Component values from the logger source
    const loggerSource = readFileSync(join(SRC_DIR, "utils", "logger.ts"), "utf-8");
    const componentMatch = loggerSource.match(/export type Component\s*=\s*([\s\S]*?);/);
    if (!componentMatch) {
      throw new Error("Could not find Component type definition in logger.ts");
    }
    const validComponents = new Set(
      componentMatch[1].match(/'([^']+)'/g)?.map(s => s.replace(/'/g, '')) ?? []
    );

    // Scan all relevant files for logger calls with string literal components
    const loggerCallPattern = /logger\.(debug|info|warn|error|success|failure|timing|dataIn|dataOut|happyPathError)\(\s*'([^']+)'/g;
    const violations: string[] = [];

    for (const file of relevantFiles) {
      const content = readFileSync(file.path, "utf-8");
      const lines = content.split("\n");

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        let match;
        loggerCallPattern.lastIndex = 0;
        while ((match = loggerCallPattern.exec(line)) !== null) {
          const component = match[2];
          if (!validComponents.has(component)) {
            violations.push(`  ${file.relativePath}:${String(i + 1)} — logger.${match[1]}('${component}', ...) — '${component}' is not a valid Component`);
          }
        }
      }
    }

    if (violations.length > 0) {
      const validList = [...validComponents].sort().join(', ');
      throw new Error(
        `❌ Found ${String(violations.length)} logger call(s) with invalid Component string:\n${violations.join("\n")}\n\n` +
        `Valid Component values: ${validList}`
      );
    }
  });

  it("should report logger coverage statistics", () => {
    const withLogger = relevantFiles.filter(f => f.hasLoggerImport);
    const withoutLogger = relevantFiles.filter(f => !f.hasLoggerImport);
    const totalCalls = relevantFiles.reduce((sum, f) => sum + f.loggerCallCount, 0);

    const coverage = ((withLogger.length / relevantFiles.length) * 100).toFixed(1);

    console.log("\n📊 Logger Coverage Report:");
    console.log(`  Total files analyzed: ${String(relevantFiles.length)}`);
    console.log(`  Files with logger: ${String(withLogger.length)} (${coverage}%)`);
    console.log(`  Files without logger: ${String(withoutLogger.length)}`);
    console.log(`  Total logger calls: ${String(totalCalls)}`);
    console.log(`  Excluded files: ${String(allFiles.length - relevantFiles.length)}`);

    if (withoutLogger.length > 0) {
      console.log("\n📝 Files without logger:");
      withoutLogger.forEach(f => {
        const priority = f.isHighPriority ? "🔴 HIGH" : "  ";
        console.log(`  ${priority} ${f.relativePath}`);
      });
    }

    // This is an informational test - we expect some files won't need logging
    expect(withLogger.length).toBeGreaterThan(0);
  });
});
