
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync, mkdirSync, rmSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { logger } from "../../utils/logger.js";
import { resolveDataDir } from "../../shared/paths.js";
import { treeSitterBinaryName } from "./tree-sitter-bin-name.js";

const _require = typeof __filename !== 'undefined'
  ? createRequire(__filename)
  : createRequire(import.meta.url);

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

function detectLanguage(filePath: string): string {
  const ext = filePath.slice(filePath.lastIndexOf("."));
  return LANG_MAP[ext] ?? "unknown";
}

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

const GRAMMAR_SUBDIR: Record<string, string> = {
  markdown: "tree-sitter-markdown",
};

function resolveGrammarPath(language: string): string | null {
  const pkg = GRAMMAR_PACKAGES[language];
  if (!pkg) return null;

  const subdir = GRAMMAR_SUBDIR[language];
  if (subdir) {
    try {
      const rootPkgPath = _require.resolve(pkg + "/package.json");
      const resolved = join(dirname(rootPkgPath), subdir);
      if (existsSync(join(resolved, "src"))) return resolved;
    } catch {
      // [ANTI-PATTERN IGNORED]: grammar package not installed is expected for unsupported languages
    }
    return null;
  }

  try {
    const packageJsonPath = _require.resolve(pkg + "/package.json");
    return dirname(packageJsonPath);
  } catch {
    // [ANTI-PATTERN IGNORED]: grammar package not installed is expected for unsupported languages; caller falls back to user grammars or a symbol-less folded view
    return null;
  }
}

