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

const CLAUDE_MODEL_FAMILY_ALIASES: ReadonlySet<string> = new Set(['haiku', 'sonnet', 'opus']);

/**
 * Whether two resolved model settings name the same Claude model. A bare
 * family alias ('haiku') matches any full id of that family
 * ('claude-haiku-4-5-20251001'); two full ids must match exactly. With the
 * default settings the simple tier and CLAUDE_MEM_MODEL are both Haiku, so a
 * simple-tier run must not be ended and restarted on the same model.
 */
export function namesSameClaudeModel(firstModel: string, secondModel: string): boolean {
  const first = firstModel.trim().toLowerCase();
  const second = secondModel.trim().toLowerCase();
  if (first === second) return true;
  const aliasCoversModel = (alias: string, model: string): boolean =>
    CLAUDE_MODEL_FAMILY_ALIASES.has(alias) && model.includes(alias);
  return aliasCoversModel(first, second) || aliasCoversModel(second, first);
}
