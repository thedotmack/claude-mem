/**
 * Code structure parser — shells out to tree-sitter CLI for AST-based extraction.
 *
 * No native bindings. No WASM. Just the CLI binary + query patterns.
 *
 * Supported: JS, TS, Python, Go, Rust, Ruby, Java, C, C++,
 * Kotlin, Swift, PHP, Elixir, Lua, Scala, Bash, Haskell, Zig,
 * CSS, SCSS, TOML, YAML, SQL, Markdown
 *
 * by Copter Labs
 */

import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";

// CJS-safe require for resolving external packages at runtime.
// In ESM: import.meta.url works. In CJS bundle (esbuild): __filename works.
// typeof check avoids ReferenceError in ESM where __filename doesn't exist.
const _require = typeof __filename !== 'undefined'
  ? createRequire(__filename)
  : createRequire(import.meta.url);

// --- Types ---

export interface CodeSymbol {
  name: string;
  kind: "function" | "class" | "method" | "interface" | "type" | "const" | "variable" | "export" | "struct" | "enum" | "trait" | "impl" | "property" | "getter" | "setter" | "mixin" | "section" | "code" | "metadata" | "reference";
  signature: string;
  jsdoc?: string;
  lineStart: number;
  lineEnd: number;
  parent?: string;
  exported: boolean;
  children?: CodeSymbol[];
}

export interface FoldedFile {
  filePath: string;
  language: string;
  symbols: CodeSymbol[];
  imports: string[];
  totalLines: number;
  foldedTokenEstimate: number;
}

// --- Language detection ---

const LANG_MAP: Record<string, string> = {
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "tsx",
  ".ts": "typescript",
  ".tsx": "tsx",
  ".py": "python",
  ".pyw": "python",
  ".go": "go",
  ".rs": "rust",
  ".rb": "ruby",
  ".java": "java",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".hh": "cpp",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".swift": "swift",
  ".php": "php",
  ".ex": "elixir",
  ".exs": "elixir",
  ".lua": "lua",
  ".scala": "scala",
  ".sc": "scala",
  ".sh": "bash",
  ".bash": "bash",
  ".zsh": "bash",
  ".hs": "haskell",
  ".zig": "zig",
  ".css": "css",
  ".scss": "scss",
  ".toml": "toml",
  ".yml": "yaml",
  ".yaml": "yaml",
  ".sql": "sql",
  ".md": "markdown",
  ".mdx": "markdown",
};

export function detectLanguage(filePath: string): string {
  const ext = filePath.slice(filePath.lastIndexOf("."));
  return LANG_MAP[ext] || "unknown";
}

/**
 * Detect language with fallback to user-configured grammar extensions.
 * Bundled LANG_MAP takes priority.
 */
function detectLanguageWithUserGrammars(filePath: string, userConfig: UserGrammarConfig): string {
  const ext = filePath.slice(filePath.lastIndexOf("."));
  if (LANG_MAP[ext]) return LANG_MAP[ext];
  if (userConfig.extensionToLanguage[ext]) return userConfig.extensionToLanguage[ext];
  return "unknown";
}

/**
 * Get the query key for a language, checking user config for custom queries.
 */
function getUserAwareQueryKey(language: string, userConfig: UserGrammarConfig): string {
  // If user config has a specific query key for this language, use it
  if (userConfig.languageToQueryKey[language]) {
    return userConfig.languageToQueryKey[language];
  }
  // Otherwise fall back to the bundled query key mapping
  return getQueryKey(language);
}

// --- User-installable grammars via .claude-mem.json ---

export interface UserGrammarEntry {
  package: string;
  extensions: string[];
  query?: string;
}

export interface UserGrammarConfig {
  /** language name → grammar entry */
  grammars: Record<string, UserGrammarEntry>;
  /** file extension → language name (for user-defined extensions only) */
  extensionToLanguage: Record<string, string>;
  /** language name → query content (custom .scm file content or "generic") */
  languageToQueryKey: Record<string, string>;
}

const userGrammarCache = new Map<string, UserGrammarConfig>();

const EMPTY_USER_GRAMMAR_CONFIG: UserGrammarConfig = {
  grammars: {},
  extensionToLanguage: {},
  languageToQueryKey: {},
};

/**
 * Load user grammar configuration from .claude-mem.json in a project root.
 * Cached per project root. Returns empty config if file doesn't exist or is invalid.
 * User entries do NOT override bundled grammars.
 */
