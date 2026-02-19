import type { CategoryCluster, CategorizedItem, NormalizedItem } from "./types.ts";

/**
 * Keyword maps for each category cluster.
 * Order matters: earlier categories in CATEGORY_PRIORITY_ORDER take precedence for ambiguous matches.
 */
const CATEGORY_KEYWORD_MAP: Record<Exclude<CategoryCluster, "uncategorized">, string[]> = {
  security: ["security", "vulnerability", "injection", "xss", "csrf", "disclosure", "cve"],
  chroma: ["chroma", "chromadb", "vector", "embedding", "backfill", "segfault", "chroma-mcp"],
  "process-lifecycle": [
    "zombie",
    "daemon",
    "worker",
    "process",
    "pid",
    "spawn",
    "duplicate worker",
    "leaked",
    "stuck processing",
  ],
  windows: ["windows", "wmic", "powershell", "git bash", "console popup", "libuv", "win32", "cmd.exe"],
  hooks: ["hook", "sessionstart", "posttooluse", "summary hook", "stop hook", "stderr"],
  installation: ["install", "setup", "marketplace", "node_modules", "skill path", "symlink", "path"],
  "feature-request": ["feature", "enhancement", "request", "add support", "would be nice", "suggestion"],
  spam: [],
};

/**
 * Priority order for ambiguous matches — first match wins.
 * security > chroma > process-lifecycle > windows > hooks > installation > feature-request > spam
 */
const CATEGORY_PRIORITY_ORDER: Exclude<CategoryCluster, "uncategorized">[] = [
  "security",
  "chroma",
  "process-lifecycle",
  "windows",
  "hooks",
  "installation",
  "feature-request",
  "spam",
];

const SPAM_TITLE_LENGTH_THRESHOLD = 5;

function buildSearchableText(item: NormalizedItem): string {
  const labelText = item.labels.map((label) => label.name).join(" ");
  return `${item.title} ${item.body} ${labelText}`.toLowerCase();
}

function isSpamItem(item: NormalizedItem): boolean {
  const titleLength = item.title.trim().length;
  const bodyLength = item.body.trim().length;
  const hasLabels = item.labels.length > 0;

  return titleLength < SPAM_TITLE_LENGTH_THRESHOLD && bodyLength === 0 && !hasLabels;
}

function matchesCategory(searchableText: string, keywords: string[]): boolean {
  return keywords.some((keyword) => searchableText.includes(keyword));
}

export function categorizeItem(item: NormalizedItem): CategoryCluster {
  if (isSpamItem(item)) {
    return "spam";
  }

  const searchableText = buildSearchableText(item);

  for (const category of CATEGORY_PRIORITY_ORDER) {
    const keywords = CATEGORY_KEYWORD_MAP[category];
    if (keywords.length > 0 && matchesCategory(searchableText, keywords)) {
      return category;
    }
  }

  return "uncategorized";
}

export function categorizeItems(items: NormalizedItem[]): CategorizedItem[] {
  return items.map((item) => ({
    ...item,
    category: categorizeItem(item),
  }));
}
