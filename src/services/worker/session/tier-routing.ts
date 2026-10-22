/**
 * Tool events cheap enough for CLAUDE_MEM_TIER_SIMPLE_MODEL. Tier routing puts
 * a generator on that model only when everything queued is one of these, and
 * the generator ends before it would hand any other message to that model.
 */
export const SIMPLE_TIER_TOOLS: ReadonlySet<string> = new Set([
  'Read', 'Glob', 'Grep', 'LS', 'ListMcpResourcesTool'
]);

export function isSimpleTierMessage(type: string, toolName: string | null | undefined): boolean {
  return type === 'observation' && !!toolName && SIMPLE_TIER_TOOLS.has(toolName);
}