export function loadUserGrammars(projectRoot: string): UserGrammarConfig {
  if (userGrammarCache.has(projectRoot)) return userGrammarCache.get(projectRoot)!;

  const configPath = join(projectRoot, ".claude-mem.json");
  let rawConfig: Record<string, unknown>;

  try {
    const content = readFileSync(configPath, "utf-8");
    rawConfig = JSON.parse(content);
  } catch {
    userGrammarCache.set(projectRoot, EMPTY_USER_GRAMMAR_CONFIG);
    return EMPTY_USER_GRAMMAR_CONFIG;
  }

  const grammarsRaw = rawConfig.grammars;
  if (!grammarsRaw || typeof grammarsRaw !== "object" || Array.isArray(grammarsRaw)) {
    userGrammarCache.set(projectRoot, EMPTY_USER_GRAMMAR_CONFIG);
    return EMPTY_USER_GRAMMAR_CONFIG;
  }

  const config: UserGrammarConfig = {
    grammars: {},
    extensionToLanguage: {},
    languageToQueryKey: {},
  };

  for (const [language, entry] of Object.entries(grammarsRaw as Record<string, unknown>)) {
    // Skip if this language is already bundled
    if (GRAMMAR_PACKAGES[language]) continue;

    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const typedEntry = entry as Record<string, unknown>;

    const pkg = typedEntry.package;
    const extensions = typedEntry.extensions;
    const queryPath = typedEntry.query;

    // Validate required fields
    if (typeof pkg !== "string" || !Array.isArray(extensions)) continue;
    if (!extensions.every((e: unknown) => typeof e === "string")) continue;

    config.grammars[language] = {
      package: pkg,
      extensions: extensions as string[],
      query: typeof queryPath === "string" ? queryPath : undefined,
    };

    // Map extensions to language (skip extensions already handled by bundled LANG_MAP)
    for (const ext of extensions as string[]) {
      if (!LANG_MAP[ext]) {
        config.extensionToLanguage[ext] = language;
      }
    }

    // Resolve query content
    if (typeof queryPath === "string") {
      const fullQueryPath = join(projectRoot, queryPath);
      try {
        const queryContent = readFileSync(fullQueryPath, "utf-8");
        // Store with a unique key to avoid collisions with built-in queries
        const queryKey = `user_${language}`;
        QUERIES[queryKey] = queryContent;
        config.languageToQueryKey[language] = queryKey;
      } catch {
        console.error(`[smart-file-read] Custom query file not found: ${fullQueryPath}, falling back to generic`);
        config.languageToQueryKey[language] = "generic";
      }
    } else {
      config.languageToQueryKey[language] = "generic";
    }
  }

  userGrammarCache.set(projectRoot, config);
  return config;
}

// --- Grammar path resolution ---

const GRAMMAR_PACKAGES: Record<string, string> = {
  javascript: "tree-sitter-javascript",
  typescript: "tree-sitter-typescript/typescript",
  tsx: "tree-sitter-typescript/tsx",
  python: "tree-sitter-python",
  go: "tree-sitter-go",
  rust: "tree-sitter-rust",
  ruby: "tree-sitter-ruby",
  java: "tree-sitter-java",
  c: "tree-sitter-c",
  cpp: "tree-sitter-cpp",
  kotlin: "tree-sitter-kotlin",
  swift: "tree-sitter-swift",
  php: "tree-sitter-php/php",
  elixir: "tree-sitter-elixir",
  lua: "@tree-sitter-grammars/tree-sitter-lua",
  scala: "tree-sitter-scala",
  bash: "tree-sitter-bash",
  haskell: "tree-sitter-haskell",
  zig: "@tree-sitter-grammars/tree-sitter-zig",
  css: "tree-sitter-css",
  scss: "tree-sitter-scss",
  toml: "@tree-sitter-grammars/tree-sitter-toml",
  yaml: "@tree-sitter-grammars/tree-sitter-yaml",
  sql: "@derekstride/tree-sitter-sql",
  markdown: "@tree-sitter-grammars/tree-sitter-markdown",
};

// Grammars where the parser source lives in a subdirectory of the npm package root,
// AND that subdirectory lacks its own package.json (so require.resolve won't find it).
// Maps language → subdirectory name under the package root.
const GRAMMAR_SUBDIR: Record<string, string> = {
  markdown: "tree-sitter-markdown",
};

function resolveGrammarPath(language: string): string | null {
  const pkg = GRAMMAR_PACKAGES[language];
  if (!pkg) return null;

  const subdir = GRAMMAR_SUBDIR[language];
  if (subdir) {
    // Package root has no sub-package.json — resolve root then append subdir
    try {
      const rootPkgPath = _require.resolve(pkg + "/package.json");
      const resolved = join(dirname(rootPkgPath), subdir);
      if (existsSync(join(resolved, "src"))) return resolved;
    } catch { /* fall through */ }
    return null;
  }

  try {
    const packageJsonPath = _require.resolve(pkg + "/package.json");
    return dirname(packageJsonPath);
  } catch {
    return null;
  }
}

/**
 * Resolve grammar path with fallback to user-installed grammars.
 * First tries bundled grammars, then falls back to the project's node_modules.
 */
