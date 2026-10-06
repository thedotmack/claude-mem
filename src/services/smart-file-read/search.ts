
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, extname, join, relative } from "node:path";
import { parseFilesBatch, formatFoldedView, qualifySymbolName, matchScore, type FoldedFile } from "./parser.js";
import { logger } from "../../utils/logger.js";

const CODE_EXTENSIONS = new Set([
  ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".mts", ".cts",
  ".py", ".pyw",
  ".go",
  ".rs",
  ".rb",
  ".java",
  ".cs",
  ".cpp", ".cc", ".cxx", ".c", ".h", ".hpp", ".hh",
  ".swift",
  ".kt", ".kts",
  ".php",
  ".vue", ".svelte",
  ".lua",
  ".scala", ".sc",
  ".sh", ".bash", ".zsh",
  ".hs",
  ".zig",
  ".css", ".scss",
  ".toml",
  ".yml", ".yaml",
  ".sql",
  ".md", ".mdx",
]);

const IGNORE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", "__pycache__",
  ".venv", "venv", "env", ".env", "target", "vendor",
  ".cache", ".turbo", "coverage", ".nyc_output",
  ".claude", ".smart-file-read",
]);

const MAX_FILE_SIZE = 512 * 1024; 

export interface SearchResult {
  foldedFiles: FoldedFile[];
  matchingSymbols: SymbolMatch[];
  matchingFiles: FileMatch[];
  totalFilesScanned: number;
  totalSymbolsFound: number;
  tokenEstimate: number;
}

/** A file whose path contains every query part but none of whose symbols are shown. */
export interface FileMatch {
  filePath: string;
  language: string;
  totalLines: number;
  foldedTokenEstimate: number;
}

export interface SymbolMatch {
  filePath: string;
  symbolName: string;
  kind: string;
  signature: string;
  jsdoc?: string;
  lineStart: number;
  lineEnd: number;
  matchReason: string; 
}

async function* walkDir(dir: string, rootDir: string, maxDepth: number = 20): AsyncGenerator<string> {
  if (maxDepth <= 0) return;

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    logger.debug('WORKER', `walkDir: failed to read directory ${dir}`, undefined, error instanceof Error ? error : undefined);
    return;
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".") continue;
    if (IGNORE_DIRS.has(entry.name)) continue;

    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      yield* walkDir(fullPath, rootDir, maxDepth - 1);
    } else if (entry.isFile()) {
      const ext = entry.name.slice(entry.name.lastIndexOf("."));
      if (CODE_EXTENSIONS.has(ext.toLowerCase())) {
        yield fullPath;
      }
    }
  }
}

async function safeReadFile(filePath: string): Promise<string | null> {
  try {
    const stats = await stat(filePath);
    if (stats.size > MAX_FILE_SIZE) return null;
    if (stats.size === 0) return null;

    const content = await readFile(filePath, "utf-8");

    if (content.slice(0, 1000).includes("\0")) return null;

    return content;
  } catch (error) {
    logger.debug('WORKER', `safeReadFile: failed to read ${filePath}`, undefined, error instanceof Error ? error : undefined);
    return null;
  }
}

