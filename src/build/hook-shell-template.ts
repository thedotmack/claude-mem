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
 *   3. cache directories (highest version first, .orphaned_at dirs skipped)
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
   * the hand-authored files. Required for every shell host; the `mcp` host
   * ignores it (the Node launcher derives its spawn target from `requireFile`),
   * so mcp callers may omit it.
   */
  trailingCommand?: string[];
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
 *
 * The loop must NOT `break` on the first match. Under Cygwin/MSYS shells
 * (Git-Bash on Windows) a `break` closes the pipe's read end while the
 * producer subshell is still writing the remaining candidate lines; the next
 * `printf`/`ls` then writes to a broken pipe, which Cygwin reports as EACCES
 * ("printf: write error: Permission denied") instead of EPIPE — surfacing as a
 * hook failure (issues #2707, #2709). Instead the loop drains every candidate
 * (only a handful) and a `_F` guard prints the FIRST match exactly once, so the
 * producer always completes and no broken-pipe write ever happens. The first
 * match still wins, so the contractual fallback ORDER is unchanged. This is
 * POSIX-clean (no bashisms), so the `mcp` host's `sh -c` loop is fixed too.
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
  // Cache dirs ranked by VERSION descending (zero-padded major.minor.patch
  // key, release ahead of prerelease at the same base), skipping dirs Claude
  // Code stamped with .orphaned_at. Mirrors compareVersionsDescending in
  // src/shared/worker-utils.ts — every resolver ranking candidates
  // identically (by version, never mtime) is the restart-storm invariant.
  // (The former `ls -dt` mtime order let an orphan stamp on the OLD version
  // dir make it "newest": the 2026-07-22 restart storm.)
  lines.push(
    `for _V in ${allGlobs}; do ` +
    `[ -d "$_V" ] || continue; [ -e "\${_V}.orphaned_at" ] && continue; ` +
    `_B=\${_V%/}; _B=\${_B##*/}; ` +
    // Balanced (pattern) case form: an unmatched `)` inside the enclosing
    // $(...) command substitution is a POSIX parser error.
    `case "$_B" in (*-*) _G=0;; (*) _G=1;; esac; ` +
    `_N=\${_B%%-*}; _M1=\${_N%%.*}; ` +
    `case "$_N" in (*.*) _T=\${_N#*.};; (*) _T=0;; esac; _M2=\${_T%%.*}; ` +
    `case "$_T" in (*.*) _U=\${_T#*.};; (*) _U=0;; esac; _M3=\${_U%%.*}; ` +
    `_M1=\${_M1%%[!0-9]*}; _M2=\${_M2%%[!0-9]*}; _M3=\${_M3%%[!0-9]*}; ` +
    `printf '%08d%08d%08d%d %s\\n' "\${_M1:-0}" "\${_M2:-0}" "\${_M3:-0}" "$_G" "$_V"; ` +
    `done 2>/dev/null | sort -r | sed 's/^[^ ]* //';`
  );
  lines.push(`printf '%s\\n' "$_C/plugins/marketplaces/thedotmack/plugin";`);

  // The MCP loop trims a trailing slash inline; the hook loop trims via _R="${_R%/}".
  const trimAssignment = isMcp ? '' : ' _R="${_R%/}";';
  const fileClause = fileExistsClause(options);

  return (
    `_F=; _P=$({ ${lines.join(' ')} } | while IFS= read -r _R; do` +
    `${trimAssignment} [ -d "$_R/plugin/scripts" ] && _Q="$_R/plugin" || _Q="$_R"; ` +
    `${fileClause} && [ -z "$_F" ] && { _F=1; printf '%s\\n' "$_Q"; }; done);`
  );
}

const CYGPATH_CLAUSE =
  `command -v cygpath >/dev/null 2>&1 && { _W=$(cygpath -w "$_P" 2>/dev/null); [ -n "$_W" ] && _P="$_W"; };`;

/**
 * Translate a shell-token candidate (`$PWD`, `$PWD/x`, `$HOME/x`, `$_C/x`) into
 * an equivalent Node path expression for the cross-platform MCP launcher.
 * `d` = process.cwd(), `h` = os.homedir(), `C` = resolved CLAUDE_CONFIG_DIR.
 */
function shTokenToNode(token: string): string {
  if (token === '$PWD') return 'd';
  const map: Array<[string, string]> = [
    ['$PWD/', 'd'],
    ['$HOME/', 'h'],
    ['$_C/', 'C'],
  ];
  for (const [prefix, base] of map) {
    if (token.startsWith(prefix)) {
      return `p.join(${base},${JSON.stringify(token.slice(prefix.length))})`;
    }
  }
  // Literal fallback (no known shell base) — embed as-is.
  return JSON.stringify(token);
}