export function resolveGrammarPathWithFallback(language: string, projectRoot?: string): string | null {
  // Try bundled grammar first
  const bundled = resolveGrammarPath(language);
  if (bundled) return bundled;

  // Fall back to user-installed grammar in project's node_modules
  if (!projectRoot) return null;

  const userConfig = loadUserGrammars(projectRoot);
  const entry = userConfig.grammars[language];
  if (!entry) return null;

  try {
    const packageJsonPath = join(projectRoot, "node_modules", entry.package, "package.json");
    if (existsSync(packageJsonPath)) {
      const grammarDir = dirname(packageJsonPath);
      // Verify it has a src/ directory (required by tree-sitter CLI)
      if (existsSync(join(grammarDir, "src"))) return grammarDir;
    }
  } catch {
    // Grammar package not installed
  }

  console.error(`[smart-file-read] Grammar package not found for "${language}": ${entry.package} (install it in your project's node_modules)`);
  return null;
}

// --- Query patterns (declarative symbol extraction) ---

const QUERIES: Record<string, string> = {
  jsts: `
(function_declaration name: (identifier) @name) @func
(lexical_declaration (variable_declarator name: (identifier) @name value: [(arrow_function) (function_expression)])) @const_func
(class_declaration name: (type_identifier) @name) @cls
(method_definition name: (property_identifier) @name) @method
(interface_declaration name: (type_identifier) @name) @iface
(type_alias_declaration name: (type_identifier) @name) @tdef
(enum_declaration name: (identifier) @name) @enm
(import_statement) @imp
(export_statement) @exp
`,

  python: `
(function_definition name: (identifier) @name) @func
(class_definition name: (identifier) @name) @cls
(import_statement) @imp
(import_from_statement) @imp
`,

  go: `
(function_declaration name: (identifier) @name) @func
(method_declaration name: (field_identifier) @name) @method
(type_declaration (type_spec name: (type_identifier) @name)) @tdef
(import_declaration) @imp
`,

  rust: `
(function_item name: (identifier) @name) @func
(struct_item name: (type_identifier) @name) @struct_def
(enum_item name: (type_identifier) @name) @enm
(trait_item name: (type_identifier) @name) @trait_def
(impl_item type: (type_identifier) @name) @impl_def
(use_declaration) @imp
`,

  ruby: `
(method name: (identifier) @name) @func
(class name: (constant) @name) @cls
(module name: (constant) @name) @cls
(call method: (identifier) @name) @imp
`,

  java: `
(method_declaration name: (identifier) @name) @method
(class_declaration name: (identifier) @name) @cls
(interface_declaration name: (identifier) @name) @iface
(enum_declaration name: (identifier) @name) @enm
(import_declaration) @imp
`,

  kotlin: `
(function_declaration (simple_identifier) @name) @func
(class_declaration (type_identifier) @name) @cls
(object_declaration (type_identifier) @name) @cls
(import_header) @imp
`,

  swift: `
(function_declaration name: (simple_identifier) @name) @func
(class_declaration name: (type_identifier) @name) @cls
(protocol_declaration name: (type_identifier) @name) @iface
(import_declaration) @imp
`,

  php: `
(function_definition name: (name) @name) @func
(class_declaration name: (name) @name) @cls
(interface_declaration name: (name) @name) @iface
(trait_declaration name: (name) @name) @trait_def
(method_declaration name: (name) @name) @method
(namespace_use_declaration) @imp
`,

  lua: `
(function_declaration name: (identifier) @name) @func
(function_declaration name: (dot_index_expression) @name) @func
(function_declaration name: (method_index_expression) @name) @func
`,

  scala: `
(function_definition name: (identifier) @name) @func
(class_definition name: (identifier) @name) @cls
(object_definition name: (identifier) @name) @cls
(trait_definition name: (identifier) @name) @trait_def
(import_declaration) @imp
`,

  bash: `
(function_definition name: (word) @name) @func
`,

  haskell: `
(function name: (variable) @name) @func
(type_synomym name: (name) @name) @tdef
(newtype name: (name) @name) @tdef
(data_type name: (name) @name) @tdef
(class name: (name) @name) @cls
(import) @imp
`,

  zig: `
(function_declaration name: (identifier) @name) @func
(test_declaration) @func
`,

  css: `
(rule_set (selectors) @name) @func
(media_statement) @cls
(keyframes_statement (keyframes_name) @name) @cls
(import_statement) @imp
`,

  scss: `
(rule_set (selectors) @name) @func
(media_statement) @cls
(keyframes_statement (keyframes_name) @name) @cls
(import_statement) @imp
(mixin_statement name: (identifier) @name) @mixin_def
(function_statement name: (identifier) @name) @func
(include_statement) @imp
`,

  toml: `
(table (bare_key) @name) @cls
(table (dotted_key) @name) @cls
(table_array_element (bare_key) @name) @cls
(table_array_element (dotted_key) @name) @cls
`,

  yaml: `
(block_mapping_pair key: (flow_node) @name) @func
`,

  sql: `
(create_table (object_reference) @name) @cls
(create_function (object_reference) @name) @func
(create_view (object_reference) @name) @cls
`,

  markdown: `
(atx_heading heading_content: (inline) @name) @heading
(setext_heading heading_content: (paragraph) @name) @heading
(fenced_code_block (info_string (language) @name)) @code_block
(fenced_code_block) @code_block
(minus_metadata) @frontmatter
(link_reference_definition (link_label) @name) @ref
`,

  generic: `
(function_declaration name: (identifier) @name) @func
(function_definition name: (identifier) @name) @func
(class_declaration name: (identifier) @name) @cls
(class_definition name: (identifier) @name) @cls
(import_statement) @imp
(import_declaration) @imp
`,

  php: `
(function_definition name: (name) @name) @func
(method_declaration name: (name) @name) @method
(class_declaration name: (name) @name) @cls
(interface_declaration name: (name) @name) @iface
(trait_declaration name: (name) @name) @trait_def
(namespace_use_declaration) @imp
`,
};

