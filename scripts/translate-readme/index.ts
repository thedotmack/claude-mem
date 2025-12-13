import { query, type SDKMessage, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import * as fs from "fs/promises";
import * as path from "path";

export interface TranslationOptions {
  /** Source README file path */
  source: string;
  /** Target languages (e.g., ['es', 'fr', 'de', 'ja', 'zh']) */
  languages: string[];
  /** Output directory (defaults to same directory as source) */
  outputDir?: string;
  /** Output filename pattern (use {lang} placeholder, defaults to 'README.{lang}.md') */
  pattern?: string;
  /** Preserve code blocks without translation */
  preserveCode?: boolean;
  /** Model to use (defaults to 'sonnet') */
  model?: string;
  /** Maximum budget in USD for the entire translation job */
  maxBudgetUsd?: number;
  /** Verbose output */
  verbose?: boolean;
}

export interface TranslationResult {
  language: string;
  outputPath: string;
  success: boolean;
  error?: string;
  costUsd?: number;
}

export interface TranslationJobResult {
  results: TranslationResult[];
  totalCostUsd: number;
  successful: number;
  failed: number;
}

const LANGUAGE_NAMES: Record<string, string> = {
  ar: "Arabic",
  bg: "Bulgarian",
  cs: "Czech",
  da: "Danish",
  de: "German",
  el: "Greek",
  es: "Spanish",
  et: "Estonian",
  fi: "Finnish",
  fr: "French",
  he: "Hebrew",
  hi: "Hindi",
  hu: "Hungarian",
  id: "Indonesian",
  it: "Italian",
  ja: "Japanese",
  ko: "Korean",
  lt: "Lithuanian",
  lv: "Latvian",
  nl: "Dutch",
  no: "Norwegian",
  pl: "Polish",
  pt: "Portuguese",
  "pt-br": "Brazilian Portuguese",
  ro: "Romanian",
  ru: "Russian",
  sk: "Slovak",
  sl: "Slovenian",
  sv: "Swedish",
  th: "Thai",
  tr: "Turkish",
  uk: "Ukrainian",
  vi: "Vietnamese",
  zh: "Chinese (Simplified)",
  "zh-tw": "Chinese (Traditional)",
};

function getLanguageName(code: string): string {
  return LANGUAGE_NAMES[code.toLowerCase()] || code;
}

async function translateToLanguage(
  content: string,
  targetLang: string,
  options: Pick<TranslationOptions, "preserveCode" | "model" | "verbose">
): Promise<{ translation: string; costUsd: number }> {
  const languageName = getLanguageName(targetLang);

  const preserveCodeInstructions = options.preserveCode
    ? `
IMPORTANT: Preserve all code blocks exactly as they are. Do NOT translate:
- Code inside \`\`\` blocks
- Inline code inside \` backticks
- Command examples
- File paths
- Variable names, function names, and technical identifiers
- URLs and links
`
    : "";

  const prompt = `Translate the following README.md content from English to ${languageName} (${targetLang}).

${preserveCodeInstructions}
Guidelines:
- Maintain all Markdown formatting (headers, lists, links, etc.)
- Keep the same document structure
- Translate headings, descriptions, and explanatory text naturally
- Preserve technical accuracy
- Use appropriate technical terminology for ${languageName}
- Keep proper nouns (product names, company names) unchanged unless they have official translations

Here is the README content to translate:

---
${content}
---

Output ONLY the translated README content, nothing else. Do not include any preamble or explanation.`;

  let translation = "";
  let costUsd = 0;
  let charCount = 0;
  const startTime = Date.now();

  const stream = query({
    prompt,
    options: {
      model: options.model || "sonnet",
      systemPrompt: `You are an expert technical translator specializing in software documentation.
You translate README files while preserving Markdown formatting and technical accuracy.
Always output only the translated content without any surrounding explanation.`,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      includePartialMessages: true, // Enable streaming events
    },
  });

  // Progress spinner frames
  const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let spinnerIdx = 0;

  for await (const message of stream) {
    // Handle streaming text deltas
    if (message.type === "stream_event") {
      const event = message.event as { type: string; delta?: { type: string; text?: string } };
      if (event.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) {
        translation += event.delta.text;
        charCount += event.delta.text.length;

        if (options.verbose) {
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          const spinner = spinnerFrames[spinnerIdx++ % spinnerFrames.length];
          process.stdout.write(`\r   ${spinner} Translating... ${charCount} chars (${elapsed}s)`);
        }
      }
    }

    // Handle full assistant messages (fallback)
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "text" && !translation) {
          translation = block.text;
          charCount = translation.length;
        }
      }
    }

    if (message.type === "result") {
      const result = message as SDKResultMessage;
      if (result.subtype === "success") {
        costUsd = result.total_cost_usd;
        // Use the result text if we didn't get it from streaming
        if (!translation && result.result) {
          translation = result.result;
          charCount = translation.length;
        }
      }
    }
  }

  // Clear the progress line
  if (options.verbose) {
    process.stdout.write("\r" + " ".repeat(60) + "\r");
  }

  return { translation: translation.trim(), costUsd };
}

export async function translateReadme(
  options: TranslationOptions
): Promise<TranslationJobResult> {
  const {
    source,
    languages,
    outputDir,
    pattern = "README.{lang}.md",
    preserveCode = true,
    model,
    maxBudgetUsd,
    verbose = false,
  } = options;

  // Read source file
  const sourcePath = path.resolve(source);
  const content = await fs.readFile(sourcePath, "utf-8");

  // Determine output directory
  const outDir = outputDir ? path.resolve(outputDir) : path.dirname(sourcePath);
  await fs.mkdir(outDir, { recursive: true });

  const results: TranslationResult[] = [];
  let totalCostUsd = 0;

  if (verbose) {
    console.log(`📖 Source: ${sourcePath}`);
    console.log(`📂 Output: ${outDir}`);
    console.log(`🌍 Languages: ${languages.join(", ")}`);
    console.log("");
  }

  for (const lang of languages) {
    // Check budget
    if (maxBudgetUsd && totalCostUsd >= maxBudgetUsd) {
      results.push({
        language: lang,
        outputPath: "",
        success: false,
        error: "Budget exceeded",
      });
      continue;
    }

    const outputFilename = pattern.replace("{lang}", lang);
    const outputPath = path.join(outDir, outputFilename);

    if (verbose) {
      console.log(`🔄 Translating to ${getLanguageName(lang)} (${lang})...`);
    }

    try {
      const { translation, costUsd } = await translateToLanguage(content, lang, {
        preserveCode,
        model,
        verbose,
      });

      await fs.writeFile(outputPath, translation, "utf-8");
      totalCostUsd += costUsd;

      results.push({
        language: lang,
        outputPath,
        success: true,
        costUsd,
      });

      if (verbose) {
        console.log(`   ✅ Saved to ${outputFilename} ($${costUsd.toFixed(4)})`);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      results.push({
        language: lang,
        outputPath,
        success: false,
        error: errorMessage,
      });

      if (verbose) {
        console.log(`   ❌ Failed: ${errorMessage}`);
      }
    }
  }

  const successful = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;

  if (verbose) {
    console.log("");
    console.log(`📊 Summary: ${successful} succeeded, ${failed} failed`);
    console.log(`💰 Total cost: $${totalCostUsd.toFixed(4)}`);
  }

  return {
    results,
    totalCostUsd,
    successful,
    failed,
  };
}

// Export language codes for convenience
export const SUPPORTED_LANGUAGES = Object.keys(LANGUAGE_NAMES);
