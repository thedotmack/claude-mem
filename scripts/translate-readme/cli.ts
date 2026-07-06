#!/usr/bin/env bun

import { parseArgs } from "node:util";
import { translateReadme, SUPPORTED_LANGUAGES } from "./index.ts";

interface CliArgs {
  source: string;
  languages: string[];
  outputDir?: string;
  pattern?: string;
  preserveCode: boolean;
  model?: string;
  maxBudget?: number;
  verbose: boolean;
  force: boolean;
  useExisting: boolean;
  help: boolean;
  listLanguages: boolean;
}

function printHelp(): void {
  console.log(`
readme-translator - Translate README.md files using Claude Agent SDK

AUTHENTICATION:
  If Claude Code is installed and authenticated (Pro/Max subscription),
  no API key is needed. Otherwise, set ANTHROPIC_API_KEY environment variable.

USAGE:
  translate-readme [options] <source> <languages...>
  translate-readme --help
  translate-readme --list-languages

ARGUMENTS:
  source          Path to the source README.md file
  languages       Target language codes (e.g., es fr de ja zh)

OPTIONS:
  -o, --output <dir>      Output directory (default: same as source)
  -p, --pattern <pat>     Output filename pattern (default: README.{lang}.md)
  --no-preserve-code      Translate code blocks too (not recommended)
  -m, --model <model>     Claude model to use (default: sonnet)
  --max-budget <usd>      Maximum budget in USD
  --use-existing          Use existing translation file as a reference
  -v, --verbose           Show detailed progress
  -f, --force             Force re-translation ignoring cache
  -h, --help              Show this help message
  --list-languages        List all supported language codes

EXAMPLES:
  # Translate to Spanish and French (runs in parallel automatically)
  translate-readme README.md es fr

  # Translate to multiple languages with custom output
  translate-readme -v -o ./i18n --pattern docs.{lang}.md README.md de ja ko zh

  # Use in npm scripts
  # package.json: "translate": "translate-readme README.md es fr de"

PERFORMANCE:
  All translations run in parallel automatically (up to 10 concurrent).
  Cache prevents re-translating unchanged files.

SUPPORTED LANGUAGES:
  Run with --list-languages to see all supported language codes
`);
}

function printLanguages(): void {
  const LANGUAGE_NAMES: Record<string, string> = {
    zh: "Chinese (Simplified)",
    ja: "Japanese",
    "pt-br": "Brazilian Portuguese",
    ko: "Korean",
    es: "Spanish",
    de: "German",
    fr: "French",
    he: "Hebrew",
    ar: "Arabic",
    ru: "Russian",
    pl: "Polish",
    cs: "Czech",
    nl: "Dutch",
    tr: "Turkish",
    uk: "Ukrainian",
    vi: "Vietnamese",
    id: "Indonesian",
    th: "Thai",
    hi: "Hindi",
    bn: "Bengali",
    ur: "Urdu",
    ro: "Romanian",
    sv: "Swedish",
    it: "Italian",
    el: "Greek",
    hu: "Hungarian",
    fi: "Finnish",
    da: "Danish",
    no: "Norwegian",
    bg: "Bulgarian",
    et: "Estonian",
    lt: "Lithuanian",
    lv: "Latvian",
    pt: "Portuguese",
    sk: "Slovak",
    sl: "Slovenian",
    "zh-tw": "Chinese (Traditional)",
  };

  console.log("\nSupported Language Codes:\n");
  const sorted = Object.entries(LANGUAGE_NAMES).sort((a, b) =>
    a[1].localeCompare(b[1])
  );
  for (const [code, name] of sorted) {
    console.log(`  ${code.padEnd(8)} ${name}`);
  }
  console.log("");
}

function parseCliArgs(argv: string[]): CliArgs {
  try {
    const { values, positionals } = parseArgs({
      args: argv.slice(2),
      allowPositionals: true,
      options: {
        help: { type: "boolean", short: "h", default: false },
        "list-languages": { type: "boolean", default: false },
        verbose: { type: "boolean", short: "v", default: false },
        force: { type: "boolean", short: "f", default: false },
        "use-existing": { type: "boolean", default: false },
        "no-preserve-code": { type: "boolean", default: false },
        output: { type: "string", short: "o" },
        pattern: { type: "string", short: "p" },
        model: { type: "string", short: "m" },
        "max-budget": { type: "string" },
      },
    });

    return {
      source: positionals[0] ?? "",
      languages: positionals.slice(1),
      outputDir: values.output,
      pattern: values.pattern,
      preserveCode: !values["no-preserve-code"],
      model: values.model,
      maxBudget:
        values["max-budget"] !== undefined
          ? parseFloat(values["max-budget"])
          : undefined,
      verbose: values.verbose,
      force: values.force,
      useExisting: values["use-existing"],
      help: values.help,
      listLanguages: values["list-languages"],
    };
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv);

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  if (args.listLanguages) {
    printLanguages();
    process.exit(0);
  }

  if (!args.source) {
    console.error("Error: No source file specified");
    console.error("Run with --help for usage information");
    process.exit(1);
  }

  if (args.languages.length === 0) {
    console.error("Error: No target languages specified");
    console.error("Run with --help for usage information");
    process.exit(1);
  }

  const invalidLangs = args.languages.filter(
    (lang) => !SUPPORTED_LANGUAGES.includes(lang.toLowerCase())
  );
  if (invalidLangs.length > 0) {
    console.error(`Error: Unknown language codes: ${invalidLangs.join(", ")}`);
    console.error("Run with --list-languages to see supported codes");
    process.exit(1);
  }

  try {
    const result = await translateReadme({
      source: args.source,
      languages: args.languages,
      outputDir: args.outputDir,
      pattern: args.pattern,
      preserveCode: args.preserveCode,
      model: args.model,
      maxBudgetUsd: args.maxBudget,
      verbose: args.verbose,
      force: args.force,
      useExisting: args.useExisting,
    });

    if (result.failed > 0) {
      process.exit(1);
    }
  } catch (error) {
    console.error(
      "Translation failed:",
      error instanceof Error ? error.message : error
    );
    process.exit(1);
  }
}

main();
