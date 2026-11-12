/** Remove the native-memory override used by claude-mem, preserving every other host setting. */
export function clearClaudeAutoMemoryOverride(settings: Record<string, any>): boolean {
  if (!settings.env || typeof settings.env !== 'object' || Array.isArray(settings.env)
    || settings.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY !== '1') return false;
  delete settings.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY;
  if (Object.keys(settings.env).length === 0) delete settings.env;
  return true;
}
