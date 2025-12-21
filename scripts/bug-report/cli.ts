#!/usr/bin/env npx tsx

import { generateBugReport } from "./index.ts";
import { collectDiagnostics } from "./collector.ts";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import * as readline from "readline";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

interface CliArgs {
  output?: string;
  verbose: boolean;
  noLogs: boolean;
  help: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const parsed: CliArgs = {
    verbose: false,
    noLogs: false,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "-h":
      case "--help":
        parsed.help = true;
        break;
      case "-v":
      case "--verbose":
        parsed.verbose = true;
        break;
      case "--no-logs":
        parsed.noLogs = true;
        break;
      case "-o":
      case "--output":
        parsed.output = args[++i];
        break;
    }
  }

  return parsed;
}

function printHelp(): void {
  console.log(`
bug-report - Generate bug reports for claude-mem

USAGE:
  npm run bug-report [options]

OPTIONS:
  -o, --output <file>    Save report to file (default: stdout + timestamped file)
  -v, --verbose          Show all collected diagnostics
  --no-logs              Skip log collection (for privacy)
  -h, --help             Show this help message

DESCRIPTION:
  This script collects system diagnostics, prompts you for issue details,
  and generates a formatted GitHub issue for claude-mem using the Claude Agent SDK.

  The generated report will be saved to ~/bug-report-YYYY-MM-DD-HHMMSS.md
  and displayed in your terminal for easy copy-pasting to GitHub.

EXAMPLES:
  # Generate a bug report interactively
  npm run bug-report

  # Generate without including logs (for privacy)
  npm run bug-report --no-logs

  # Save to a specific file
  npm run bug-report --output ~/my-bug-report.md

  # Show all diagnostic details during collection
  npm run bug-report --verbose
`);
}

async function promptUser(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function promptMultiline(prompt: string): Promise<string> {
  console.log(prompt);
  console.log("(Press Enter on an empty line to finish)\n");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const lines: string[] = [];

  return new Promise((resolve) => {
    rl.on("line", (line) => {
      // Empty line means we're done
      if (line.trim() === "" && lines.length > 0) {
        rl.close();
        resolve(lines.join("\n"));
      } else if (line.trim() !== "") {
        // Only add non-empty lines (or preserve empty lines in the middle)
        lines.push(line);
      }
    });

    rl.on("close", () => {
      resolve(lines.join("\n"));
    });
  });
}

async function main() {
  const args = parseArgs();

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  console.log("🌎 Leave report in ANY language, and it will auto translate to English\n");
  console.log("🔍 Collecting system diagnostics...");

  // Collect diagnostics
  const diagnostics = await collectDiagnostics({
    includeLogs: !args.noLogs,
  });

  console.log("✓ Version information collected");
  console.log("✓ Platform details collected");
  console.log("✓ Worker status checked");
  if (!args.noLogs) {
    console.log(
      `✓ Logs extracted (last ${diagnostics.logs.workerLog.length + diagnostics.logs.silentLog.length} lines)`
    );
  }
  console.log("✓ Configuration loaded\n");

  // Show summary
  console.log("📋 System Summary:");
  console.log(`   Claude-mem: v${diagnostics.versions.claudeMem}`);
  console.log(`   Claude Code: ${diagnostics.versions.claudeCode}`);
  console.log(
    `   Platform: ${diagnostics.platform.osVersion} (${diagnostics.platform.arch})`
  );
  console.log(
    `   Worker: ${diagnostics.worker.running ? `Running (PID ${diagnostics.worker.pid}, port ${diagnostics.worker.port})` : "Not running"}\n`
  );

  if (args.verbose) {
    console.log("📊 Detailed Diagnostics:");
    console.log(JSON.stringify(diagnostics, null, 2));
    console.log();
  }

  // Prompt for issue details
  const issueDescription = await promptMultiline(
    "Please describe the issue you're experiencing:"
  );

  if (!issueDescription.trim()) {
    console.error("❌ Issue description is required");
    process.exit(1);
  }

  console.log();
  const expectedBehavior = await promptMultiline(
    "Expected behavior (leave blank to skip):"
  );

  console.log();
  const stepsToReproduce = await promptMultiline(
    "Steps to reproduce (leave blank to skip):"
  );

  console.log();
  const confirm = await promptUser(
    "Generate bug report? (y/n): "
  );

  if (confirm.toLowerCase() !== "y" && confirm.toLowerCase() !== "yes") {
    console.log("❌ Bug report generation cancelled");
    process.exit(0);
  }

  console.log("\n🤖 Generating bug report with Claude...");

  // Generate the bug report
  const result = await generateBugReport({
    issueDescription,
    expectedBehavior: expectedBehavior.trim() || undefined,
    stepsToReproduce: stepsToReproduce.trim() || undefined,
    includeLogs: !args.noLogs,
  });

  if (!result.success) {
    console.error("❌ Failed to generate bug report:", result.error);
    process.exit(1);
  }

  console.log("✓ Issue formatted successfully\n");

  // Generate output file path
  const timestamp = new Date()
    .toISOString()
    .replace(/:/g, "")
    .replace(/\..+/, "")
    .replace("T", "-");
  const defaultOutputPath = path.join(
    os.homedir(),
    `bug-report-${timestamp}.md`
  );
  const outputPath = args.output || defaultOutputPath;

  // Save to file
  await fs.writeFile(outputPath, result.body, "utf-8");

  // Build GitHub URL with pre-filled title and body
  const encodedTitle = encodeURIComponent(result.title);
  const encodedBody = encodeURIComponent(result.body);
  const githubUrl = `https://github.com/thedotmack/claude-mem/issues/new?title=${encodedTitle}&body=${encodedBody}`;

  // Display the report
  console.log("─".repeat(60));
  console.log("📋 BUG REPORT GENERATED");
  console.log("─".repeat(60));
  console.log();
  console.log(result.body);
  console.log();
  console.log("─".repeat(60));
  console.log("Suggested labels: bug, needs-triage");
  console.log(`Report saved to: ${outputPath}`);
  console.log("─".repeat(60));
  console.log();

  // Open GitHub issue in browser
  console.log("🌐 Opening GitHub issue form in your browser...");
  try {
    const openCommand =
      process.platform === "darwin"
        ? "open"
        : process.platform === "win32"
          ? "start"
          : "xdg-open";

    await execAsync(`${openCommand} "${githubUrl}"`);
    console.log("✓ Browser opened successfully");
  } catch (error) {
    console.error("❌ Failed to open browser. Please visit:");
    console.error(githubUrl);
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