/**
 * Cross-platform MCP launcher (issues #2792, #2790, #2714, #2461). The plugin
 * `.mcp.json` previously used `command: "sh"`, which Claude Code cannot spawn on
 * Windows when Git's `usr/bin` is not on PATH, so the search tools never
 * registered. This emits the `node -e` payload (`.mcp.json` args[1]) that does
 * the same plugin-root discovery in pure Node — no shell dependency — then
 * spawns the resolved server and forwards signals. The candidate order mirrors
 * the POSIX prelude's: $CLAUDE_PLUGIN_ROOT/$PLUGIN_ROOT, mcpExtraCandidates,
 * version-sorted cache roots (never mtime; orphan-stamped dirs skipped), then
 * the marketplace install dir.
 *
 * Only `requireFile`, `notFoundMessage`, and the mcp* candidate fields are
 * consumed. `trailingCommand`, `extraEnv`, `trailingJson`, and the cygpath
 * clause are intentionally ignored for this host — the spawn target is derived
 * solely from `requireFile`, and the Node launcher needs no shell scaffolding.
 */
function buildMcpNodeLauncher(options: ShellTemplateOptions): string {
  const candidates = (options.mcpExtraCandidates ?? []).map(shTokenToNode);
  const cacheRoots = [
    ...(options.mcpExtraCacheRoots ?? []),
    '$_C/plugins/cache/thedotmack/claude-mem',
  ].map(shTokenToNode);
  const marketplace = shTokenToNode('$_C/plugins/marketplaces/thedotmack/plugin');
  const require = JSON.stringify(options.requireFile);
  const notFound = JSON.stringify(`${options.notFoundMessage}\n`);

  const kParts = [
    'E',
    ...candidates,
    ...cacheRoots.map((root) => `...L(${root})`),
    marketplace,
  ].join(',');

  return (
    `const f=require('fs'),p=require('path'),o=require('os'),c=require('child_process');` +
    `const h=o.homedir();` +
    `const C=process.env.CLAUDE_CONFIG_DIR||p.join(h,'.claude');` +
    `const E=process.env.CLAUDE_PLUGIN_ROOT||process.env.PLUGIN_ROOT||'';` +
    `const d=process.cwd();` +
    // S/W mirror compareVersionsDescending in src/shared/worker-utils.ts and
    // L skips Claude Code's .orphaned_at-stamped cache dirs, same as
    // cacheWorkerScriptCandidates — every resolver ranking candidates
    // identically (by version, never mtime) is the restart-storm invariant.
    `const S=n=>{const q=n.split('-')[0].split('.');return[parseInt(q[0],10)||0,parseInt(q[1],10)||0,parseInt(q[2],10)||0]};` +
    `const W=(a,b)=>{const x=S(a),y=S(b);return(y[0]-x[0])||(y[1]-x[1])||(y[2]-x[2])||((a.indexOf('-')<0?0:1)-(b.indexOf('-')<0?0:1))||(a<b?1:a>b?-1:0)};` +
    `const L=x=>{try{return f.readdirSync(x).filter(n=>/^\\d/.test(n)).map(n=>p.join(x,n)).filter(z=>{try{return f.statSync(z).isDirectory()&&!f.existsSync(p.join(z,'.orphaned_at'))}catch{return false}}).sort((a,b)=>W(p.basename(a),p.basename(b)))}catch{return[]}};` +
    `const K=[${kParts}].filter(Boolean);` +
    `let R=null;` +
    `for(const k of K){const r=f.existsSync(p.join(k,'plugin','scripts'))?p.join(k,'plugin'):k;if(f.existsSync(p.join(r,'scripts',${require}))){R=r;break}}` +
    `if(!R){process.stderr.write(${notFound});process.exit(1)}` +
    `const ch=c.spawn(process.execPath,[p.join(R,'scripts',${require})],{stdio:'inherit',windowsHide:true});` +
    `for(const s of ['SIGTERM','SIGINT','SIGHUP'])process.on(s,()=>{try{ch.kill(s)}catch{}});` +
    `ch.on('exit',(code,sig)=>{if(sig){process.removeAllListeners(sig);try{process.kill(process.pid,sig)}catch{process.exit(1)}}else process.exit(code==null?0:code)})`
  );
}