function getQueryKey(language: string): string {
  switch (language) {
    case "javascript":
    case "typescript":
    case "tsx":
      return "jsts";
    case "python": return "python";
    case "go": return "go";
    case "rust": return "rust";
    case "ruby": return "ruby";
    case "java": return "java";
    case "kotlin": return "kotlin";
    case "swift": return "swift";
    case "php": return "php";
    case "elixir": return "generic";
    case "lua": return "lua";
    case "scala": return "scala";
    case "bash": return "bash";
    case "haskell": return "haskell";
    case "zig": return "zig";
    case "css": return "css";
    case "scss": return "scss";
    case "toml": return "toml";
    case "yaml": return "yaml";
    case "sql": return "sql";
    case "markdown": return "markdown";
    default: return "generic";
  }
}

// --- Temp file management ---

let queryTmpDir: string | null = null;
const queryFileCache = new Map<string, string>();

function getQueryFile(queryKey: string): string {
  if (queryFileCache.has(queryKey)) return queryFileCache.get(queryKey)!;

  if (!queryTmpDir) {
    queryTmpDir = mkdtempSync(join(tmpdir(), "smart-read-queries-"));
  }

  const filePath = join(queryTmpDir, `${queryKey}.scm`);
  writeFileSync(filePath, QUERIES[queryKey]);
  queryFileCache.set(queryKey, filePath);
  return filePath;
}

// --- CLI execution ---

let cachedBinPath: string | null = null;

function getTreeSitterBin(): string {
  if (cachedBinPath) return cachedBinPath;

  // Try direct binary from tree-sitter-cli package
  try {
    const pkgPath = _require.resolve("tree-sitter-cli/package.json");
    const binPath = join(dirname(pkgPath), "tree-sitter");
    if (existsSync(binPath)) {
      cachedBinPath = binPath;
      return binPath;
    }
  } catch { /* fall through */ }

  // Fallback: assume it's on PATH
  cachedBinPath = "tree-sitter";
  return cachedBinPath;
}

interface RawCapture {
  tag: string;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
  text?: string;
}

interface RawMatch {
  pattern: number;
  captures: RawCapture[];
}

function runQuery(queryFile: string, sourceFile: string, grammarPath: string): RawMatch[] {
  const result = runBatchQuery(queryFile, [sourceFile], grammarPath);
  return result.get(sourceFile) || [];
}

function runBatchQuery(queryFile: string, sourceFiles: string[], grammarPath: string): Map<string, RawMatch[]> {
  if (sourceFiles.length === 0) return new Map();

  const bin = getTreeSitterBin();
  const execArgs = ["query", "-p", grammarPath, queryFile, ...sourceFiles];

  let output: string;
  try {
    output = execFileSync(bin, execArgs, { encoding: "utf-8", timeout: 30000, stdio: ["pipe", "pipe", "pipe"] });
  } catch {
    return new Map();
  }

  return parseMultiFileQueryOutput(output);
}

