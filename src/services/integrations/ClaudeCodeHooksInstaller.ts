/**
 * ClaudeCodeHooksInstaller: Generates platform-appropriate hooks.json for Claude Code.
 *
 * On Windows, "shell": "bash" causes the Claude Code desktop app (a GUI process) to
 * spawn bash.exe with a new visible console window for every hook invocation. This is
 * a Windows OS behaviour: when a GUI process spawns a CUI (character UI) process, the
 * OS allocates a new console for the child. The `windowsHide: true` flag in bun-runner.js
 * only affects the bun subprocess spawned inside Node — not the outer shell process that
 * Claude Code spawns to run the hook command.
 *
 * Fix: on Windows, replace "shell":"bash" with "shell":"powershell" and translate the
 * bash PATH-discovery commands to PowerShell one-liners. The PowerShell commands call
 * `node` directly (eliminating the bash intermediary), preserve CLAUDE_CONFIG_DIR and
 * CLAUDE_PLUGIN_ROOT env-var overrides, discover the latest cached version, and fall back
 * to the marketplace copy — identical semantics to the Unix bash commands.
 *
 * Compatible with PowerShell 5.1 (built in to Windows 10/11).
 */

import { readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { mkdirSync, existsSync } from 'fs';

// ---------------------------------------------------------------------------
// PowerShell path-discovery snippets
//
// Each PS command string is the VALUE that ends up in the JSON "command" field.
// When these TypeScript string literals are JSON.stringify-d:
//   TypeScript `\\` → JS value `\` → JSON `\\` → PS receives `\`
// So we write `\\` in TS everywhere we want a single Windows path separator `\`
// in the final PowerShell command.
// ---------------------------------------------------------------------------

/** Common PS prelude: resolves config dir, plugin-root override, latest cache dir. */
const PS_PRELUDE_BUN_RUNNER =
  `$C=if($env:CLAUDE_CONFIG_DIR){$env:CLAUDE_CONFIG_DIR}else{$env:USERPROFILE+'\\.claude'}; ` +
  `$E=if($env:CLAUDE_PLUGIN_ROOT){$env:CLAUDE_PLUGIN_ROOT}elseif($env:PLUGIN_ROOT){$env:PLUGIN_ROOT}else{$null}; ` +
  `$D=(ls ($C+'\\plugins\\cache\\thedotmack\\claude-mem') -EA 0|Sort Name|Select -Last 1).FullName; ` +
  `$P=$null; ` +
  `foreach($R in @($E,$D,($C+'\\plugins\\marketplaces\\thedotmack\\plugin'))){if(-not $R){continue}; ` +
  `$Q=if(Test-Path ($R+'\\plugin\\scripts') -EA 0){$R+'\\plugin'}else{$R}; ` +
  `if((Test-Path ($Q+'\\scripts\\bun-runner.js') -EA 0) -and (Test-Path ($Q+'\\scripts\\worker-service.cjs') -EA 0)){$P=$Q; break}}; ` +
  `if(-not $P){Write-Error 'claude-mem: plugin scripts not found'; exit 1}; `;

const PS_PRELUDE_VERSION_CHECK =
  `$C=if($env:CLAUDE_CONFIG_DIR){$env:CLAUDE_CONFIG_DIR}else{$env:USERPROFILE+'\\.claude'}; ` +
  `$E=if($env:CLAUDE_PLUGIN_ROOT){$env:CLAUDE_PLUGIN_ROOT}elseif($env:PLUGIN_ROOT){$env:PLUGIN_ROOT}else{$null}; ` +
  `$D=(ls ($C+'\\plugins\\cache\\thedotmack\\claude-mem') -EA 0|Sort Name|Select -Last 1).FullName; ` +
  `$P=$null; ` +
  `foreach($R in @($E,$D,($C+'\\plugins\\marketplaces\\thedotmack\\plugin'))){if(-not $R){continue}; ` +
  `$Q=if(Test-Path ($R+'\\plugin\\scripts') -EA 0){$R+'\\plugin'}else{$R}; ` +
  `if(Test-Path ($Q+'\\scripts\\version-check.js') -EA 0){$P=$Q; break}}; ` +
  `if(-not $P){Write-Error 'claude-mem: version-check.js not found'; exit 1}; `;

/** Build a bun-runner PS command for the given hook sub-command. */
function psBunRunner(hookCmd: string): string {
  return PS_PRELUDE_BUN_RUNNER +
    `& node ($P+'\\scripts\\bun-runner.js') ($P+'\\scripts\\worker-service.cjs') ${hookCmd}`;
}

/** PS command for the version-check Setup hook. */
const PS_VERSION_CHECK =
  PS_PRELUDE_VERSION_CHECK +
  `& node ($P+'\\scripts\\version-check.js')`;

// ---------------------------------------------------------------------------
// Windows hooks.json structure
// ---------------------------------------------------------------------------

interface HookEntry {
  type: 'command';
  shell: 'bash' | 'powershell';
  command: string;
  timeout: number;
}

interface HookGroup {
  matcher?: string;
  hooks: HookEntry[];
}

interface HooksJson {
  description: string;
  hooks: Record<string, HookGroup[]>;
}

export function buildWindowsHooksJson(): HooksJson {
  return {
    description: 'Claude-mem memory system hooks',
    hooks: {
      Setup: [
        {
          matcher: '*',
          hooks: [
            {
              type: 'command',
              shell: 'powershell',
              command: PS_VERSION_CHECK,
              timeout: 300,
            },
          ],
        },
      ],
      SessionStart: [
        {
          matcher: 'startup|clear|compact',
          hooks: [
            {
              type: 'command',
              shell: 'powershell',
              command:
                psBunRunner('start') +
                `; Write-Output '{"continue":true,"suppressOutput":true}'`,
              timeout: 60,
            },
            {
              type: 'command',
              shell: 'powershell',
              command: psBunRunner('hook claude-code context'),
              timeout: 60,
            },
          ],
        },
      ],
      UserPromptSubmit: [
        {
          hooks: [
            {
              type: 'command',
              shell: 'powershell',
              command: psBunRunner('hook claude-code session-init'),
              timeout: 60,
            },
          ],
        },
      ],
      PostToolUse: [
        {
          matcher: '*',
          hooks: [
            {
              type: 'command',
              shell: 'powershell',
              command: psBunRunner('hook claude-code observation'),
              timeout: 120,
            },
          ],
        },
      ],
      PreToolUse: [
        {
          matcher: 'Read',
          hooks: [
            {
              type: 'command',
              shell: 'powershell',
              command: psBunRunner('hook claude-code file-context'),
              timeout: 60,
            },
          ],
        },
      ],
      Stop: [
        {
          hooks: [
            {
              type: 'command',
              shell: 'powershell',
              command: psBunRunner('hook claude-code summarize'),
              timeout: 120,
            },
          ],
        },
      ],
    },
  };
}

/**
 * Write Windows-specific PowerShell hooks.json to the given path.
 * Called during install/repair on Windows to replace the bash-based hooks
 * that were copied from the npm package.
 */
export function writeWindowsHooksJson(hooksJsonPath: string): void {
  const dir = dirname(hooksJsonPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const content = buildWindowsHooksJson();
  writeFileSync(hooksJsonPath, JSON.stringify(content, null, 2) + '\n', 'utf-8');
}

/**
 * Read the current hooks.json at the given path and return its shell values
 * for validation purposes.
 */
export function readHooksShells(hooksJsonPath: string): string[] {
  try {
    const content = JSON.parse(readFileSync(hooksJsonPath, 'utf-8'));
    const shells: string[] = [];
    for (const groups of Object.values(content.hooks ?? {}) as any[]) {
      for (const group of groups) {
        for (const hook of group.hooks ?? []) {
          if (hook.shell) shells.push(hook.shell);
        }
      }
    }
    return shells;
  } catch {
    return [];
  }
}
