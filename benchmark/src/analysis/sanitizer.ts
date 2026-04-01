import { createHash } from 'node:crypto';
import { readFile, writeFile, readdir, mkdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

// --- Error Classes ---

export class SanitizationError extends Error {
  constructor(
    public readonly filePath: string,
    public readonly reason: string,
  ) {
    super(`Sanitization failed for ${filePath}: ${reason}`);
    this.name = 'SanitizationError';
  }
}

// --- Interfaces ---

export interface SanitizationResult {
  originalPath: string;
  sanitizedPath: string;
  patternsStripped: number;
  rawLogSha256: string;
}

// --- Sanitization Patterns ---

interface SanitizationPattern {
  regex: RegExp;
  replacement: string;
}

const SANITIZATION_PATTERNS: SanitizationPattern[] = [
  // Anthropic API keys
  {
    regex: /sk-ant-[A-Za-z0-9_-]+/g,
    replacement: 'REDACTED_API_KEY',
  },
  // Environment variable assignments with API keys
  {
    regex: /ANTHROPIC_API_KEY[_\d]*=\S+/g,
    replacement: 'ANTHROPIC_API_KEY=REDACTED',
  },
  // File paths with usernames (macOS)
  {
    regex: /\/Users\/[^/\s]+\//g,
    replacement: '/Users/REDACTED/',
  },
  // File paths with usernames (Linux)
  {
    regex: /\/home\/[^/\s]+\//g,
    replacement: '/home/REDACTED/',
  },
  // Bearer tokens
  {
    regex: /Bearer\s+\S+/g,
    replacement: 'Bearer REDACTED',
  },
  // Telegram bot tokens (numeric_id:alphanumeric_token with ~35 chars)
  // Must come before generic token pattern to avoid partial match
  {
    regex: /\d+:[A-Za-z0-9_-]{35}/g,
    replacement: 'REDACTED_TELEGRAM_TOKEN',
  },
  // Generic token assignments (case-insensitive)
  {
    regex: /token[=:]\s*\S+/gi,
    replacement: 'token=REDACTED',
  },
];

// --- Public API ---

/**
 * Sanitizes content by stripping known sensitive patterns.
 * Returns the sanitized content and the count of patterns stripped.
 */
export function sanitizeContent(content: string): {
  sanitized: string;
  patternsStripped: number;
} {
  let sanitized = content;
  let patternsStripped = 0;

  for (const pattern of SANITIZATION_PATTERNS) {
    // Reset lastIndex for global regexes
    pattern.regex.lastIndex = 0;
    const matches = sanitized.match(pattern.regex);
    if (matches) {
      patternsStripped += matches.length;
      sanitized = sanitized.replace(pattern.regex, pattern.replacement);
    }
  }

  return { sanitized, patternsStripped };
}

/**
 * Computes the SHA-256 hash of a file's raw contents BEFORE any sanitization.
 */
export async function computeRawLogHash(filePath: string): Promise<string> {
  const content = await readFile(filePath);
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Recursively collects all file paths in a directory.
 */
async function collectFilePaths(
  dirPath: string,
  basePath: string = dirPath,
): Promise<string[]> {
  const paths: string[] = [];

  let entries: string[];
  try {
    entries = await readdir(dirPath);
  } catch {
    return paths;
  }

  for (const entry of entries) {
    const fullPath = join(dirPath, entry);
    let entryStat;
    try {
      entryStat = await stat(fullPath);
    } catch {
      continue;
    }

    if (entryStat.isDirectory()) {
      const subPaths = await collectFilePaths(fullPath, basePath);
      paths.push(...subPaths);
    } else if (entryStat.isFile()) {
      paths.push(fullPath);
    }
  }

  return paths;
}

/**
 * Checks if a file is likely a text file based on extension.
 */
function isTextFile(filePath: string): boolean {
  const textExtensions = new Set([
    '.json',
    '.jsonl',
    '.txt',
    '.md',
    '.log',
    '.yaml',
    '.yml',
    '.toml',
    '.ts',
    '.js',
    '.tsx',
    '.jsx',
    '.css',
    '.html',
    '.xml',
    '.csv',
    '.env',
    '.sh',
    '.bash',
    '.zsh',
    '.py',
    '.rb',
    '.go',
    '.rs',
    '.java',
    '.c',
    '.cpp',
    '.h',
    '.hpp',
  ]);

  const lowerPath = filePath.toLowerCase();
  for (const ext of textExtensions) {
    if (lowerPath.endsWith(ext)) return true;
  }

  return false;
}

/**
 * Sanitizes all result files in resultsDir and writes sanitized versions
 * to outputDir/publishable/.
 */
export async function sanitizeResults(
  resultsDir: string,
  outputDir: string,
): Promise<SanitizationResult[]> {
  const publishableDir = join(outputDir, 'publishable');
  await mkdir(publishableDir, { recursive: true });

  const filePaths = await collectFilePaths(resultsDir);
  const sanitizationResults: SanitizationResult[] = [];

  for (const filePath of filePaths) {
    const relativePath = relative(resultsDir, filePath);
    const sanitizedPath = join(publishableDir, relativePath);

    // Ensure parent directory exists
    const parentDir = join(sanitizedPath, '..');
    await mkdir(parentDir, { recursive: true });

    try {
      // Compute hash of raw file first
      const rawLogSha256 = await computeRawLogHash(filePath);

      if (isTextFile(filePath)) {
        const rawContent = await readFile(filePath, 'utf-8');
        const { sanitized, patternsStripped } = sanitizeContent(rawContent);
        await writeFile(sanitizedPath, sanitized);

        sanitizationResults.push({
          originalPath: filePath,
          sanitizedPath,
          patternsStripped,
          rawLogSha256,
        });
      } else {
        // Copy binary files as-is
        const rawContent = await readFile(filePath);
        await writeFile(sanitizedPath, rawContent);

        sanitizationResults.push({
          originalPath: filePath,
          sanitizedPath,
          patternsStripped: 0,
          rawLogSha256,
        });
      }
    } catch (error) {
      throw new SanitizationError(
        filePath,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  return sanitizationResults;
}