function parseMultiFileQueryOutput(output: string): Map<string, RawMatch[]> {
  const fileMatches = new Map<string, RawMatch[]>();
  let currentFile: string | null = null;
  let currentMatch: RawMatch | null = null;

  for (const line of output.split("\n")) {
    // File header: a line that doesn't start with whitespace and isn't empty
    if (line.length > 0 && !line.startsWith(" ") && !line.startsWith("\t")) {
      currentFile = line.trim();
      if (!fileMatches.has(currentFile)) {
        fileMatches.set(currentFile, []);
      }
      currentMatch = null;
      continue;
    }

    if (!currentFile) continue;

    const patternMatch = line.match(/^\s+pattern:\s+(\d+)/);
    if (patternMatch) {
      currentMatch = { pattern: parseInt(patternMatch[1]), captures: [] };
      fileMatches.get(currentFile)!.push(currentMatch);
      continue;
    }

    const captureMatch = line.match(
      /^\s+capture:\s+(?:\d+\s*-\s*)?(\w+),\s*start:\s*\((\d+),\s*(\d+)\),\s*end:\s*\((\d+),\s*(\d+)\)(?:,\s*text:\s*`([^`]*)`)?/
    );
    if (captureMatch && currentMatch) {
      currentMatch.captures.push({
        tag: captureMatch[1],
        startRow: parseInt(captureMatch[2]),
        startCol: parseInt(captureMatch[3]),
        endRow: parseInt(captureMatch[4]),
        endCol: parseInt(captureMatch[5]),
        text: captureMatch[6],
      });
    }
  }

  return fileMatches;
}

// --- Symbol building ---

const KIND_MAP: Record<string, CodeSymbol["kind"]> = {
  func: "function",
  const_func: "function",
  cls: "class",
  method: "method",
  iface: "interface",
  tdef: "type",
  enm: "enum",
  struct_def: "struct",
  trait_def: "trait",
  impl_def: "impl",
  mixin_def: "mixin",
  heading: "section",
  code_block: "code",
  frontmatter: "metadata",
  ref: "reference",
};

const CONTAINER_KINDS = new Set(["class", "struct", "impl", "trait"]);

function extractSignatureFromLines(lines: string[], startRow: number, endRow: number, maxLen: number = 200): string {
  const firstLine = lines[startRow] || "";
  let sig = firstLine;

  if (!sig.trimEnd().endsWith("{") && !sig.trimEnd().endsWith(":")) {
    const chunk = lines.slice(startRow, Math.min(startRow + 10, endRow + 1)).join("\n");
    const braceIdx = chunk.indexOf("{");
    if (braceIdx !== -1 && braceIdx < 500) {
      sig = chunk.slice(0, braceIdx).replace(/\n/g, " ").replace(/\s+/g, " ").trim();
    }
  }

  sig = sig.replace(/\s*[{:]\s*$/, "").trim();
  if (sig.length > maxLen) sig = sig.slice(0, maxLen - 3) + "...";
  return sig;
}

function findCommentAbove(lines: string[], startRow: number): string | undefined {
  const commentLines: string[] = [];
  let foundComment = false;

  for (let i = startRow - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (trimmed === "") {
      if (foundComment) break;
      continue;
    }
    if (trimmed.startsWith("/**") || trimmed.startsWith("*") || trimmed.startsWith("*/") ||
        trimmed.startsWith("//") || trimmed.startsWith("///") || trimmed.startsWith("//!") ||
        trimmed.startsWith("#") || trimmed.startsWith("@")) {
      commentLines.unshift(lines[i]);
      foundComment = true;
    } else {
      break;
    }
  }

  return commentLines.length > 0 ? commentLines.join("\n").trim() : undefined;
}

function findPythonDocstringFromLines(lines: string[], startRow: number, endRow: number): string | undefined {
  for (let i = startRow + 1; i <= Math.min(startRow + 3, endRow); i++) {
    const trimmed = lines[i]?.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('"""') || trimmed.startsWith("'''")) return trimmed;
    break;
  }
  return undefined;
}

function isExported(
  name: string, startRow: number, endRow: number,
  exportRanges: Array<{ startRow: number; endRow: number }>,
  lines: string[], language: string
): boolean {
  switch (language) {
    case "javascript":
    case "typescript":
    case "tsx":
      return exportRanges.some(r => startRow >= r.startRow && endRow <= r.endRow);
    case "python":
      return !name.startsWith("_");
    case "go":
      return name.length > 0 && name[0] === name[0].toUpperCase() && name[0] !== name[0].toLowerCase();
    case "rust":
      return lines[startRow]?.trimStart().startsWith("pub") ?? false;
    default:
      return true;
  }
}

function buildSymbols(matches: RawMatch[], lines: string[], language: string): { symbols: CodeSymbol[]; imports: string[] } {
  const symbols: CodeSymbol[] = [];
  const imports: string[] = [];
  const exportRanges: Array<{ startRow: number; endRow: number }> = [];
  const containers: Array<{ sym: CodeSymbol; startRow: number; endRow: number }> = [];

  // Collect exports and imports
  for (const match of matches) {
    for (const cap of match.captures) {
      if (cap.tag === "exp") {
        exportRanges.push({ startRow: cap.startRow, endRow: cap.endRow });
      }
      if (cap.tag === "imp") {
        imports.push(cap.text || lines[cap.startRow]?.trim() || "");
      }
    }
  }

  // Build symbols
  for (const match of matches) {
    const kindCapture = match.captures.find(c => KIND_MAP[c.tag]);
    const nameCapture = match.captures.find(c => c.tag === "name");
    if (!kindCapture) continue;

    const startRow = kindCapture.startRow;
    const endRow = kindCapture.endRow;
    const kind = KIND_MAP[kindCapture.tag];
    const name = nameCapture?.text || "anonymous";

    // Markdown-specific: extract heading level and build signature
    let signature: string;
    if (language === "markdown" && kind === "section") {
      const headingLine = lines[startRow] || "";
      const hashMatch = headingLine.match(/^(#{1,6})\s/);
      const level = hashMatch ? hashMatch[1].length : 1;
      signature = `${"#".repeat(level)} ${name}`;
    } else if (language === "markdown" && kind === "code") {
      const langTag = name !== "anonymous" ? name : "";
      signature = langTag ? "```" + langTag : "```";
    } else if (language === "markdown" && kind === "metadata") {
      signature = "---frontmatter---";
    } else if (language === "markdown" && kind === "reference") {
      signature = lines[startRow]?.trim() || name;
    } else {
      signature = extractSignatureFromLines(lines, startRow, endRow);
    }

    const comment = language === "markdown" ? undefined : findCommentAbove(lines, startRow);
    const docstring = language === "python" ? findPythonDocstringFromLines(lines, startRow, endRow) : undefined;

    const sym: CodeSymbol = {
      name,
      kind,
      signature,
      jsdoc: comment || docstring,
      lineStart: startRow,
      lineEnd: endRow,
      exported: isExported(name, startRow, endRow, exportRanges, lines, language),
    };

    if (CONTAINER_KINDS.has(kind)) {
      sym.children = [];
      containers.push({ sym, startRow, endRow });
    }

    symbols.push(sym);
  }

  // Markdown: deduplicate code_block matches. The catch-all `(fenced_code_block) @code_block`
  // pattern and the language-specific pattern both match the same block. Keep the named one.
  if (language === "markdown") {
    const codeBlocksByRange = new Map<string, CodeSymbol>();
    const duplicateCodeBlocks = new Set<CodeSymbol>();
    for (const sym of symbols) {
      if (sym.kind !== "code") continue;
      const rangeKey = `${sym.lineStart}:${sym.lineEnd}`;
      const existing = codeBlocksByRange.get(rangeKey);
      if (existing) {
        // Prefer the named version (has actual language tag vs "anonymous")
        if (sym.name !== "anonymous") {
          duplicateCodeBlocks.add(existing);
          codeBlocksByRange.set(rangeKey, sym);
        } else {
          duplicateCodeBlocks.add(sym);
        }
      } else {
        codeBlocksByRange.set(rangeKey, sym);
      }
    }
    if (duplicateCodeBlocks.size > 0) {
      const filtered = symbols.filter(s => !duplicateCodeBlocks.has(s));
      symbols.length = 0;
      symbols.push(...filtered);
    }
  }

  // Nest methods inside containers
  const nested = new Set<CodeSymbol>();
  for (const container of containers) {
    for (const sym of symbols) {
      if (sym === container.sym) continue;
      if (sym.lineStart > container.startRow && sym.lineEnd <= container.endRow) {
        if (sym.kind === "function") sym.kind = "method";
        container.sym.children!.push(sym);
        nested.add(sym);
      }
    }
  }

  return { symbols: symbols.filter(s => !nested.has(s)), imports };
}

// --- Main parse functions ---

export function parseFile(content: string, filePath: string, projectRoot?: string): FoldedFile {
  const userConfig = projectRoot ? loadUserGrammars(projectRoot) : EMPTY_USER_GRAMMAR_CONFIG;
  const language = detectLanguageWithUserGrammars(filePath, userConfig);
  const lines = content.split("\n");

  const grammarPath = resolveGrammarPathWithFallback(language, projectRoot);
  if (!grammarPath) {
    return {
      filePath, language, symbols: [], imports: [],
      totalLines: lines.length, foldedTokenEstimate: 50,
    };
  }

  const queryKey = getUserAwareQueryKey(language, userConfig);
  const queryFile = getQueryFile(queryKey);

  // Write content to temp file with correct extension for language detection
  const ext = filePath.slice(filePath.lastIndexOf(".")) || ".txt";
  const tmpDir = mkdtempSync(join(tmpdir(), "smart-src-"));
  const tmpFile = join(tmpDir, `source${ext}`);
  writeFileSync(tmpFile, content);

  try {
    const matches = runQuery(queryFile, tmpFile, grammarPath);
    const result = buildSymbols(matches, lines, language);

    const folded = formatFoldedView({
      filePath, language,
      symbols: result.symbols, imports: result.imports,
      totalLines: lines.length, foldedTokenEstimate: 0,
    });

    return {
      filePath, language,
      symbols: result.symbols, imports: result.imports,
      totalLines: lines.length,
      foldedTokenEstimate: Math.ceil(folded.length / 4),
    };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Batch parse multiple on-disk files. Groups by language for one CLI call per language.
 * Much faster than calling parseFile() per file (one process spawn per language vs per file).
 */
export function parseFilesBatch(
  files: Array<{ absolutePath: string; relativePath: string; content: string }>,
  projectRoot?: string
): Map<string, FoldedFile> {
  const results = new Map<string, FoldedFile>();
  const userConfig = projectRoot ? loadUserGrammars(projectRoot) : EMPTY_USER_GRAMMAR_CONFIG;

  // Group files by language (and thus by query + grammar)
  const languageGroups = new Map<string, typeof files>();
  for (const file of files) {
    const language = detectLanguageWithUserGrammars(file.relativePath, userConfig);
    if (!languageGroups.has(language)) languageGroups.set(language, []);
    languageGroups.get(language)!.push(file);
  }

  for (const [language, groupFiles] of languageGroups) {
    const grammarPath = resolveGrammarPathWithFallback(language, projectRoot);
    if (!grammarPath) {
      // No grammar — return empty results for these files
      for (const file of groupFiles) {
        const lines = file.content.split("\n");
        results.set(file.relativePath, {
          filePath: file.relativePath, language, symbols: [], imports: [],
          totalLines: lines.length, foldedTokenEstimate: 50,
        });
      }
      continue;
    }

    const queryKey = getUserAwareQueryKey(language, userConfig);
    const queryFile = getQueryFile(queryKey);

    // Run one batch query for all files of this language
    const absolutePaths = groupFiles.map(f => f.absolutePath);
    const batchResults = runBatchQuery(queryFile, absolutePaths, grammarPath);

    // Build FoldedFile for each file using the batch results
    for (const file of groupFiles) {
      const lines = file.content.split("\n");
      const matches = batchResults.get(file.absolutePath) || [];
      const symbolResult = buildSymbols(matches, lines, language);

      const folded = formatFoldedView({
        filePath: file.relativePath, language,
        symbols: symbolResult.symbols, imports: symbolResult.imports,
        totalLines: lines.length, foldedTokenEstimate: 0,
      });

      results.set(file.relativePath, {
        filePath: file.relativePath, language,
        symbols: symbolResult.symbols, imports: symbolResult.imports,
        totalLines: lines.length,
        foldedTokenEstimate: Math.ceil(folded.length / 4),
      });
    }
  }

  return results;
}

// --- Formatting ---

export function formatFoldedView(file: FoldedFile): string {
  if (file.language === "markdown") {
    return formatMarkdownFoldedView(file);
  }

  const parts: string[] = [];

  parts.push(`📁 ${file.filePath} (${file.language}, ${file.totalLines} lines)`);
  parts.push("");

  if (file.imports.length > 0) {
    parts.push(`  📦 Imports: ${file.imports.length} statements`);
    for (const imp of file.imports.slice(0, 10)) {
      parts.push(`    ${imp}`);
    }
    if (file.imports.length > 10) {
      parts.push(`    ... +${file.imports.length - 10} more`);
    }
    parts.push("");
  }

  for (const sym of file.symbols) {
    parts.push(formatSymbol(sym, "  "));
  }

  return parts.join("\n");
}

function formatMarkdownFoldedView(file: FoldedFile): string {
  const parts: string[] = [];
  // Total width for the content column (before the line range)
  const COL_WIDTH = 56;

  parts.push(`📄 ${file.filePath} (${file.language}, ${file.totalLines} lines)`);

  for (const sym of file.symbols) {
    if (sym.kind === "section") {
      // Extract heading level from the signature (count leading # characters)
      const hashMatch = sym.signature.match(/^(#{1,6})\s/);
      const level = hashMatch ? hashMatch[1].length : 1;
      const indent = "  ".repeat(level);
      const lineRange = `L${sym.lineStart + 1}`;
      const content = `${indent}${sym.signature}`;
      parts.push(`${content.padEnd(COL_WIDTH)}${lineRange}`);
    } else if (sym.kind === "code") {
      // Find containing heading level for indentation
      const containingLevel = findContainingHeadingLevel(file.symbols, sym.lineStart);
      const indent = "  ".repeat(containingLevel + 1);
      const lineRange = sym.lineStart === sym.lineEnd
        ? `L${sym.lineStart + 1}`
        : `L${sym.lineStart + 1}-${sym.lineEnd + 1}`;
      const content = `${indent}${sym.signature}`;
      parts.push(`${content.padEnd(COL_WIDTH)}${lineRange}`);
    } else if (sym.kind === "metadata") {
      const lineRange = sym.lineStart === sym.lineEnd
        ? `L${sym.lineStart + 1}`
        : `L${sym.lineStart + 1}-${sym.lineEnd + 1}`;
      const content = `  ${sym.signature}`;
      parts.push(`${content.padEnd(COL_WIDTH)}${lineRange}`);
    } else if (sym.kind === "reference") {
      const containingLevel = findContainingHeadingLevel(file.symbols, sym.lineStart);
      const indent = "  ".repeat(containingLevel + 1);
      const lineRange = `L${sym.lineStart + 1}`;
      const content = `${indent}↗ ${sym.name}`;
      parts.push(`${content.padEnd(COL_WIDTH)}${lineRange}`);
    }
  }

  return parts.join("\n");
}

/**
 * Find the heading level of the most recent section heading before the given line.
 * Returns 0 if no heading precedes the line.
 */
function findContainingHeadingLevel(symbols: CodeSymbol[], lineStart: number): number {
  let bestLevel = 0;
  for (const sym of symbols) {
    if (sym.kind === "section" && sym.lineStart < lineStart) {
      const hashMatch = sym.signature.match(/^(#{1,6})\s/);
      bestLevel = hashMatch ? hashMatch[1].length : 1;
    }
  }
  return bestLevel;
}

function formatSymbol(sym: CodeSymbol, indent: string): string {
  const parts: string[] = [];

  const icon = getSymbolIcon(sym.kind);
  const exportTag = sym.exported ? " [exported]" : "";
  const lineRange = sym.lineStart === sym.lineEnd
    ? `L${sym.lineStart + 1}`
    : `L${sym.lineStart + 1}-${sym.lineEnd + 1}`;

  parts.push(`${indent}${icon} ${sym.name}${exportTag} (${lineRange})`);
  parts.push(`${indent}  ${sym.signature}`);

  if (sym.jsdoc) {
    const jsdocLines = sym.jsdoc.split("\n");
    const firstLine = jsdocLines.find(l => {
      const t = l.replace(/^[\s*/]+/, "").replace(/^['"`]{3}/, "").trim();
      return t.length > 0 && !t.startsWith("/**");
    });
    if (firstLine) {
      const cleaned = firstLine.replace(/^[\s*/]+/, "").replace(/^['"`]{3}/, "").replace(/['"`]{3}$/, "").trim();
      if (cleaned) {
        parts.push(`${indent}  💬 ${cleaned}`);
      }
    }
  }

  if (sym.children && sym.children.length > 0) {
    for (const child of sym.children) {
      parts.push(formatSymbol(child, indent + "  "));
    }
  }

  return parts.join("\n");
}