function jsSingleQuoted(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function jsArray(values: string[]): string {
  return `[${values.map(jsSingleQuoted).join(',')}]`;
}

export interface CodexWindowsCommandOptions {
  startupVersionCheck?: boolean;
}

/**
 * Codex hook contract supports `commandWindows` as the Windows-only command
 * override. Keep this Node-based so Codex App on Windows can execute hooks from
 * PowerShell without parsing POSIX shell syntax (OpenAI Codex hooks docs).
 */
export function buildCodexWindowsCommand(
  workerArgs: string[],
  options: CodexWindowsCommandOptions = {},
): string {
  const parts = [
    "const fs=require('fs'),p=require('path'),o=require('os'),c=require('child_process');",
    "const h=o.homedir();",
    "const C=process.env.CLAUDE_CONFIG_DIR||p.join(h,'.claude');",
    "const roots=[];",
    "for(const v of [process.env.CLAUDE_PLUGIN_ROOT,process.env.PLUGIN_ROOT])if(v)roots.push(v);",
    "const cache=p.join(C,'plugins','cache','thedotmack','claude-mem');",
    // S/W mirror compareVersionsDescending in src/shared/worker-utils.ts and
    // the filter skips .orphaned_at-stamped cache dirs, same as
    // cacheWorkerScriptCandidates — every resolver ranking candidates
    // identically (by version, never mtime) is the restart-storm invariant.
    "const S=n=>{const q=n.split('-')[0].split('.');return[parseInt(q[0],10)||0,parseInt(q[1],10)||0,parseInt(q[2],10)||0]};",
    "const W=(a,b)=>{const x=S(a),y=S(b);return(y[0]-x[0])||(y[1]-x[1])||(y[2]-x[2])||((a.indexOf('-')<0?0:1)-(b.indexOf('-')<0?0:1))||(a<b?1:a>b?-1:0)};",
    "try{roots.push(...fs.readdirSync(cache).filter(n=>{const ch=n.charAt(0);return ch>='0'&&ch<='9'}).map(n=>p.join(cache,n)).filter(r=>{try{return fs.statSync(r).isDirectory()&&!fs.existsSync(p.join(r,'.orphaned_at'))}catch{return false}}).sort((a,b)=>W(p.basename(a),p.basename(b))))}catch{}",
    "roots.push(p.join(C,'plugins','marketplaces','thedotmack','plugin'));",
    "let R=null;",
    "for(const k of roots){const r=fs.existsSync(p.join(k,'plugin','scripts'))?p.join(k,'plugin'):k;if(fs.existsSync(p.join(r,'scripts','bun-runner.js'))&&fs.existsSync(p.join(r,'scripts','worker-service.cjs'))){R=r;break}}",
    "if(!R){process.stderr.write('claude-mem: plugin scripts not found\\n');process.exit(1)}",
    "const env={...process.env,CLAUDE_MEM_CODEX_HOOK:'1'};",
  ];

  if (options.startupVersionCheck) {
    parts.push(
      "const v=c.spawnSync(process.execPath,[p.join(R,'scripts','version-check.js')],{encoding:'utf8',env});",
      "if(v.stdout&&v.stdout.trim()){process.stdout.write(v.stdout);if(!v.stdout.endsWith('\\n'))process.stdout.write('\\n');process.exit(0)}",
    );
  }

  parts.push(
    `const workerArgs=${jsArray(workerArgs)};`,
    "const args=[p.join(R,'scripts','bun-runner.js'),p.join(R,'scripts','worker-service.cjs'),...workerArgs];",
    "const res=c.spawnSync(process.execPath,args,{stdio:'inherit',env});",
    "if(res.error){process.stderr.write(String(res.error.message||res.error)+'\\n');process.exit(1)}",
    "process.exit(res.status==null?0:res.status)",
  );

  return `node -e "${parts.join('')}"`;
}

/**
 * Build the full single-line shell command string for a Rule A site.
 * The output is byte-compatible with the hand-authored command strings in
 * the host-managed config files.
 */
export function buildShellCommand(options: ShellTemplateOptions): string {
  // MCP uses a cross-platform Node launcher instead of an `sh -c` prelude so it
  // spawns on Windows without Git Bash (#2792/#2790/#2714/#2461).
  if (options.host === 'mcp') {
    return buildMcpNodeLauncher(options);
  }

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

  // cygpath conversion: claude-code + codex-cli. MCP returned early above (it
  // uses the Node launcher), so every host reaching here needs the clause.
  parts.push(CYGPATH_CLAUSE);

  const envPrefix = options.extraEnv
    ? Object.entries(options.extraEnv)
        .map(([key, value]) => `${key}=${value} `)
        .join('')
    : '';

  // Shell hosts always run a trailing command; fail loud rather than emit a
  // launcher that silently resolves `_P` and then does nothing.
  if (!options.trailingCommand) {
    throw new Error(`buildShellCommand: host '${options.host}' requires trailingCommand`);
  }
  let command = `${envPrefix}${options.trailingCommand.join(' ')}`;
  if (options.trailingJson) {
    command += `; echo '${JSON.stringify(options.trailingJson)}'`;
  }
  parts.push(command);

  return parts.join(' ');
}
