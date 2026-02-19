import type { CategorizedItem, DuplicateGroup } from "./types.ts";

const JACCARD_SIMILARITY_THRESHOLD = 0.4;
const ISSUE_REFERENCE_PATTERN = /#(\d+)/g;

function tokenizeTitle(title: string): Set<string> {
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 0);
  return new Set(words);
}

function computeJaccardSimilarity(setA: Set<string>, setB: Set<string>): number {
  if (setA.size === 0 && setB.size === 0) {
    return 0;
  }

  let intersectionSize = 0;
  for (const word of setA) {
    if (setB.has(word)) {
      intersectionSize += 1;
    }
  }

  const unionSize = setA.size + setB.size - intersectionSize;
  if (unionSize === 0) {
    return 0;
  }

  return intersectionSize / unionSize;
}

function extractReferencedIssueNumbers(body: string): Set<number> {
  const references = new Set<number>();
  for (const match of body.matchAll(ISSUE_REFERENCE_PATTERN)) {
    const number = Number.parseInt(match[1], 10);
    if (Number.isFinite(number)) {
      references.add(number);
    }
  }
  return references;
}

function hasSharedIssueReferences(itemA: CategorizedItem, itemB: CategorizedItem): boolean {
  const referencesA = extractReferencedIssueNumbers(itemA.body);
  const referencesB = extractReferencedIssueNumbers(itemB.body);

  if (referencesA.size === 0 || referencesB.size === 0) {
    return false;
  }

  for (const ref of referencesA) {
    if (referencesB.has(ref)) {
      return true;
    }
  }

  return false;
}

function getOldestItemNumber(items: CategorizedItem[], numbers: number[]): number {
  const itemByNumber = new Map(items.map((item) => [item.number, item]));
  let oldestNumber = numbers[0];
  let oldestTimestamp = Infinity;

  for (const num of numbers) {
    const item = itemByNumber.get(num);
    if (item) {
      const timestamp = Date.parse(item.createdAt);
      if (!Number.isNaN(timestamp) && timestamp < oldestTimestamp) {
        oldestTimestamp = timestamp;
        oldestNumber = num;
      }
    }
  }

  return oldestNumber;
}

export function detectDuplicates(items: CategorizedItem[]): DuplicateGroup[] {
  // Group items by category — only compare within same category
  const itemsByCategory = new Map<string, CategorizedItem[]>();
  for (const item of items) {
    const existing = itemsByCategory.get(item.category) ?? [];
    existing.push(item);
    itemsByCategory.set(item.category, existing);
  }

  // Union-Find for grouping
  const parent = new Map<number, number>();
  const reason = new Map<string, string>();

  function find(itemNumber: number): number {
    if (!parent.has(itemNumber)) {
      parent.set(itemNumber, itemNumber);
    }
    let root = parent.get(itemNumber)!;
    while (root !== parent.get(root)!) {
      root = parent.get(root)!;
    }
    parent.set(itemNumber, root);
    return root;
  }

  function union(numberA: number, numberB: number, matchReason: string): void {
    const rootA = find(numberA);
    const rootB = find(numberB);
    if (rootA !== rootB) {
      parent.set(rootB, rootA);
      const pairKey = [Math.min(numberA, numberB), Math.max(numberA, numberB)].join("-");
      reason.set(pairKey, matchReason);
    }
  }

  // Precompute title tokens per item
  const titleTokens = new Map<number, Set<string>>();
  for (const item of items) {
    titleTokens.set(item.number, tokenizeTitle(item.title));
  }

  // Compare items within same category
  for (const [, categoryItems] of itemsByCategory) {
    for (let i = 0; i < categoryItems.length; i++) {
      for (let j = i + 1; j < categoryItems.length; j++) {
        const itemA = categoryItems[i];
        const itemB = categoryItems[j];

        const tokensA = titleTokens.get(itemA.number)!;
        const tokensB = titleTokens.get(itemB.number)!;
        const similarity = computeJaccardSimilarity(tokensA, tokensB);

        if (similarity >= JACCARD_SIMILARITY_THRESHOLD) {
          union(itemA.number, itemB.number, `title-similarity (${similarity.toFixed(2)})`);
          continue;
        }

        if (
          itemA.category === itemB.category &&
          hasSharedIssueReferences(itemA, itemB)
        ) {
          union(itemA.number, itemB.number, "shared-issue-reference");
        }
      }
    }
  }

  // Collect groups from union-find
  const groupsByRoot = new Map<number, number[]>();
  for (const [itemNumber] of parent) {
    const root = find(itemNumber);
    const group = groupsByRoot.get(root) ?? [];
    group.push(itemNumber);
    groupsByRoot.set(root, group);
  }

  // Build DuplicateGroup results — only groups with 2+ members
  const groups: DuplicateGroup[] = [];
  let groupIdCounter = 1;

  for (const [, memberNumbers] of groupsByRoot) {
    if (memberNumbers.length < 2) {
      continue;
    }

    memberNumbers.sort((a, b) => a - b);
    const canonicalNumber = getOldestItemNumber(items, memberNumbers);
    const duplicateNumbers = memberNumbers.filter((num) => num !== canonicalNumber);

    // Build reason string from all pair reasons in this group
    const groupReasons = new Set<string>();
    for (const numA of memberNumbers) {
      for (const numB of memberNumbers) {
        if (numA < numB) {
          const pairKey = `${numA}-${numB}`;
          const pairReason = reason.get(pairKey);
          if (pairReason) {
            groupReasons.add(pairReason);
          }
        }
      }
    }

    groups.push({
      groupId: groupIdCounter,
      canonical: canonicalNumber,
      duplicates: duplicateNumbers,
      reason: [...groupReasons].join("; "),
    });
    groupIdCounter += 1;
  }

  // Sort by group size descending
  groups.sort((a, b) => b.duplicates.length - a.duplicates.length);

  return groups;
}
