/**
 * Code structure parser — uses tree-sitter AST for accurate structural extraction.
 *
 * This is the "folding" engine. It produces a table-of-contents view of any
 * code file: what's defined, what it looks like from the outside, and where
 * it lives in the file — using real AST parsing, not regex.
 *
 * Supported: JS, TS, Python, Go, Rust, Ruby, Java, C, C++
 *
 * by Copter Labs
 */

import Parser from "tree-sitter";
import type { SyntaxNode } from "tree-sitter";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// --- Language loading ---

const grammarCache = new Map<string, unknown>();

function loadGrammar(language: string): unknown | null {
  if (grammarCache.has(language)) return grammarCache.get(language)!;

  try {
    let grammar: unknown;
    switch (language) {
      case "javascript":
        grammar = require("tree-sitter-javascript");
        break;
      case "typescript":
        grammar = require("tree-sitter-typescript").typescript;
        break;
      case "tsx":
        grammar = require("tree-sitter-typescript").tsx;
        break;
      case "python":
        grammar = require("tree-sitter-python");
        break;
      case "go":
        grammar = require("tree-sitter-go");
        break;
      case "rust":
        grammar = require("tree-sitter-rust");
        break;
      case "ruby":
        grammar = require("tree-sitter-ruby");
        break;
      case "java":
        grammar = require("tree-sitter-java");
        break;
      case "c":
        grammar = require("tree-sitter-c");
        break;
      case "cpp":
        grammar = require("tree-sitter-cpp");
        break;
      default:
        return null;
    }
    grammarCache.set(language, grammar);
    return grammar;
  } catch {
    return null;
  }
}

// --- Types ---

export interface CodeSymbol {
  name: string;
  kind: "function" | "class" | "method" | "interface" | "type" | "const" | "variable" | "export" | "struct" | "enum" | "trait" | "impl" | "property" | "getter" | "setter";
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
};

export function detectLanguage(filePath: string): string {
  const ext = filePath.slice(filePath.lastIndexOf("."));
  return LANG_MAP[ext] || "unknown";
}

// --- Comment / JSDoc extraction ---

function findPrecedingComment(node: SyntaxNode, _sourceLines: string[]): string | undefined {
  const prev = node.previousNamedSibling;
  if (!prev) return undefined;

  if (prev.type === "comment" || prev.type === "line_comment" || prev.type === "block_comment") {
    const text = prev.text.trim();
    if (text.startsWith("/**") || text.startsWith("///") || text.startsWith("//!") || text.startsWith("//")) {
      return text;
    }
  }
  return undefined;
}

function findPythonDocstring(node: SyntaxNode): string | undefined {
  const body = node.childForFieldName("body");
  if (!body) return undefined;

  const firstChild = body.firstNamedChild;
  if (!firstChild || firstChild.type !== "expression_statement") return undefined;

  const expr = firstChild.firstNamedChild;
  if (expr && (expr.type === "string" || expr.type === "concatenated_string")) {
    const text = expr.text.trim();
    if (text.startsWith('"""') || text.startsWith("'''") || text.startsWith('"') || text.startsWith("'")) {
      return text;
    }
  }
  return undefined;
}

// --- Signature extraction ---

