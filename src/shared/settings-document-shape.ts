/**
 * The shape rules of settings.json, with no file access, so code that cannot
 * import Node (the auto-clear mod in src/mods/) reads the document by the same
 * rule as SettingsDefaultsManager. settings-document.ts re-exports all of it.
 */

export type SettingsDocument = Record<string, unknown>;

export const isSettingsRecord = (value: unknown): value is SettingsDocument =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Where claude-mem's keys live — the ONE rule every settings reader and writer
 * uses, including SettingsDefaultsManager.loadFromFile, so a write always lands
 * where the next read looks:
 *  - nested when the `env` block holds `CLAUDE_MEM_*` keys: a Claude-Code-style
 *    wrapped document. `CLAUDE_MEM_*` keys at its root are stale copies — the
 *    old viewer wrote the root of wrapped documents, secrets as `****` masks —
 *    so they are never read, and the next write drops them;
 *  - flat otherwise: claude-mem's keys at the root, and an `env` block beside
 *    them (with no `CLAUDE_MEM_*` keys) is Claude Code's own.
 * A wrapped document keeps its wrapper and root peers.
 */
export function classifySettingsDocument(document: SettingsDocument): 'flat' | 'nested' {
  const env = document.env;
  return isSettingsRecord(env) && Object.keys(env).some(key => key.startsWith('CLAUDE_MEM_')) ? 'nested' : 'flat';
}

export function settingsTarget(document: SettingsDocument): SettingsDocument {
  return classifySettingsDocument(document) === 'nested' ? document.env as SettingsDocument : document;
}
