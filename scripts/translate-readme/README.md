# README Translator

Translate README.md files to multiple languages using the Claude Agent SDK. Perfect for build scripts and CI/CD pipelines.

## Installation

```bash
npm install readme-translator
# or
npm install -g readme-translator  # for CLI usage
```

## Requirements

- Node.js 18+
- **Authentication** (one of the following):
  - Claude Code installed and authenticated (Pro/Max subscription) - **no API key needed**
  - `ANTHROPIC_API_KEY` environment variable set (for API-based usage)
  - AWS Bedrock (`CLAUDE_CODE_USE_BEDROCK=1` + AWS credentials)
  - Google Vertex AI (`CLAUDE_CODE_USE_VERTEX=1` + GCP credentials)

If you have Claude Code installed and logged in with your Pro/Max subscription, the SDK will automatically use that authentication.

## CLI Usage

```bash
# Basic usage
translate-readme README.md es fr de

# With options
translate-readme -v -o ./i18n --pattern docs.{lang}.md README.md es fr de ja zh

# List supported languages
translate-readme --list-languages
```

### CLI Options

| Option | Description |
|--------|-------------|
| `-o, --output <dir>` | Output directory (default: same as source) |
| `-p, --pattern <pat>` | Output filename pattern (default: `README.{lang}.md`) |
| `--no-preserve-code` | Translate code blocks too (not recommended) |
| `-m, --model <model>` | Claude model to use (default: `sonnet`) |
| `--max-budget <usd>` | Maximum budget in USD |
| `-v, --verbose` | Show detailed progress |
| `-h, --help` | Show help message |
| `--list-languages` | List all supported language codes |

## Programmatic Usage

```typescript
import { translateReadme } from "readme-translator";

const result = await translateReadme({
  source: "./README.md",
  languages: ["es", "fr", "de", "ja", "zh"],
  verbose: true,
});

console.log(`Translated ${result.successful} files`);
console.log(`Total cost: $${result.totalCostUsd.toFixed(4)}`);
```

### API Options

```typescript
interface TranslationOptions {
  /** Source README file path */
  source: string;

  /** Target language codes */
  languages: string[];

  /** Output directory (defaults to same directory as source) */
  outputDir?: string;

  /** Output filename pattern (use {lang} placeholder) */
  pattern?: string; // default: "README.{lang}.md"

  /** Preserve code blocks without translation */
  preserveCode?: boolean; // default: true

  /** Claude model to use */
  model?: string; // default: "sonnet"

  /** Maximum budget in USD */
  maxBudgetUsd?: number;

  /** Verbose output */
  verbose?: boolean;
}
```

### Return Value

```typescript
interface TranslationJobResult {
  results: TranslationResult[];
  totalCostUsd: number;
  successful: number;
  failed: number;
}

interface TranslationResult {
  language: string;
  outputPath: string;
  success: boolean;
  error?: string;
  costUsd?: number;
}
```

## Build Script Integration

### package.json

```json
{
  "scripts": {
    "translate": "translate-readme README.md es fr de ja zh",
    "translate:all": "translate-readme -v -o ./i18n README.md es fr de it pt ja ko zh ru ar",
    "prebuild": "npm run translate"
  }
}
```

### GitHub Actions

Note: CI/CD environments require an API key since Claude Code won't be authenticated there.

```yaml
name: Translate README
on:
  push:
    branches: [main]
    paths: [README.md]

jobs:
  translate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      
      - run: npm install -g readme-translator
      
      - name: Translate README
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        run: |
          translate-readme -v -o ./i18n README.md es fr de ja zh
      
      - name: Commit translations
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add i18n/
          git diff --staged --quiet || git commit -m "chore: update README translations"
          git push
```

### Programmatic Build Script

```typescript
// scripts/translate.ts
import { translateReadme } from "readme-translator";

async function main() {
  const result = await translateReadme({
    source: "./README.md",
    languages: (process.env.TRANSLATE_LANGS || "es,fr,de").split(","),
    outputDir: "./docs/i18n",
    maxBudgetUsd: 5.0,
    verbose: !process.env.CI,
  });

  if (result.failed > 0) {
    console.error("Some translations failed");
    process.exit(1);
  }
}

main();
```

## Supported Languages

| Code | Language | Code | Language |
|------|----------|------|----------|
| `ar` | Arabic | `ko` | Korean |
| `bg` | Bulgarian | `lt` | Lithuanian |
| `cs` | Czech | `lv` | Latvian |
| `da` | Danish | `nl` | Dutch |
| `de` | German | `no` | Norwegian |
| `el` | Greek | `pl` | Polish |
| `es` | Spanish | `pt` | Portuguese |
| `et` | Estonian | `pt-br` | Brazilian Portuguese |
| `fi` | Finnish | `ro` | Romanian |
| `fr` | French | `ru` | Russian |
| `he` | Hebrew | `sk` | Slovak |
| `hi` | Hindi | `sl` | Slovenian |
| `hu` | Hungarian | `sv` | Swedish |
| `id` | Indonesian | `th` | Thai |
| `it` | Italian | `tr` | Turkish |
| `ja` | Japanese | `uk` | Ukrainian |
| | | `vi` | Vietnamese |
| | | `zh` | Chinese (Simplified) |
| | | `zh-tw` | Chinese (Traditional) |

## Best Practices

1. **Preserve Code Blocks**: Keep `preserveCode: true` (default) to avoid breaking code examples

2. **Set Budget Limits**: Use `maxBudgetUsd` to prevent runaway costs

3. **Run on Releases Only**: In CI/CD, trigger translations only on main branch or releases

4. **Review Translations**: Automated translations are good but not perfect - consider human review for critical docs

5. **Cache Results**: Don't re-translate unchanged content - check if README changed before running

## Cost Estimation

Typical costs per language (varies by README length):
- Short README (~500 words): ~$0.01-0.02
- Medium README (~2000 words): ~$0.05-0.10
- Long README (~5000 words): ~$0.15-0.25

## License

MIT
