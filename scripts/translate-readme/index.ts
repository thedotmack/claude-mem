import { query, type SDKMessage, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import * as fs from "fs/promises";
import * as path from "path";
import { createHash } from "crypto";

interface TranslationCache {
  sourceHash: string;
  lastUpdated: string;
  translations: Record<string, {
    hash: string;
    translatedAt: string;
    costUsd: number;
  }>;
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

async function readCache(cachePath: string): Promise<TranslationCache | null> {
  try {
    const data = await fs.readFile(cachePath, "utf-8");
    return JSON.parse(data);
  } catch {
    return null;
  }
}

async function writeCache(cachePath: string, cache: TranslationCache): Promise<void> {
  await fs.writeFile(cachePath, JSON.stringify(cache, null, 2), "utf-8");
}

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
  /** Force re-translation even if cached */
  force?: boolean;
}

export interface TranslationResult {
  language: string;
  outputPath: string;
  success: boolean;
  error?: string;
  costUsd?: number;
  /** Whether this was served from cache */
  cached?: boolean;
}

export interface TranslationJobResult {
  results: TranslationResult[];
  totalCostUsd: number;
  successful: number;
  failed: number;
}

const LANGUAGE_NAMES: Record<string, string> = {
  // Tier 1 - No-brainers
  zh: "Chinese (Simplified)",
  ja: "Japanese",
  "pt-br": "Brazilian Portuguese",
  ko: "Korean",
  es: "Spanish",
  de: "German",
  fr: "French",
  // Tier 2 - Strong tech scenes
  he: "Hebrew",
  ar: "Arabic",
  ru: "Russian",
  pl: "Polish",
  cs: "Czech",
  nl: "Dutch",
  tr: "Turkish",
  uk: "Ukrainian",
  // Tier 3 - Emerging/Growing fast
  vi: "Vietnamese",
  id: "Indonesian",
  th: "Thai",
  hi: "Hindi",
  bn: "Bengali",
  ur: "Urdu",
  ro: "Romanian",
  sv: "Swedish",
  // Tier 4 - Why not
  it: "Italian",
  el: "Greek",
  hu: "Hungarian",
  fi: "Finnish",
  da: "Danish",
  no: "Norwegian",
  // Other supported
  bg: "Bulgarian",
  et: "Estonian",
  lt: "Lithuanian",
  lv: "Latvian",
  pt: "Portuguese",
  sk: "Slovak",
  sl: "Slovenian",
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
- Add a small note at the very top of the document (before any other content) in ${languageName}: "🌐 This is an automated translation. Community corrections are welcome!"

Here is the README content to translate:

---
${content}
---

CRITICAL OUTPUT RULES:
- Output ONLY the raw translated markdown content
- Do NOT wrap output in \`\`\`markdown code fences
- Do NOT add any preamble, explanation, or commentary
- Start directly with the translation note, then the content
- The output will be saved directly to a .md file`;

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

  // Strip markdown code fences if Claude wrapped the output
  let cleaned = translation.trim();
  if (cleaned.startsWith("```markdown")) {
    cleaned = cleaned.slice("```markdown".length);
  } else if (cleaned.startsWith("```md")) {
    cleaned = cleaned.slice("```md".length);
  } else if (cleaned.startsWith("```")) {
    cleaned = cleaned.slice(3);
  }
  if (cleaned.endsWith("```")) {
    cleaned = cleaned.slice(0, -3);
  }
  cleaned = cleaned.trim();

  return { translation: cleaned, costUsd };
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
    force = false,
  } = options;

  // Run all translations in parallel (up to 10 concurrent)
  const parallel = Math.min(languages.length, 10);

  // Read source file
  const sourcePath = path.resolve(source);
  const content = await fs.readFile(sourcePath, "utf-8");

  // Determine output directory
  const outDir = outputDir ? path.resolve(outputDir) : path.dirname(sourcePath);
  await fs.mkdir(outDir, { recursive: true });

  // Compute content hash and load cache
  const sourceHash = hashContent(content);
  const cachePath = path.join(outDir, ".translation-cache.json");
  const cache = await readCache(cachePath);
  const isHashMatch = cache?.sourceHash === sourceHash;

  const results: TranslationResult[] = [];
  let totalCostUsd = 0;

  if (verbose) {
    console.log(`📖 Source: ${sourcePath}`);
    console.log(`📂 Output: ${outDir}`);
    console.log(`🌍 Languages: ${languages.join(", ")}`);
    console.log(`⚡ Running ${parallel} translations in parallel`);
    console.log("");
  }

  // Worker function for a single language
  async function translateLang(lang: string): Promise<TranslationResult> {
    const outputFilename = pattern.replace("{lang}", lang);
    const outputPath = path.join(outDir, outputFilename);

    // Check cache (unless --force)
    if (!force && isHashMatch && cache?.translations[lang]) {
      const outputExists = await fs.access(outputPath).then(() => true).catch(() => false);
      if (outputExists) {
        if (verbose) {
          console.log(`   ✅ ${outputFilename} (cached, unchanged)`);
        }
        return { language: lang, outputPath, success: true, cached: true, costUsd: 0 };
      }
    }

    if (verbose) {
      console.log(`🔄 Translating to ${getLanguageName(lang)} (${lang})...`);
    }

    try {
      const { translation, costUsd } = await translateToLanguage(content, lang, {
        preserveCode,
        model,
        verbose: verbose && parallel === 1, // Only show progress spinner for sequential
      });

      await fs.writeFile(outputPath, translation, "utf-8");

      if (verbose) {
        console.log(`   ✅ Saved to ${outputFilename} ($${costUsd.toFixed(4)})`);
      }

      return { language: lang, outputPath, success: true, costUsd };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (verbose) {
        console.log(`   ❌ ${lang} failed: ${errorMessage}`);
      }
      return { language: lang, outputPath, success: false, error: errorMessage };
    }
  }

  // Run with concurrency limit
  async function runWithConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<TranslationResult>): Promise<TranslationResult[]> {
    const results: TranslationResult[] = [];
    const executing = new Set<Promise<void>>();

    for (const item of items) {
      // Check budget before starting new translation
      if (maxBudgetUsd && totalCostUsd >= maxBudgetUsd) {
        results.push({
          language: String(item),
          outputPath: "",
          success: false,
          error: "Budget exceeded",
        });
        continue;
      }

      const p = fn(item).then((result) => {
        results.push(result);
        if (result.costUsd) {
          totalCostUsd += result.costUsd;
        }
      });

      // Create a wrapped promise that removes itself when done
      const wrapped = p.finally(() => {
        executing.delete(wrapped);
      });

      executing.add(wrapped);

      // Wait for a slot to open up if we're at the limit
      if (executing.size >= limit) {
        await Promise.race(executing);
      }
    }

    // Wait for all remaining translations to complete
    await Promise.all(executing);
    return results;
  }

  const translationResults = await runWithConcurrency(languages, parallel, translateLang);
  results.push(...translationResults);

  // Save updated cache
  const newCache: TranslationCache = {
    sourceHash,
    lastUpdated: new Date().toISOString(),
    translations: {
      ...(isHashMatch ? cache?.translations : {}),
      ...Object.fromEntries(
        results.filter(r => r.success && !r.cached).map(r => [
          r.language,
          { hash: sourceHash, translatedAt: new Date().toISOString(), costUsd: r.costUsd || 0 }
        ])
      ),
    },
  };
  await writeCache(cachePath, newCache);

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
