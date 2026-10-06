// File extension -> smart-file-read language. Dependency-free on purpose: the
// PreToolUse file-context hook asks "would smart_outline parse this file?"
// through it without pulling the tree-sitter parser into the worker bundle.
export const LANG_MAP: Record<string, string> = {
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "tsx",
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
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

export function detectLanguage(filePath: string): string {
  const ext = filePath.slice(filePath.lastIndexOf("."));
  return LANG_MAP[ext.toLowerCase()] ?? "unknown";
}
