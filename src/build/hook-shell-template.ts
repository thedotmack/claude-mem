/**
 * hook-shell-template.ts — Rule A: host-managed defensive shell-template
 * generator (single source of truth).
 *
 * See `CLAUDE.md` → "Spawn-Contract Resolution". The host-owned config files
 * (`plugin/hooks/hooks.json`, `plugin/hooks/codex-hooks.json`,
 * `plugin/.mcp.json`) embed a defensive POSIX-shell prelude that resolves the
 * plugin root from `${CLAUDE_PLUGIN_ROOT}` (or `${PLUGIN_ROOT}`), then falls
 * back through the host cache directories and the marketplace install dir.
 * Some host versions / cache rotations do NOT inject `CLAUDE_PLUGIN_ROOT`, so
 * the fallback chain is load-bearing (issues #1215, #1533).
 *
 * This module emits those command strings from ONE place so the shape can't
 * drift between the three files. `tests/infrastructure/plugin-distribution.test.ts`
 * asserts the hand-maintained files match the generator output byte-for-byte.
 *
 * The fallback chain ORDER is contractual and must not change:
 *   1. ${CLAUDE_PLUGIN_ROOT:-${PLUGIN_ROOT:-}}   (host-injected env)
 *   2. (mcp only) $PWD/plugin, $PWD               (repo/dev checkout)
 *   3. cache directories (newest first via `ls -dt`)
 *   4. $_C/plugins/marketplaces/thedotmack/plugin (marketplace install)
 */

export type ShellTemplateHost = 'claude-code' | 'claude-code-setup' | 'codex-cli' | 'mcp';

export interface ShellTemplateOptions {
  /** Host whose spawn contract / PATH prelude applies. */
  host: ShellTemplateHost;
  /** Script that must exist under `<root>/scripts/` for the root to count. */
  requireFile: string;
  /** Optional second required script (hooks needing bun-runner.js AND worker-service.cjs). */
  requireFileSecondary?: string;
  /**
   * Trailing command tokens run after `_P` resolves. Tokens are emitted
   * verbatim (callers pass already-quoted `"$_P/scripts/X"` forms), matching
   * the hand-authored files.
   */
  trailingCommand: string[];
  /** Extra env exports prepended to the trailing command (e.g. CLAUDE_MEM_CODEX_HOOK=1). */
  extraEnv?: Record<string, string>;
  /** Optional trailing JSON echoed after the command (e.g. SessionStart continue marker). */
  trailingJson?: object;
  /** stderr message when no candidate root resolves. */
  notFoundMessage: string;
  /**
   * MCP-only: extra candidate roots enumerated before the cache directories
   * (e.g. '$PWD/plugin', '$PWD'). Ignored for non-mcp hosts.
   */
  mcpExtraCandidates?: string[];
  /**
   * MCP-only: additional cache roots tried (newest first) BEFORE the Claude
   * cache root (e.g. Codex caches). Each entry is the cache root WITHOUT the
   * version-glob suffix (/[0-9]asterisk/), which the generator appends
   * uniformly. Ignored for non-mcp hosts.
   */
  mcpExtraCacheRoots?: string[];
}

const CLAUDE_CODE_PATH_PRELUDE = `export PATH="$($SHELL -lc 'echo $PATH' 2>/dev/null):$PATH";`;

const CLAUDE_CODE_SETUP_PATH_PRELUDE =
  'export PATH="$HOME/.nvm/versions/node/v$(ls \\"$HOME/.nvm/versions/node\\" 2>/dev/null | ' +
  "sed 's/^v//' | sort -t. -k1,1n -k2,2n -k3,3n | tail -1)/bin:$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin:$PATH\";";

const CODEX_CLI_PATH_PRELUDE =
  `_HP=$(printenv PATH 2>/dev/null || true); ` +
  `if [ -z "$_HP" ] && [ -n "\${SHELL:-}" ]; then _HP=$("$SHELL" -lc 'printf %s "$PATH"' 2>/dev/null || true); fi; ` +
  `_HP=$(printf '%s' "$_HP" | tr ' ' ':'); export PATH="\${_HP:+$_HP:}$PATH"; `;