function extractSignature(node: SyntaxNode, maxLen: number = 200): string {
  const text = node.text;
  const firstLine = text.split("\n")[0];

  let sig = firstLine;

  if (!sig.trimEnd().endsWith("{") && !sig.trimEnd().endsWith(":")) {
    const braceIdx = text.indexOf("{");
    const colonIdx = text.indexOf(":");
    const bodyStart = braceIdx !== -1 ? braceIdx : colonIdx;

    if (bodyStart !== -1 && bodyStart < 500) {
      sig = text.slice(0, bodyStart).replace(/\n/g, " ").replace(/\s+/g, " ").trim();
    }
  }

  sig = sig.replace(/\s*[{:]\s*$/, "").trim();

  if (sig.length > maxLen) {
    sig = sig.slice(0, maxLen - 3) + "...";
  }
  return sig;
}

// --- AST extraction per language ---

interface ExtractContext {
  sourceLines: string[];
  language: string;
}

// ---- JavaScript / TypeScript ----

function extractJSTSSymbols(rootNode: SyntaxNode, ctx: ExtractContext): { symbols: CodeSymbol[]; imports: string[] } {
  const symbols: CodeSymbol[] = [];
  const imports: string[] = [];

  for (const node of rootNode.namedChildren) {
    if (node.type === "import_statement") {
      imports.push(node.text.split("\n")[0]);
      continue;
    }

    if (node.type === "export_statement") {
      const decl = node.childForFieldName("declaration") || node.namedChildren.find(
        c => c.type !== "export" && c.type !== "default"
      );
      if (decl) {
        const sym = extractJSTSDeclaration(decl, ctx, true);
        if (sym) symbols.push(sym);
      }
      continue;
    }

    const sym = extractJSTSDeclaration(node, ctx, false);
    if (sym) symbols.push(sym);
  }

  return { symbols, imports };
}

function extractJSTSDeclaration(node: SyntaxNode, ctx: ExtractContext, exported: boolean): CodeSymbol | null {
  const commentTarget = node.parent?.type === "export_statement" ? node.parent : node;
  const jsdoc = findPrecedingComment(commentTarget, ctx.sourceLines);

  switch (node.type) {
    case "function_declaration": {
      const name = node.childForFieldName("name")?.text || "anonymous";
      return {
        name, kind: "function", signature: extractSignature(node), jsdoc,
        lineStart: node.startPosition.row, lineEnd: node.endPosition.row, exported,
      };
    }

    case "class_declaration": {
      const name = node.childForFieldName("name")?.text || "anonymous";
      const sym: CodeSymbol = {
        name, kind: "class", signature: extractSignature(node), jsdoc,
        lineStart: node.startPosition.row, lineEnd: node.endPosition.row,
        exported, children: [],
      };
      const body = node.childForFieldName("body");
      if (body) {
        for (const member of body.namedChildren) {
          const child = extractJSTSClassMember(member, ctx);
          if (child) sym.children!.push(child);
        }
      }
      return sym;
    }

    case "interface_declaration": {
      const name = node.childForFieldName("name")?.text || "anonymous";
      return {
        name, kind: "interface", signature: extractSignature(node), jsdoc,
        lineStart: node.startPosition.row, lineEnd: node.endPosition.row, exported,
      };
    }

    case "type_alias_declaration": {
      const name = node.childForFieldName("name")?.text || "anonymous";
      return {
        name, kind: "type", signature: extractSignature(node), jsdoc,
        lineStart: node.startPosition.row, lineEnd: node.endPosition.row, exported,
      };
    }

    case "enum_declaration": {
      const name = node.childForFieldName("name")?.text || "anonymous";
      return {
        name, kind: "enum", signature: extractSignature(node), jsdoc,
        lineStart: node.startPosition.row, lineEnd: node.endPosition.row, exported,
      };
    }

    case "lexical_declaration": {
      const declarator = node.namedChildren.find(c => c.type === "variable_declarator");
      if (!declarator) return null;
      const name = declarator.childForFieldName("name")?.text || "anonymous";
      const value = declarator.childForFieldName("value");
      const isFunc = value && (
        value.type === "arrow_function" ||
        value.type === "function_expression" ||
        value.type === "function"
      );
      return {
        name, kind: isFunc ? "function" : "const",
        signature: extractSignature(node), jsdoc,
        lineStart: node.startPosition.row, lineEnd: node.endPosition.row, exported,
      };
    }

    default:
      return null;
  }
}

function extractJSTSClassMember(node: SyntaxNode, ctx: ExtractContext): CodeSymbol | null {
  if (node.type === "method_definition") {
    const name = node.childForFieldName("name")?.text || "anonymous";
    const jsdoc = findPrecedingComment(node, ctx.sourceLines);
    const isPrivate = node.children.some(c => c.text === "private");
    const isGetter = node.children.some(c => c.type === "get");
    const isSetter = node.children.some(c => c.type === "set");

    return {
      name, kind: isGetter ? "getter" : isSetter ? "setter" : "method",
      signature: extractSignature(node), jsdoc,
      lineStart: node.startPosition.row, lineEnd: node.endPosition.row,
      exported: !isPrivate,
    };
  }

  if (node.type === "public_field_definition") {
    const name = node.children.find(c => c.type === "property_identifier")?.text || "unknown";
    return {
      name, kind: "property",
      signature: node.text.split("\n")[0].replace(/;$/, "").trim(),
      lineStart: node.startPosition.row, lineEnd: node.endPosition.row,
      exported: !node.children.some(c => c.text === "private"),
    };
  }

  return null;
}

// ---- Python ----

function extractPythonSymbols(rootNode: SyntaxNode, ctx: ExtractContext): { symbols: CodeSymbol[]; imports: string[] } {
  const symbols: CodeSymbol[] = [];
  const imports: string[] = [];

  for (const node of rootNode.namedChildren) {
    if (node.type === "import_statement" || node.type === "import_from_statement") {
      imports.push(node.text.split("\n")[0]);
      continue;
    }

    if (node.type === "class_definition") {
      symbols.push(extractPythonClass(node, ctx));
      continue;
    }

    if (node.type === "function_definition") {
      const name = node.childForFieldName("name")?.text || "anonymous";
      const docstring = findPythonDocstring(node);
      const jsdoc = findPrecedingComment(node, ctx.sourceLines) || docstring;
      symbols.push({
        name, kind: "function", signature: extractSignature(node), jsdoc,
        lineStart: node.startPosition.row, lineEnd: node.endPosition.row,
        exported: !name.startsWith("_"),
      });
      continue;
    }

    if (node.type === "decorated_definition") {
      const inner = node.namedChildren.find(c =>
        c.type === "function_definition" || c.type === "class_definition"
      );
      if (inner?.type === "class_definition") {
        symbols.push(extractPythonClass(inner, ctx, node));
      } else if (inner?.type === "function_definition") {
        const name = inner.childForFieldName("name")?.text || "anonymous";
        const docstring = findPythonDocstring(inner);
        const jsdoc = findPrecedingComment(node, ctx.sourceLines) || docstring;
        symbols.push({
          name, kind: "function", signature: extractSignature(node), jsdoc,
          lineStart: node.startPosition.row, lineEnd: inner.endPosition.row,
          exported: !name.startsWith("_"),
        });
      }
      continue;
    }
  }

  return { symbols, imports };
}

function extractPythonClass(node: SyntaxNode, ctx: ExtractContext, decorator?: SyntaxNode): CodeSymbol {
  const name = node.childForFieldName("name")?.text || "anonymous";
  const docstring = findPythonDocstring(node);
  const jsdoc = findPrecedingComment(decorator || node, ctx.sourceLines) || docstring;
  const sym: CodeSymbol = {
    name, kind: "class", signature: extractSignature(node), jsdoc,
    lineStart: (decorator || node).startPosition.row, lineEnd: node.endPosition.row,
    exported: !name.startsWith("_"), children: [],
  };

  const body = node.childForFieldName("body");
  if (body) {
    for (const member of body.namedChildren) {
      if (member.type === "function_definition") {
        const methodName = member.childForFieldName("name")?.text || "anonymous";
        const methodDoc = findPythonDocstring(member) || findPrecedingComment(member, ctx.sourceLines);
        sym.children!.push({
          name: methodName, kind: "method",
          signature: extractSignature(member), jsdoc: methodDoc,
          lineStart: member.startPosition.row, lineEnd: member.endPosition.row,
          exported: !methodName.startsWith("_"),
        });
      } else if (member.type === "decorated_definition") {
        const inner = member.namedChildren.find(c => c.type === "function_definition");
        if (inner) {
          const methodName = inner.childForFieldName("name")?.text || "anonymous";
          const methodDoc = findPythonDocstring(inner) || findPrecedingComment(member, ctx.sourceLines);
          sym.children!.push({
            name: methodName, kind: "method",
            signature: extractSignature(member), jsdoc: methodDoc,
            lineStart: member.startPosition.row, lineEnd: inner.endPosition.row,
            exported: !methodName.startsWith("_"),
          });
        }
      }
    }
  }
  return sym;
}

// ---- Go ----

function extractGoSymbols(rootNode: SyntaxNode, ctx: ExtractContext): { symbols: CodeSymbol[]; imports: string[] } {
  const symbols: CodeSymbol[] = [];
  const imports: string[] = [];
  const typeMap = new Map<string, CodeSymbol>();

  for (const node of rootNode.namedChildren) {
    if (node.type === "import_declaration") {
      imports.push(node.text.split("\n")[0]);
      continue;
    }

    if (node.type === "function_declaration") {
      const name = node.childForFieldName("name")?.text || "anonymous";
      const jsdoc = findPrecedingComment(node, ctx.sourceLines);
      symbols.push({
        name, kind: "function", signature: extractSignature(node), jsdoc,
        lineStart: node.startPosition.row, lineEnd: node.endPosition.row,
        exported: name[0] === name[0].toUpperCase(),
      });
      continue;
    }

    if (node.type === "method_declaration") {
      const name = node.childForFieldName("name")?.text || "anonymous";
      const receiver = node.childForFieldName("receiver");
      const receiverType = receiver?.text?.replace(/[*()]/g, "").trim().split(/\s+/).pop() || "";
      const jsdoc = findPrecedingComment(node, ctx.sourceLines);

      const method: CodeSymbol = {
        name, kind: "method", signature: extractSignature(node), jsdoc,
        lineStart: node.startPosition.row, lineEnd: node.endPosition.row,
        exported: name[0] === name[0].toUpperCase(), parent: receiverType,
      };

      const parentSym = typeMap.get(receiverType);
      if (parentSym?.children) {
        parentSym.children.push(method);
      } else {
        symbols.push(method);
      }
      continue;
    }

    if (node.type === "type_declaration") {
      for (const spec of node.namedChildren) {
        if (spec.type === "type_spec") {
          const name = spec.childForFieldName("name")?.text || "anonymous";
          const typeNode = spec.childForFieldName("type");
          const kind = typeNode?.type === "interface_type" ? "interface" as const : "struct" as const;
          const jsdoc = findPrecedingComment(node, ctx.sourceLines);
          const sym: CodeSymbol = {
            name, kind, signature: extractSignature(node), jsdoc,
            lineStart: node.startPosition.row, lineEnd: node.endPosition.row,
            exported: name[0] === name[0].toUpperCase(), children: [],
          };
          typeMap.set(name, sym);
          symbols.push(sym);
        }
      }
      continue;
    }
  }

  return { symbols, imports };
}

// ---- Rust ----

function extractRustSymbols(rootNode: SyntaxNode, ctx: ExtractContext): { symbols: CodeSymbol[]; imports: string[] } {
  const symbols: CodeSymbol[] = [];
  const imports: string[] = [];

  for (const node of rootNode.namedChildren) {
    if (node.type === "use_declaration") {
      imports.push(node.text.split("\n")[0]);
      continue;
    }

    const jsdoc = findPrecedingComment(node, ctx.sourceLines);
    const isPub = node.text.trimStart().startsWith("pub");

    if (node.type === "function_item") {
      const name = node.childForFieldName("name")?.text || "anonymous";
      symbols.push({
        name, kind: "function", signature: extractSignature(node), jsdoc,
        lineStart: node.startPosition.row, lineEnd: node.endPosition.row,
        exported: isPub,
      });
      continue;
    }

    if (node.type === "struct_item") {
      const name = node.childForFieldName("name")?.text || "anonymous";
      symbols.push({
        name, kind: "struct", signature: extractSignature(node), jsdoc,
        lineStart: node.startPosition.row, lineEnd: node.endPosition.row,
        exported: isPub,
      });
      continue;
    }

    if (node.type === "enum_item") {
      const name = node.childForFieldName("name")?.text || "anonymous";
      symbols.push({
        name, kind: "enum", signature: extractSignature(node), jsdoc,
        lineStart: node.startPosition.row, lineEnd: node.endPosition.row,
        exported: isPub,
      });
      continue;
    }

    if (node.type === "trait_item") {
      const name = node.childForFieldName("name")?.text || "anonymous";
      symbols.push({
        name, kind: "trait", signature: extractSignature(node), jsdoc,
        lineStart: node.startPosition.row, lineEnd: node.endPosition.row,
        exported: isPub,
      });
      continue;
    }

    if (node.type === "impl_item") {
      const typeName = node.childForFieldName("type")?.text || node.childForFieldName("name")?.text || "unknown";
      const sym: CodeSymbol = {
        name: typeName, kind: "impl", signature: extractSignature(node), jsdoc,
        lineStart: node.startPosition.row, lineEnd: node.endPosition.row,
        exported: false, children: [],
      };

      const body = node.childForFieldName("body");
      if (body) {
        for (const member of body.namedChildren) {
          if (member.type === "function_item") {
            const methodName = member.childForFieldName("name")?.text || "anonymous";
            const methodDoc = findPrecedingComment(member, ctx.sourceLines);
            sym.children!.push({
              name: methodName, kind: "method",
              signature: extractSignature(member), jsdoc: methodDoc,
              lineStart: member.startPosition.row, lineEnd: member.endPosition.row,
              exported: member.text.trimStart().startsWith("pub"),
            });
          }
        }
      }
      symbols.push(sym);
      continue;
    }
  }

  return { symbols, imports };
}

// ---- Generic fallback ----

function extractGenericSymbols(rootNode: SyntaxNode, ctx: ExtractContext): { symbols: CodeSymbol[]; imports: string[] } {
  const symbols: CodeSymbol[] = [];
  const imports: string[] = [];

  const functionTypes = new Set([
    "function_declaration", "function_definition", "method_declaration",
    "method_definition", "function_item",
  ]);
  const classTypes = new Set([
    "class_declaration", "class_definition", "class_specifier",
  ]);
  const importTypes = new Set([
    "import_statement", "import_declaration", "import_from_statement",
    "use_declaration", "preproc_include",
  ]);

  function walk(node: SyntaxNode, depth: number = 0): void {
    if (depth > 5) return;

    for (const child of node.namedChildren) {
      if (importTypes.has(child.type)) {
        imports.push(child.text.split("\n")[0]);
        continue;
      }

      if (functionTypes.has(child.type)) {
        const name = child.childForFieldName("name")?.text ||
                     child.childForFieldName("declarator")?.text?.match(/(\w+)\s*\(/)?.[1] ||
                     "anonymous";
        const jsdoc = findPrecedingComment(child, ctx.sourceLines);
        symbols.push({
          name, kind: depth > 0 ? "method" : "function",
          signature: extractSignature(child), jsdoc,
          lineStart: child.startPosition.row, lineEnd: child.endPosition.row,
          exported: true,
        });
        continue;
      }

      if (classTypes.has(child.type)) {
        const name = child.childForFieldName("name")?.text || "anonymous";
        const jsdoc = findPrecedingComment(child, ctx.sourceLines);
        const sym: CodeSymbol = {
          name, kind: "class", signature: extractSignature(child), jsdoc,
          lineStart: child.startPosition.row, lineEnd: child.endPosition.row,
          exported: true, children: [],
        };
        const body = child.childForFieldName("body");
        if (body) {
          for (const member of body.namedChildren) {
            if (functionTypes.has(member.type)) {
              const methodName = member.childForFieldName("name")?.text || "anonymous";
              sym.children!.push({
                name: methodName, kind: "method",
                signature: extractSignature(member),
                lineStart: member.startPosition.row, lineEnd: member.endPosition.row,
                exported: true,
              });
            }
          }
        }
        symbols.push(sym);
        continue;
      }

      if (child.namedChildCount > 0 && depth < 3) {
        walk(child, depth + 1);
      }
    }
  }

  walk(rootNode);
  return { symbols, imports };
}

// --- Main parse function ---

export function parseFile(content: string, filePath: string): FoldedFile {
  const language = detectLanguage(filePath);
  const grammar = loadGrammar(language);
  const lines = content.split("\n");

  if (!grammar) {
    return {
      filePath, language, symbols: [], imports: [],
      totalLines: lines.length, foldedTokenEstimate: 50,
    };
  }

  const parser = new Parser();
  parser.setLanguage(grammar as Parameters<typeof parser.setLanguage>[0]);
  const tree = parser.parse(content);

  const ctx: ExtractContext = { sourceLines: lines, language };

  let result: { symbols: CodeSymbol[]; imports: string[] };

  switch (language) {
    case "javascript":
    case "typescript":
    case "tsx":
      result = extractJSTSSymbols(tree.rootNode, ctx);
      break;
    case "python":
      result = extractPythonSymbols(tree.rootNode, ctx);
      break;
    case "go":
      result = extractGoSymbols(tree.rootNode, ctx);
      break;
    case "rust":
      result = extractRustSymbols(tree.rootNode, ctx);
      break;
    default:
      result = extractGenericSymbols(tree.rootNode, ctx);
      break;
  }

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
}

// --- Formatting ---

export function formatFoldedView(file: FoldedFile): string {
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
    const lines = sym.jsdoc.split("\n");
    const firstLine = lines.find(l => {
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
    property: "○", getter: "⇢", setter: "⇠",
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
