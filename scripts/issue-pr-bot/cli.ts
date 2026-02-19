#!/usr/bin/env npx tsx

import { runTriagePrototype } from "./index.ts";

interface CliArgs {
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  return {
    help: argv.includes("-h") || argv.includes("--help"),
  };
}

function printHelp(): void {
  console.log(`
issue-pr-bot prototype scaffold

USAGE:
  npx tsx scripts/issue-pr-bot/cli.ts

OPTIONS:
  -h, --help    Show this help text
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  const result = await runTriagePrototype();

  if (result.ingestion.warnings.length > 0) {
    for (const warning of result.ingestion.warnings) {
      console.warn(`WARN: ${warning}`);
    }
    console.warn("");
  }

  console.log(result.report.markdown);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`issue-pr-bot failed: ${message}`);
  process.exit(1);
});
