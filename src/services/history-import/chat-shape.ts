export interface HistoricalMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  timestampMs: number;
}

export interface HistoricalChat {
  source: 'chatgpt' | 'claude' | 'claude-code' | 'codex';
  id: string;
  project: string;
  projectId?: string;
  projectOrigin?: 'export' | 'user' | 'unassigned';
  messages: HistoricalMessage[];
}

export type RecordValue = Record<string, unknown>;
export function record(value: unknown): RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as RecordValue) : {};
}
export function string(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Epoch seconds in ChatGPT, RFC 3339 with a timezone in Claude. File times and update times are unrelated. */
export function messageTime(value: unknown): number {
  if (typeof value === 'number') return Math.floor(value * 1000);
  if (typeof value !== 'string') return NaN;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/i.exec(value);
  if (!match) return NaN;
  const [, year, month, day, hour, minute, second] = match.map(Number);
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > days || hour > 23 || minute > 59 || second > 59) return NaN;
  return Date.parse(value);
}

export interface ChatNode {
  id: string;
  parent: string;
  data: RecordValue;
}

/** Exports may contain abandoned replies. Only take a branch ending at the active or unambiguous leaf. */
export function activeBranch(nodes: ChatNode[], leaf: string): ChatNode[] | null {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  if (byId.size !== nodes.length) return null;
  if (!leaf) {
    const parents = new Set(nodes.map((node) => node.parent));
    const leaves = nodes.filter((node) => !parents.has(node.id));
    if (leaves.length !== 1) return null;
    leaf = leaves[0].id;
  }
  const visited = new Set<string>();
  const chain: ChatNode[] = [];
  while (leaf) {
    const node = byId.get(leaf);
    if (!node || visited.has(leaf)) return null;
    chain.push(node);
    visited.add(leaf);
    leaf = node.parent;
  }
  return chain.reverse();
}

export function plainTextBlocks(blocks: unknown): string {
  if (!Array.isArray(blocks)) return '';
  return blocks
    .map(record)
    .filter((block) => block.type === 'text')
    .map((block) => string(block.text))
    .filter(Boolean)
    .join('\n');
}