const QUERIES: Record<string, string> = {
  jsts: `
(function_declaration name: (identifier) @name) @func
(generator_function_declaration name: (identifier) @name) @func
(lexical_declaration (variable_declarator name: (identifier) @name value: [(arrow_function) (function_expression) (generator_function)])) @const_func
(variable_declaration (variable_declarator name: (identifier) @name value: [(arrow_function) (function_expression) (generator_function)])) @const_func
(class_declaration name: (type_identifier) @name) @cls
(method_definition name: (property_identifier) @name) @method
(interface_declaration name: (type_identifier) @name) @iface
(type_alias_declaration name: (type_identifier) @name) @tdef
(enum_declaration name: (identifier) @name) @enm
(import_statement) @imp
(export_statement) @exp
`,

  // Plain JavaScript: the tree-sitter-javascript grammar has no type_identifier,
  // interface_declaration, type_alias_declaration or enum_declaration nodes, so it
  // cannot share the jsts query — tree-sitter aborts query compilation on the first
  // unknown node type. Class names are (identifier) here, not (type_identifier).
  js: `
(function_declaration name: (identifier) @name) @func
(generator_function_declaration name: (identifier) @name) @func
(lexical_declaration (variable_declarator name: (identifier) @name value: [(arrow_function) (function_expression) (generator_function)])) @const_func
(variable_declaration (variable_declarator name: (identifier) @name value: [(arrow_function) (function_expression) (generator_function)])) @const_func
(class_declaration name: (identifier) @name) @cls
(method_definition name: (property_identifier) @name) @method
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
(singleton_method object: (_) @receiver name: (identifier) @name) @method
(singleton_class value: (self)) @singleton_scope
(class name: (constant) @name) @cls
(module name: (constant) @name) @cls
(call method: (identifier) @name) @imp
`,

  java: `
(method_declaration name: (identifier) @name) @method
(constructor_declaration name: (identifier) @name parameters: (formal_parameters) @parameters) @ctor
(class_declaration name: (identifier) @name) @cls
(interface_declaration name: (identifier) @name) @iface
(enum_declaration name: (identifier) @name) @enm
(import_declaration) @imp
`,

  c: `
(function_definition) @func
(function_declarator declarator: (identifier) @function_name)
(type_definition type: (_) @aliased_type declarator: (type_identifier) @name) @tdef
(struct_specifier name: (type_identifier) @name body: (field_declaration_list)) @struct_def
(enum_specifier name: (type_identifier) @name body: (enumerator_list)) @enm
(preproc_include) @imp
`,

  cpp: `
(function_definition) @func
(function_declarator declarator: [(identifier) (field_identifier) (qualified_identifier) (destructor_name) (operator_name)] @function_name)
(type_definition type: (_) @aliased_type declarator: (type_identifier) @name) @tdef
(class_specifier name: (type_identifier) @name body: (field_declaration_list)) @cls
(struct_specifier name: (type_identifier) @name body: (field_declaration_list)) @struct_def
(enum_specifier name: (type_identifier) @name body: (enumerator_list)) @enm
(preproc_include) @imp
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
};

function getQueryKey(language: string): string {
  switch (language) {
    case "javascript":
      return "js";
    case "typescript":
    case "tsx":
      return "jsts";
    case "python": return "python";
    case "go": return "go";
    case "rust": return "rust";
    case "ruby": return "ruby";
    case "java": return "java";
    case "c": return "c";
    case "cpp": return "cpp";
    case "kotlin": return "kotlin";
    case "swift": return "swift";
    case "php": return "php";
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

// tree-sitter-cli installs `tree-sitter.exe` on Windows, not a bare `tree-sitter`
// (see ChromaMcpManager.resolveUvxCommand for the same platform-suffix idiom).
// Without the `.exe` suffix the existsSync check below always misses on Windows,
// silently falling through to a bare `tree-sitter` that may not be on PATH —
// smart file parsing then returns empty results with no error.
export function resolveTreeSitterBinPath(platform: NodeJS.Platform = process.platform): string {
  const binName = treeSitterBinaryName(platform);

  try {
    const pkgPath = _require.resolve("tree-sitter-cli/package.json");
    const binPath = join(dirname(pkgPath), binName);
    if (existsSync(binPath)) {
      return binPath;
    }
  } catch {
    // [ANTI-PATTERN IGNORED]: tree-sitter-cli not in node_modules is expected; falls back to PATH
  }

  return binName;
}

let cachedBinPath: string | null = null;

function getTreeSitterBin(): string {
  if (cachedBinPath) return cachedBinPath;
  cachedBinPath = resolveTreeSitterBinPath();
  return cachedBinPath;
}

// `tree-sitter query -p <grammar-dir>` implies --rebuild (#3926): the CLI
// recompiles the grammar from source on EVERY invocation, so each smart_outline
// / smart_search / smart_unfold call paid a full C compile before it could match
// a single node. Building the grammar once and passing the artifact with
// `-l <lib> --lang-name <language>` turns the same call into a library load.
// Grammar libraries live in the data dir, not in node_modules: a plugin update
// replaces node_modules wholesale, and writing into a package directory that the
// installer owns is not ours to do.
const GRAMMAR_LIB_DIR = join(resolveDataDir(), "tree-sitter-libs");

// dlopen does not care about the suffix, but the platform-native one keeps the
// directory readable and matches what `tree-sitter build` emits elsewhere.
const GRAMMAR_LIB_EXTENSION = process.platform === "win32"
  ? ".dll"
  : process.platform === "darwin" ? ".dylib" : ".so";

// A grammar is `src/parser.c` plus an optional external scanner. Both are
// generated artifacts shipped in the npm package, so their mtimes are the
// cheapest available proxy for "this grammar changed".
const GRAMMAR_SOURCE_FILES = ["parser.c", "scanner.c", "scanner.cc"];

// Languages whose artifact could not be built or would not bind. Falling back to
// `-p` per call is correct but slow, so the decision is remembered rather than
// re-derived for every file batch.
const grammarLibOptOut = new Set<string>();

/** @internal — test-only: clear the build opt-out set so a prior failure does
 *  not permanently poison subsequent test cases running in the same process. */
export function _resetGrammarLibOptOut(): void {
  grammarLibOptOut.clear();
}

function newestGrammarSourceMtime(grammarPath: string): number {
  let newest = 0;
  for (const file of GRAMMAR_SOURCE_FILES) {
    try {
      const stats = statSync(join(grammarPath, "src", file));
      if (stats.mtimeMs > newest) newest = stats.mtimeMs;
    } catch {
      // [ANTI-PATTERN IGNORED]: an absent scanner is the normal case for most
      // grammars; only parser.c is guaranteed to exist.
    }
  }
  return newest;
}

/**
 * Compile `grammarPath` into a reusable dynamic library, or return null when the
 * caller should stay on the `--grammar-path` path.
 *
 * A library older than the grammar sources is rebuilt: a plugin update ships new
 * grammar packages, and silently querying with the previous grammar would return
 * wrong symbols instead of an error.
 */
function ensureGrammarLib(language: string, grammarPath: string): string | null {
  if (grammarLibOptOut.has(language)) return null;

  const libPath = join(GRAMMAR_LIB_DIR, `${language}${GRAMMAR_LIB_EXTENSION}`);

  try {
    // Deliberately re-stated per call instead of memoized: four stats cost
    // nothing next to the process spawn they guard, and a memo would pin a
    // long-lived MCP server to the grammar that was current at boot.
    const needsBuild = !existsSync(libPath)
      || statSync(libPath).mtimeMs < newestGrammarSourceMtime(grammarPath);

    if (needsBuild) {
      mkdirSync(GRAMMAR_LIB_DIR, { recursive: true });
      execFileSync(getTreeSitterBin(), ["build", "-o", libPath, grammarPath], {
        encoding: "utf-8",
        timeout: 120000,
        stdio: ["pipe", "pipe", "pipe"],
      });
    }

    return libPath;
  } catch (error) {
    logger.debug('WORKER', `tree-sitter build failed for ${language}; falling back to --grammar-path`, undefined, error instanceof Error ? error : undefined);
    grammarLibOptOut.add(language);
    return null;
  }
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

function runQuery(queryFile: string, sourceFile: string, grammarPath: string, language: string): RawMatch[] {
  const result = runBatchQuery(queryFile, [sourceFile], grammarPath, language);
  return result.get(sourceFile) || [];
}

function execQuery(execArgs: string[], sourceFileCount: number): string | null {
  try {
    return execFileSync(getTreeSitterBin(), execArgs, { encoding: "utf-8", timeout: 30000, stdio: ["pipe", "pipe", "pipe"] });
  } catch (error) {
    logger.debug('WORKER', `tree-sitter query failed for ${sourceFileCount} file(s)`, undefined, error instanceof Error ? error : undefined);
    return null;
  }
}

function runBatchQuery(queryFile: string, sourceFiles: string[], grammarPath: string, language: string): Map<string, RawMatch[]> {
  if (sourceFiles.length === 0) return new Map();

  const libPath = ensureGrammarLib(language, grammarPath);
  if (libPath) {
    const output = execQuery(["query", "-l", libPath, "--lang-name", language, queryFile, ...sourceFiles], sourceFiles.length);
    if (output !== null) return parseMultiFileQueryOutput(output);

    // The artifact exists but will not bind — a grammar whose language function
    // is not named after our language key would fail here on every call. Drop
    // back to --grammar-path permanently rather than paying two spawns per batch.
    grammarLibOptOut.add(language);
  }

  const output = execQuery(["query", "-p", grammarPath, queryFile, ...sourceFiles], sourceFiles.length);
  return output === null ? new Map() : parseMultiFileQueryOutput(output);
}

function parseMultiFileQueryOutput(output: string): Map<string, RawMatch[]> {
  const fileMatches = new Map<string, RawMatch[]>();
  let currentFile: string | null = null;
  let currentMatch: RawMatch | null = null;

  for (const line of output.split("\n")) {
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

const KIND_MAP: Record<string, CodeSymbol["kind"]> = {
  func: "function",
  const_func: "function",
  cls: "class",
  method: "method",
  ctor: "method",
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

function extractSignatureFromLines(lines: string[], startRow: number, endRow: number, maxLen: number = 200, startCol: number = 0): string {
  const firstLine = Buffer.from(lines[startRow] || "").subarray(startCol).toString();
  let sig = firstLine;

  if (!sig.trimEnd().endsWith("{") && !sig.trimEnd().endsWith(":")) {
    const chunk = [firstLine, ...lines.slice(startRow + 1, Math.min(startRow + 10, endRow + 1))].join("\n");
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

// Tree-sitter columns are UTF-8 byte offsets, not JS string indices, and the
// CLI prints no `text` for a capture that spans rows. Cutting the last row at
// its end column before the first row at its start column keeps a one-row
// capture free of offset arithmetic.
function captureLines(lines: string[], capture: RawCapture): string[] {
  const captured = lines.slice(capture.startRow, capture.endRow + 1);
  if (captured.length === 0) return [];
  const last = captured.length - 1;
  captured[last] = Buffer.from(captured[last] ?? "").subarray(0, capture.endCol).toString();
  captured[0] = Buffer.from(captured[0] ?? "").subarray(capture.startCol).toString();
  return captured;
}

// Tree-sitter ranges include columns: row-only comparisons lose methods
// on the opening line and cannot distinguish adjacent one-line declarations.
function rangeContains(outer: RawCapture, inner: RawCapture): boolean {
  return (inner.startRow > outer.startRow
      || (inner.startRow === outer.startRow && inner.startCol >= outer.startCol))
    && (inner.endRow < outer.endRow
      || (inner.endRow === outer.endRow && inner.endCol <= outer.endCol));
}

function buildSymbols(matches: RawMatch[], lines: string[], language: string): { symbols: CodeSymbol[]; imports: string[] } {
  const symbols: CodeSymbol[] = [];
  const imports: string[] = [];
  const exportRanges: Array<{ startRow: number; endRow: number }> = [];
  const singletonScopes: RawCapture[] = [];
  const ranges = new Map<CodeSymbol, RawCapture>();
  const aliasedTypes = new Map<CodeSymbol, RawCapture>();
  const containers: Array<{ sym: CodeSymbol; range: RawCapture }> = [];

  for (const match of matches) {
    for (const cap of match.captures) {
      if (cap.tag === "exp") {
        exportRanges.push({ startRow: cap.startRow, endRow: cap.endRow });
      }
      if (cap.tag === "singleton_scope") {
        singletonScopes.push(cap);
      }
      if (cap.tag === "imp") {
        // Outlines go straight into an agent's context, so each entry is one
        // line capped at the 200-char signature budget: a Go `import ( … )`
        // group, a Ruby call with a `do … end` block or an SCSS `@include { … }`
        // is one capture that can span a whole file. Keep both ends, because an
        // import's module source comes last.
        const importText = captureLines(lines, cap).map(line => line.trim()).filter(Boolean).join(" ");
        imports.push(importText.length > 200
          ? `${importText.slice(0, 140)} … ${importText.slice(-55)}`
          : importText);
      }
    }
  }

  // Names are captured independently of the surrounding pointer/reference
  // wrappers. The first native function declarator inside a definition names
  // that function, before any callback parameters or nested definitions.
  const functionNames = matches.flatMap(match => match.captures.filter(c => c.tag === "function_name"))
    .sort((a, b) => a.startRow - b.startRow || a.startCol - b.startCol);
  const findFunctionName = (definition: RawCapture): RawCapture | undefined => {
    let low = 0;
    let high = functionNames.length;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      const capture = functionNames[mid];
      if (capture.startRow < definition.startRow
        || (capture.startRow === definition.startRow && capture.startCol < definition.startCol)) low = mid + 1;
      else high = mid;
    }
    const capture = functionNames[low];
    return capture && (capture.endRow < definition.endRow
      || (capture.endRow === definition.endRow && capture.endCol <= definition.endCol)) ? capture : undefined;
  };
  for (const match of matches) {
    const kindCapture = match.captures.find(c => KIND_MAP[c.tag]);
    const nameCapture = match.captures.find(c => c.tag === "name")
      ?? (kindCapture?.tag === "func" && (language === "c" || language === "cpp")
        ? findFunctionName(kindCapture)
        : undefined);
    if (!kindCapture) continue;

    const startRow = kindCapture.startRow;
    const endRow = kindCapture.endRow;
    const kind = KIND_MAP[kindCapture.tag];
    let name = nameCapture?.text || "anonymous";
    if (kindCapture.tag === "ctor") {
      const parameters = match.captures.find(c => c.tag === "parameters");
      if (parameters) name += captureLines(lines, parameters).join(" ").replace(/\s+/g, " ").trim();
    }
    const receiver = match.captures.find(c => c.tag === "receiver");
    const receiverText = receiver && captureLines(lines, receiver).join(" ").trim();
    if (receiverText) name = `${receiverText}.${name}`;

    let signature: string;
    if (language === "markdown" && kind === "section") {
      // Setext heading paragraphs include a trailing newline (and can span
      // lines), so the CLI prints only their range, without a `text` value.
      if (nameCapture && !nameCapture.text) {
        name = captureLines(lines, nameCapture).join(" ").trim().replace(/\s+/g, " ");
      }
      const headingLine = lines[startRow] || "";
      const hashMatch = headingLine.match(/^(#{1,6})\s/);
      const underline = lines[endRow - (kindCapture.endCol === 0 ? 1 : 0)] || "";
      const level = hashMatch ? hashMatch[1].length : /^\s*-+\s*$/.test(underline) ? 2 : 1;
      signature = `${"#".repeat(level)} ${name}`;
    } else if (language === "markdown" && kind === "code") {
      const langTag = name !== "anonymous" ? name : "";
      signature = langTag ? "```" + langTag : "```";
    } else if (language === "markdown" && kind === "metadata") {
      signature = "---frontmatter---";
    } else if (language === "markdown" && kind === "reference") {
      signature = lines[startRow]?.trim() || name;
    } else {
      signature = extractSignatureFromLines(lines, startRow, endRow, 200, kindCapture.startCol);
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
      containers.push({ sym, range: kindCapture });
    }

    ranges.set(sym, kindCapture);
    const aliasedType = match.captures.find(c => c.tag === "aliased_type");
    if (aliasedType) aliasedTypes.set(sym, aliasedType);
    symbols.push(sym);
  }

  if (language === "markdown") {
    const codeBlocksByRange = new Map<string, CodeSymbol>();
    const duplicateCodeBlocks = new Set<CodeSymbol>();
    for (const sym of symbols) {
      if (sym.kind !== "code") continue;
      const rangeKey = `${sym.lineStart}:${sym.lineEnd}`;
      const existing = codeBlocksByRange.get(rangeKey);
      if (existing) {
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

  // A named typedef can capture both the alias and its same-named struct.
  // Retain one structural symbol, with the enclosing typedef source range.
  const duplicateAliases = new Set<CodeSymbol>();
  if (language === "c" || language === "cpp") {
    const structures = new Map<string, typeof containers>();
    for (const container of containers) {
      const entries = structures.get(container.sym.name) ?? [];
      entries.push(container);
      structures.set(container.sym.name, entries);
    }
    for (const alias of symbols.filter(symbol => symbol.kind === "type")) {
      const range = ranges.get(alias)!;
      const aliasedType = aliasedTypes.get(alias);
      if (!aliasedType) continue;
      // Only the direct type expression denotes the typedef's underlying type.
      // A nested struct may share the alias name while denoting a distinct type.
      const structure = structures.get(alias.name)?.find(({ range: inner }) =>
        inner.startRow === aliasedType.startRow && inner.startCol === aliasedType.startCol
        && inner.endRow === aliasedType.endRow && inner.endCol === aliasedType.endCol);
      if (!structure) continue;
      structure.sym.lineStart = alias.lineStart;
      structure.sym.lineEnd = alias.lineEnd;
      structure.sym.signature = alias.signature;
      structure.range = range;
      ranges.set(structure.sym, range);
      duplicateAliases.add(alias);
    }
  }

  // The latest containing start is the nearest lexical container, so a nested
  // class's method is attached once instead of also appearing on every ancestor.
  containers.sort((a, b) => b.range.startRow - a.range.startRow
    || b.range.startCol - a.range.startCol);
  const nested = new Set<CodeSymbol>(duplicateAliases);
  for (const sym of symbols) {
    if (duplicateAliases.has(sym)) continue;
    const range = ranges.get(sym)!;
    const owner = containers.find(({ sym: candidate, range: parent }) => candidate !== sym
      && rangeContains(parent, range));
    // A Ruby `def` inside `class << self` defines a class method, so it is named
    // like `def self.x` — unless a class or module opened in that block is nearer.
    if (sym.kind === "function" && singletonScopes.some(scope => rangeContains(scope, range)
      && (!owner || rangeContains(owner.range, scope)))) {
      sym.name = `self.${sym.name}`;
      sym.kind = "method";
    }
    if (owner) {
      if (sym.kind === "function") sym.kind = "method";
      owner.sym.children!.push(sym);
      nested.add(sym);
    }
  }

  return { symbols: symbols.filter(s => !nested.has(s)), imports };
}

export function parseFile(content: string, filePath: string): FoldedFile {
  const language = detectLanguage(filePath);
  const lines = content.split("\n");

  const grammarPath = resolveGrammarPath(language);
  if (!grammarPath) {
    return {
      filePath, language, symbols: [], imports: [],
      totalLines: lines.length, foldedTokenEstimate: 50,
    };
  }

  const queryFile = getQueryFile(getQueryKey(language));

  const ext = filePath.slice(filePath.lastIndexOf(".")) || ".txt";
  const tmpDir = mkdtempSync(join(tmpdir(), "smart-src-"));
  const tmpFile = join(tmpDir, `source${ext}`);
  writeFileSync(tmpFile, content);

  try {
    const matches = runQuery(queryFile, tmpFile, grammarPath, language);
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

export function parseFilesBatch(
  files: Array<{ absolutePath: string; relativePath: string; content: string }>
): Map<string, FoldedFile> {
  const results = new Map<string, FoldedFile>();

  const languageGroups = new Map<string, typeof files>();
  for (const file of files) {
    const language = detectLanguage(file.relativePath);
    if (!languageGroups.has(language)) languageGroups.set(language, []);
    languageGroups.get(language)!.push(file);
  }

  for (const [language, groupFiles] of languageGroups) {
    const grammarPath = resolveGrammarPath(language);
    if (!grammarPath) {
      for (const file of groupFiles) {
        const lines = file.content.split("\n");
        results.set(file.relativePath, {
          filePath: file.relativePath, language, symbols: [], imports: [],
          totalLines: lines.length, foldedTokenEstimate: 50,
        });
      }
      continue;
    }

    const queryFile = getQueryFile(getQueryKey(language));

    const absolutePaths = groupFiles.map(f => f.absolutePath);
    const batchResults = runBatchQuery(queryFile, absolutePaths, grammarPath, language);

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
  const COL_WIDTH = 56;

  parts.push(`📄 ${file.filePath} (${file.language}, ${file.totalLines} lines)`);

  for (const sym of file.symbols) {
    if (sym.kind === "section") {
      const hashMatch = sym.signature.match(/^(#{1,6})\s/);
      const level = hashMatch ? hashMatch[1].length : 1;
      const indent = "  ".repeat(level);
      const lineRange = `L${sym.lineStart + 1}`;
      const content = `${indent}${sym.signature}`;
      parts.push(`${content.padEnd(COL_WIDTH)}${lineRange}`);
    } else if (sym.kind === "code") {
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

// Ruby distinguishes instance methods with # and singleton methods with .
// CSS selectors escape literal dots before adding ownership separators.
export function qualifySymbolName(name: string, parent: string | undefined, language: string, kind?: CodeSymbol["kind"]): string {
  if (language === "ruby" && kind === "method") {
    if (name.startsWith("self.")) return parent ? `${parent}.${name.slice(5)}` : name;
    if (name.includes(".")) return name;
    return parent ? `${parent}#${name}` : name;
  }
  const segment = language === "css" || language === "scss"
    ? name.replace(/\\/g, "\\\\").replace(/\./g, "\\.") : name;
  return parent ? `${parent}.${segment}` : segment;
}