export async function searchCodebase(
  rootDir: string,
  query: string,
  options: {
    maxResults?: number;
    includeImports?: boolean;
    filePattern?: string;
  } = {}
): Promise<SearchResult> {
  const maxResults = options.maxResults || 20;
  const queryLower = query.toLowerCase();
  const queryParts = queryLower.split(/[\s_\-./]+/).filter(p => p.length > 0);

  const filesToParse: Array<{ absolutePath: string; relativePath: string; content: string }> = [];

  for await (const filePath of walkDir(rootDir, rootDir, 20)) {
    if (options.filePattern) {
      const relPath = relative(rootDir, filePath);
      if (!relPath.toLowerCase().includes(options.filePattern.toLowerCase())) continue;
    }

    const content = await safeReadFile(filePath);
    if (!content) continue;

    filesToParse.push({
      absolutePath: filePath,
      relativePath: relative(rootDir, filePath),
      content,
    });
  }

  const parsedFiles = parseFilesBatch(filesToParse);

  const foldedFiles: FoldedFile[] = [];
  const matchingSymbols: SymbolMatch[] = [];
  const symbolScores = new Map<SymbolMatch, number>();
  let totalSymbolsFound = 0;

  for (const [relPath, parsed] of parsedFiles) {
    totalSymbolsFound += countSymbols(parsed);

    const pathMatch = matchScore(relPath.toLowerCase(), queryParts);
    let fileHasMatch = pathMatch > 0;
    const fileSymbolMatches: SymbolMatch[] = [];

    const checkSymbols = (symbols: typeof parsed.symbols, parent?: string) => {
      for (const sym of symbols) {
        const qualifiedName = qualifySymbolName(sym.name, parent, parsed.language, sym.kind);
        let score = 0;
        let reason = "";

        // Score the symbol's own name, so a class or module query does not match
        // every method under it. Qualified Ruby queries retain their owner and
        // method separator, including a partial method name.
        const separator = qualifiedName.includes('#')
          ? qualifiedName.lastIndexOf('#') : qualifiedName.lastIndexOf('.');
        const ownerPrefix = qualifiedName.slice(0, separator + 1).toLowerCase();
        // A partial Ruby method query must name its complete owner and method
        // separator; a class-only query still must not pull in every method.
        const qualifiedRubyScore = parsed.language === 'ruby' && sym.kind === 'method'
          && separator >= 0 && queryLower.startsWith(ownerPrefix)
          && queryLower.length > ownerPrefix.length
          ? matchScore(qualifiedName.toLowerCase(), [queryLower]) : 0;
        const rubyQualifiedQuery = parsed.language === 'ruby' && /[#.]/.test(queryLower);
        const ownNameScore = rubyQualifiedQuery
          ? (sym.kind === 'method' ? qualifiedRubyScore
            : matchScore(qualifiedName.toLowerCase(), [queryLower]))
          : matchScore(sym.name.toLowerCase(), queryParts);
        const nameScore = ownNameScore
          || (qualifiedName.toLowerCase() === queryLower ? 10 : 0);
        if (nameScore > 0) {
          score += nameScore * 3;
          reason = "name match";
        }

        // Explicit Ruby ownership is a constraint, including when a comment
        // or signature mentions a different owner. Unqualified text searches
        // continue to search both fields.
        const eligibleForTextMatch = !rubyQualifiedQuery || ownNameScore > 0;
        if (eligibleForTextMatch && sym.signature.toLowerCase().includes(queryLower)) {
          score += 2;
          reason = reason ? `${reason} + signature` : "signature match";
        }

        if (eligibleForTextMatch && sym.jsdoc && sym.jsdoc.toLowerCase().includes(queryLower)) {
          score += 1;
          reason = reason ? `${reason} + jsdoc` : "jsdoc match";
        }

        if (score > 0) {
          fileHasMatch = true;
          const match: SymbolMatch = {
            filePath: relPath,
            symbolName: qualifiedName,
            kind: sym.kind,
            signature: sym.signature,
            jsdoc: sym.jsdoc,
            lineStart: sym.lineStart,
            lineEnd: sym.lineEnd,
            matchReason: reason,
          };
          fileSymbolMatches.push(match);
          symbolScores.set(match, score);
        }

        if (sym.children) {
          checkSymbols(sym.children, qualifiedName);
        }
      }
    };

    checkSymbols(parsed.symbols);

    if (fileHasMatch) {
      foldedFiles.push(parsed);
      matchingSymbols.push(...fileSymbolMatches);
    }
  }

  // Computed relevance first. Equal relevance falls back to the qualified
  // identity, so `Beta.run` keeps Beta's method ahead of `Alpha.run`.
  const qualifiedRank = (symbol: SymbolMatch): number => matchScore(symbol.symbolName.toLowerCase(), queryParts);
  matchingSymbols.sort((a, b) => (symbolScores.get(b)! - symbolScores.get(a)!) || (qualifiedRank(b) - qualifiedRank(a)));

  const trimmedSymbols = matchingSymbols.slice(0, maxResults);
  const relevantFiles = new Set(trimmedSymbols.map(s => s.filePath));
  const trimmedFiles = foldedFiles.filter(f => relevantFiles.has(f.filePath)).slice(0, maxResults);

  const tokenEstimate = trimmedFiles.reduce((sum, f) => sum + f.foldedTokenEstimate, 0);

  // Path hits without a shown symbol are listed one line each, never folded,
  // because results go straight into an agent's context: a common word like
  // "store" or "worker" is a substring of hundreds of paths. Only literal
  // substrings qualify; the fuzzy fallback stays for symbol names. Every
  // literal hit scores the same on its full path, so rank by the file name:
  // an exact name, then a name containing the query, then a directory hit.
  const matchingFiles: FileMatch[] = queryParts.length === 0 ? [] : [...parsedFiles.values()]
    .filter(file => {
      const pathLower = file.filePath.toLowerCase();
      return !relevantFiles.has(file.filePath) && queryParts.every(part => pathLower.includes(part));
    })
    .map(file => ({ file, nameScore: matchScore(basename(file.filePath, extname(file.filePath)).toLowerCase(), queryParts) }))
    .sort((a, b) => b.nameScore - a.nameScore)
    .slice(0, maxResults)
    .map(({ file }) => ({
      filePath: file.filePath,
      language: file.language,
      totalLines: file.totalLines,
      foldedTokenEstimate: file.foldedTokenEstimate,
    }));

  return {
    foldedFiles: trimmedFiles,
    matchingSymbols: trimmedSymbols,
    matchingFiles,
    totalFilesScanned: filesToParse.length,
    totalSymbolsFound,
    tokenEstimate,
  };
}

function countSymbols(file: FoldedFile): number {
  const count = (symbols: FoldedFile["symbols"]): number => symbols.reduce(
    (total, symbol) => total + 1 + (symbol.children ? count(symbol.children) : 0), 0);
  return count(file.symbols);
}

export function formatSearchResults(result: SearchResult, query: string): string {
  const parts: string[] = [];
  const count = (n: number, noun: string, pluralSuffix = "s") => `${n} ${noun}${n === 1 ? "" : pluralSuffix}`;

  parts.push(`🔍 Smart Search: "${query}"`);
  parts.push(`   Scanned ${result.totalFilesScanned} files, found ${result.totalSymbolsFound} symbols`);
  parts.push(`   ${count(result.matchingSymbols.length, "symbol match", "es")}; ${count(result.foldedFiles.length, "matched file")} (~${result.tokenEstimate} tokens for folded view); ${count(result.matchingFiles.length, "file")} matched by path only`);
  parts.push("");

  if (result.matchingSymbols.length === 0 && result.matchingFiles.length === 0) {
    parts.push("   No matching symbols or files found.");
    return parts.join("\n");
  }

  if (result.matchingSymbols.length > 0) {
    parts.push("── Matching Symbols ──");
    parts.push("");
  }
  for (const match of result.matchingSymbols) {
    parts.push(`  ${match.kind} ${match.symbolName} (${match.filePath}:${match.lineStart + 1})`);
    parts.push(`    ${match.signature}`);
    if (match.jsdoc) {
      const firstLine = match.jsdoc.split("\n").find(l => l.replace(/^[\s*/]+/, "").trim().length > 0);
      if (firstLine) {
        parts.push(`    💬 ${firstLine.replace(/^[\s*/]+/, "").trim()}`);
      }
    }
    parts.push("");
  }

  if (result.foldedFiles.length > 0) {
    parts.push("── Folded File Views ──");
    parts.push("");
  }
  for (const file of result.foldedFiles) {
    parts.push(formatFoldedView(file));
    parts.push("");
  }

  if (result.matchingFiles.length > 0) {
    parts.push("── Matching Files ──");
    parts.push("");
    for (const file of result.matchingFiles) {
      parts.push(`  ${file.filePath} (${file.language}, ${file.totalLines} lines, ~${file.foldedTokenEstimate} tokens folded) — smart_outline to expand`);
    }
    parts.push("");
  }

  parts.push("── Actions ──");
  parts.push('  To see full implementation: use smart_unfold with file path and symbol name');

  return parts.join("\n");
}