function pathPrelude(host: ShellTemplateHost): string {
  switch (host) {
    case 'claude-code':
      return CLAUDE_CODE_PATH_PRELUDE;
    case 'claude-code-setup':
      return CLAUDE_CODE_SETUP_PATH_PRELUDE;
    case 'codex-cli':
      // Trailing space is intentional: join() adds one more → double space
      // before `_C=`, matching the hand-authored codex-hooks.json.
      return CODEX_CLI_PATH_PRELUDE;
    case 'mcp':
      return '';
  }
}

function fileExistsClause(options: ShellTemplateOptions): string {
  const primary = `[ -f "$_Q/scripts/${options.requireFile}" ]`;
  if (options.requireFileSecondary) {
    return `${primary} && [ -f "$_Q/scripts/${options.requireFileSecondary}" ]`;
  }
  return primary;
}

/**
 * Build the candidate-enumeration block. The `{ ...; }` subshell prints one
 * candidate root per line in priority order; the `while` loop picks the first
 * whose `scripts/<requireFile>` exists.
 */
function candidateBlock(options: ShellTemplateOptions): string {
  const isMcp = options.host === 'mcp';

  const lines: string[] = [`[ -n "$_E" ] && printf '%s\\n' "$_E";`];

  if (isMcp && options.mcpExtraCandidates && options.mcpExtraCandidates.length > 0) {
    const quoted = options.mcpExtraCandidates.map((candidate) => `"${candidate}"`).join(' ');
    lines.push(`printf '%s\\n' ${quoted};`);
  }

  const extraCacheRoots = isMcp && options.mcpExtraCacheRoots ? options.mcpExtraCacheRoots : [];
  const allGlobs = [...extraCacheRoots, '$_C/plugins/cache/thedotmack/claude-mem']
    .map((root) => `"${root}"/[0-9]*/`)
    .join(' ');
  lines.push(`ls -dt ${allGlobs} 2>/dev/null;`);
  lines.push(`printf '%s\\n' "$_C/plugins/marketplaces/thedotmack/plugin";`);

  // The MCP loop trims a trailing slash inline; the hook loop trims via _R="${_R%/}".
  const trimAssignment = isMcp ? '' : ' _R="${_R%/}";';
  const fileClause = fileExistsClause(options);

  return (
    `_P=$({ ${lines.join(' ')} } | while IFS= read -r _R; do` +
    `${trimAssignment} [ -d "$_R/plugin/scripts" ] && _Q="$_R/plugin" || _Q="$_R"; ` +
    `${fileClause} && { printf '%s\\n' "$_Q"; break; }; done);`
  );
}

const CYGPATH_CLAUSE =
  `command -v cygpath >/dev/null 2>&1 && { _W=$(cygpath -w "$_P" 2>/dev/null); [ -n "$_W" ] && _P="$_W"; };`;

/**
 * Build the full single-line shell command string for a Rule A site.
 * The output is byte-compatible with the hand-authored command strings in
 * the host-managed config files.
 */
export function buildShellCommand(options: ShellTemplateOptions): string {
  const parts: string[] = [];

  // The PATH prelude is pushed verbatim (including any trailing space). `parts`
  // are later joined with a single space, so claude-code preludes (no trailing
  // space) get one separator space, while the codex prelude (one trailing
  // space) gets two — matching the hand-authored files exactly.
  const prelude = pathPrelude(options.host);
  if (prelude) parts.push(prelude);

  parts.push('_C="${CLAUDE_CONFIG_DIR:-$HOME/.claude}";');
  parts.push('_E="${CLAUDE_PLUGIN_ROOT:-${PLUGIN_ROOT:-}}";');
  parts.push(candidateBlock(options));
  parts.push(`[ -n "$_P" ] || { echo "${options.notFoundMessage}" >&2; exit 1; };`);

  // cygpath conversion: claude-code + codex-cli only. MCP runs under `sh -c`
  // which already understands POSIX paths, so no conversion (matches current
  // plugin/.mcp.json).
  if (options.host !== 'mcp') {
    parts.push(CYGPATH_CLAUSE);
  }

  const envPrefix = options.extraEnv
    ? Object.entries(options.extraEnv)
        .map(([key, value]) => `${key}=${value} `)
        .join('')
    : '';

  let command = `${envPrefix}${options.trailingCommand.join(' ')}`;
  if (options.trailingJson) {
    command += `; echo '${JSON.stringify(options.trailingJson)}'`;
  }
  parts.push(command);

  return parts.join(' ');
}