function getSymbolIcon(kind: CodeSymbol["kind"]): string {
  const icons: Record<string, string> = {
    function: "ƒ", method: "ƒ", class: "◆", interface: "◇",
    type: "◇", const: "●", variable: "○", export: "→",
    struct: "◆", enum: "▣", trait: "◇", impl: "◈",
    property: "○", getter: "⇢", setter: "⇠", mixin: "◈",
    section: "§", code: "⌘", metadata: "◊", reference: "↗",
  };
  return icons[kind] || "·";
}

// --- Unfold ---

export function unfoldSymbol(content: string, filePath: string, symbolName: string): string | null {
  const file = parseFile(content, filePath);

  const findSymbol = (symbols: CodeSymbol[]): CodeSymbol | null => {
    for (const sym of symbols) {
      if (sym.name === symbolName) return sym;
      if (sym.children) {
        const found = findSymbol(sym.children);
        if (found) return found;
      }
    }
    return null;
  };

  const symbol = findSymbol(file.symbols);
  if (!symbol) return null;

  const lines = content.split("\n");

  // Markdown section unfold: return from heading to next heading of same or higher level
  if (file.language === "markdown" && symbol.kind === "section") {
    const hashMatch = symbol.signature.match(/^(#{1,6})\s/);
    const level = hashMatch ? hashMatch[1].length : 1;
    const start = symbol.lineStart;

    // Find the next heading at same or higher (lower number) level
    let end = lines.length - 1;
    for (const sym of file.symbols) {
      if (sym.kind === "section" && sym.lineStart > start) {
        const otherHashMatch = sym.signature.match(/^(#{1,6})\s/);
        const otherLevel = otherHashMatch ? otherHashMatch[1].length : 1;
        if (otherLevel <= level) {
          end = sym.lineStart - 1;
          // Trim trailing blank lines
          while (end > start && lines[end].trim() === "") end--;
          break;
        }
      }
    }

    const extracted = lines.slice(start, end + 1).join("\n");
    return `<!-- 📍 ${filePath} L${start + 1}-${end + 1} -->\n${extracted}`;
  }

  // Include preceding comments/decorators
  let start = symbol.lineStart;
  for (let i = symbol.lineStart - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (trimmed === "" || trimmed.startsWith("*") || trimmed.startsWith("/**") ||
        trimmed.startsWith("///") || trimmed.startsWith("//") ||
        trimmed.startsWith("#") || trimmed.startsWith("@") ||
        trimmed === "*/") {
      start = i;
    } else {
      break;
    }
  }

  const extracted = lines.slice(start, symbol.lineEnd + 1).join("\n");
  return `// 📍 ${filePath} L${start + 1}-${symbol.lineEnd + 1}\n${extracted}`;
}
