#!/usr/bin/env npx tsx

import * as path from "path";
import { fileURLToPath } from "url";
import { runTriagePrototype } from "./index.ts";
import { buildTerminalSummary, renderTerminalSummary } from "./summary.ts";

interface CliArgs {
  help: boolean;
  outputRootDir?: string;
  maxTopItems: number;
}

function parseArgs(argv: string[]): CliArgs {
  const parsed: CliArgs = {
    help: false,
    maxTopItems: 5,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "-h":
      case "--help":
        parsed.help = true;
        break;
      case "--output-root":
        parsed.outputRootDir = argv[index + 1];
        index += 1;
        break;
      case "--max-top": {
        const value = Number.parseInt(argv[index + 1] ?? "", 10);
        if (Number.isFinite(value) && value > 0) {
          parsed.maxTopItems = value;
        }
        index += 1;
        break;
      }
      default:
        break;
    }
  }

  return parsed;
}

function printHelp(): void {
  console.log(`
issue-pr-bot prototype

USAGE:
  npm run issue-pr-bot:prototype [-- --output-root <dir> --max-top <count>]
  npx tsx scripts/issue-pr-bot/cli.ts [--output-root <dir> --max-top <count>]

OPTIONS:
  -h, --help             Show this help text
  --output-root <dir>    Override artifact output root (default: docs/triage)
  --max-top <count>      Number of top priorities to print (default: 5)
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  const result = await runTriagePrototype({
    outputRootDir: args.outputRootDir,
    writeArtifacts: true,
  });

  if (result.ingestion.warnings.length > 0) {
    for (const warning of result.ingestion.warnings) {
      console.warn(`WARN: ${warning}`);
    }
    console.warn("");
  }

  const summary = buildTerminalSummary(result.report, {
    maxTopItems: args.maxTopItems,
  });
  console.log(renderTerminalSummary(summary));

  if (result.report.artifacts) {
    console.log("");
    console.log(`Run report: ${result.report.artifacts.runReportPath}`);
    console.log(`Snapshot: ${result.report.artifacts.snapshotPath}`);
    console.log(
      `Issue artifacts: ${result.report.artifacts.issueItemPaths.length}`
    );
    console.log(`PR artifacts: ${result.report.artifacts.prItemPaths.length}`);
  }
}

function isMainModule(): boolean {
  if (!process.argv[1]) {
    return false;
  }

  const currentFilePath = fileURLToPath(import.meta.url);
  return path.resolve(process.argv[1]) === currentFilePath;
}

if (isMainModule()) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`issue-pr-bot failed: ${message}`);
    process.exit(1);
  });
}