export function unfoldSymbol(content: string, filePath: string, symbolName: string): string | null {
  const file = parseFile(content, filePath);

  const findSymbol = (symbols: CodeSymbol[], qualified: boolean, parent?: string): CodeSymbol | null => {
    for (const sym of symbols) {
      const qualifiedName = qualifySymbolName(sym.name, parent, file.language, sym.kind);
      if ((qualified ? qualifiedName : sym.name) === symbolName) return sym;
      if (sym.children) {
        const found = findSymbol(sym.children, qualified, qualifiedName);
        if (found) return found;
      }
    }
    return null;
  };

  const symbol = findSymbol(file.symbols, true) ?? findSymbol(file.symbols, false);
  if (!symbol) return null;

  const lines = content.split("\n");

  if (file.language === "markdown" && symbol.kind === "section") {
    const hashMatch = symbol.signature.match(/^(#{1,6})\s/);
    const level = hashMatch ? hashMatch[1].length : 1;
    const start = symbol.lineStart;

    let end = lines.length - 1;
    for (const sym of file.symbols) {
      if (sym.kind === "section" && sym.lineStart > start) {
        const otherHashMatch = sym.signature.match(/^(#{1,6})\s/);
        const otherLevel = otherHashMatch ? otherHashMatch[1].length : 1;
        if (otherLevel <= level) {
          end = sym.lineStart - 1;
          while (end > start && lines[end].trim() === "") end--;
          break;
        }
      }
    }

    const extracted = lines.slice(start, end + 1).join("\n");
    return `<!-- 📍 ${filePath} L${start + 1}-${end + 1} -->\n${extracted}`;
  }

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
