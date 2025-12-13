/**
 * Example: Using readme-translator in build scripts
 *
 * These examples show how to integrate the translator into your build pipeline.
 */

import { translateReadme, TranslationJobResult, SUPPORTED_LANGUAGES } from "./index.js";

// Example 1: Simple usage - translate to a few common languages
async function translateToCommonLanguages(): Promise<void> {
  const result = await translateReadme({
    source: "./README.md",
    languages: ["es", "fr", "de", "ja", "zh"],
    verbose: true,
  });

  console.log(`Translated to ${result.successful} languages`);
}

// Example 2: Full i18n setup with custom output directory
async function fullI18nSetup(): Promise<void> {
  const result = await translateReadme({
    source: "./README.md",
    languages: ["es", "fr", "de", "it", "pt", "ja", "ko", "zh", "ru", "ar"],
    outputDir: "./docs/i18n",
    pattern: "README.{lang}.md",
    preserveCode: true,
    model: "sonnet",
    maxBudgetUsd: 5.0, // Cap spending at $5
    verbose: true,
  });

  // Handle results programmatically
  for (const r of result.results) {
    if (!r.success) {
      console.error(`Failed to translate to ${r.language}: ${r.error}`);
    }
  }
}

// Example 3: Build script integration with error handling
// Note: If Claude Code is authenticated, no API key needed locally.
// CI/CD environments will need ANTHROPIC_API_KEY set.
async function buildScriptIntegration(): Promise<number> {
  try {
    const result = await translateReadme({
      source: process.env.README_PATH || "./README.md",
      languages: (process.env.TRANSLATE_LANGS || "es,fr,de").split(","),
      outputDir: process.env.I18N_OUTPUT || "./i18n",
      verbose: process.env.CI !== "true", // Quiet in CI
    });

    // Return exit code for build scripts
    return result.failed > 0 ? 1 : 0;
  } catch (error) {
    console.error("Translation failed:", error);
    return 1;
  }
}

// Example 4: Batch translation of multiple READMEs
async function batchTranslation(): Promise<void> {
  const readmes = [
    "./README.md",
    "./packages/core/README.md",
    "./packages/cli/README.md",
  ];

  const languages = ["es", "fr", "de"];

  for (const readme of readmes) {
    console.log(`\nProcessing: ${readme}`);
    await translateReadme({
      source: readme,
      languages,
      verbose: true,
    });
  }
}

// Example 5: Custom output pattern for docs sites
async function docsiteSetup(): Promise<void> {
  // For docusaurus/vitepress style: docs/README.es.md
  await translateReadme({
    source: "./README.md",
    languages: ["es", "fr", "de", "ja", "zh"],
    outputDir: "./docs",
    pattern: "README.{lang}.md",
    verbose: true,
  });
}

// Example 6: Conditional translation in CI/CD
async function cicdTranslation(): Promise<void> {
  // Only translate on main branch releases
  const isRelease = process.env.GITHUB_REF === "refs/heads/main";
  const isManualTrigger = process.env.GITHUB_EVENT_NAME === "workflow_dispatch";

  if (!isRelease && !isManualTrigger) {
    console.log("Skipping translation - not a release build");
    return;
  }

  const result = await translateReadme({
    source: "./README.md",
    languages: ["es", "fr", "de", "ja", "ko", "zh", "pt-br"],
    outputDir: "./dist/i18n",
    maxBudgetUsd: 10.0,
    verbose: true,
  });

  // Write summary for GitHub Actions
  if (process.env.GITHUB_STEP_SUMMARY) {
    const summary = `
## Translation Summary
- ✅ Successful: ${result.successful}
- ❌ Failed: ${result.failed}
- 💰 Cost: $${result.totalCostUsd.toFixed(4)}
`;
    // In real usage, write to GITHUB_STEP_SUMMARY
    console.log(summary);
  }
}

// Run an example
const example = process.argv[2];

switch (example) {
  case "simple":
    translateToCommonLanguages();
    break;
  case "full":
    fullI18nSetup();
    break;
  case "batch":
    batchTranslation();
    break;
  case "docs":
    docsiteSetup();
    break;
  case "ci":
    cicdTranslation();
    break;
  default:
    console.log("Available examples: simple, full, batch, docs, ci");
    console.log("\nSupported languages:", SUPPORTED_LANGUAGES.join(", "));
}
