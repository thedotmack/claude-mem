#!/usr/bin/env npx tsx

import * as fs from "fs";
import * as path from "path";
import { runTriagePrototype } from "./index.ts";
import type { NormalizedItem, TriageConfig } from "./types.ts";

const REPORT_OUTPUT_DIR = path.join(
  "Auto Run Docs",
  "Initiation",
  "Working"
);
const REPORT_OUTPUT_FILENAME = "triage-report-raw.md";

interface CliArgs {
  help: boolean;
  dryRun: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  return {
    help: argv.includes("-h") || argv.includes("--help"),
    dryRun: argv.includes("--dry-run"),
  };
}

function printHelp(): void {
  console.log(`
issue-pr-bot prototype scaffold

USAGE:
  npx tsx scripts/issue-pr-bot/cli.ts

OPTIONS:
  -h, --help    Show this help text
  --dry-run     Skip GitHub fetch and use empty scaffold data
`);
}

async function emptyFetcher(_config: TriageConfig): Promise<NormalizedItem[]> {
  return [];
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  const result = await runTriagePrototype({
    writeArtifacts: false,
    ...(args.dryRun
      ? { ingestionDependencies: { fetchOpenItems: emptyFetcher } }
      : {}),
  });

  if (result.ingestion.warnings.length > 0) {
    for (const warning of result.ingestion.warnings) {
      console.warn(`WARN: ${warning}`);
    }
    console.warn("");
  }

  console.log(result.report.markdown);

  const outputFilePath = path.resolve(REPORT_OUTPUT_DIR, REPORT_OUTPUT_FILENAME);
  fs.mkdirSync(REPORT_OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(outputFilePath, result.report.markdown, "utf-8");
  console.error(`Report written to: ${outputFilePath}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`issue-pr-bot failed: ${message}`);
  process.exit(1);
});
