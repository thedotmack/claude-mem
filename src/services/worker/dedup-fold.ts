import { createHash } from 'crypto';

export interface FoldKeyInput {
  tool_name: string;
  tool_input: unknown;
  cwd?: string;
  agent_id?: string;
}

function sortObjectKeys(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortObjectKeys);
  const obj = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = sortObjectKeys(obj[key]);
  }
  return sorted;
}

export function computeFoldKey(input: FoldKeyInput): string {
  const canonical = JSON.stringify({
    tool_name: input.tool_name,
    tool_input: sortObjectKeys(input.tool_input),
    cwd: input.cwd ?? '',
    agent_id: input.agent_id ?? '',
  });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}
