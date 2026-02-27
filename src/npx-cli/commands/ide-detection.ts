/**
 * IDE Auto-Detection
 *
 * Detects which AI coding IDEs / tools are installed on the system by
 * probing known config directories and checking for binaries in PATH.
 *
 * Pure Node.js — no Bun APIs used.
 */
import { execSync } from 'child_process';
import { existsSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { IS_WINDOWS } from '../utils/paths.js';

// ---------------------------------------------------------------------------
// IDE type and metadata
// ---------------------------------------------------------------------------

export interface IDEInfo {
  /** Machine-readable identifier. */
  id: string;
  /** Human-readable label for display in prompts. */
  label: string;
  /** Whether the IDE was detected on this system. */
  detected: boolean;
  /** Whether claude-mem has implemented setup for this IDE. */
  supported: boolean;
  /** Short hint text shown in the multi-select. */
  hint?: string;
}

// ---------------------------------------------------------------------------
// PATH helper
// ---------------------------------------------------------------------------

function isCommandInPath(command: string): boolean {
  try {
    const whichCommand = IS_WINDOWS ? 'where' : 'which';
    execSync(`${whichCommand} ${command}`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// VS Code extension directory scanner
// ---------------------------------------------------------------------------

function hasVscodeExtension(extensionNameFragment: string): boolean {
  const extensionsDirectory = join(homedir(), '.vscode', 'extensions');
  if (!existsSync(extensionsDirectory)) return false;
  try {
    const entries = readdirSync(extensionsDirectory);
    return entries.some((entry) => entry.toLowerCase().includes(extensionNameFragment.toLowerCase()));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Detection map
// ---------------------------------------------------------------------------

/**
 * Detect all known IDEs and return an array of `IDEInfo` objects.
 * Each entry indicates whether the IDE was found and whether claude-mem
 * currently supports setting it up.
 */
export function detectInstalledIDEs(): IDEInfo[] {
  const home = homedir();

  return [
    {
      id: 'claude-code',
      label: 'Claude Code',
      detected: existsSync(join(home, '.claude')),
      supported: true,
      hint: 'recommended',
    },
    {
      id: 'gemini-cli',
      label: 'Gemini CLI',
      detected: existsSync(join(home, '.gemini')),
      supported: true,
    },
    {
      id: 'opencode',
      label: 'OpenCode',
      detected:
        existsSync(join(home, '.config', 'opencode')) || isCommandInPath('opencode'),
      supported: true,
      hint: 'plugin-based integration',
    },
    {
      id: 'openclaw',
      label: 'OpenClaw',
      detected: existsSync(join(home, '.openclaw')),
      supported: true,
      hint: 'plugin-based integration',
    },
    {
      id: 'windsurf',
      label: 'Windsurf',
      detected: existsSync(join(home, '.codeium', 'windsurf')),
      supported: true,
    },
    {
      id: 'codex-cli',
      label: 'Codex CLI',
      detected: existsSync(join(home, '.codex')),
      supported: true,
      hint: 'transcript-based integration',
    },
    {
      id: 'cursor',
      label: 'Cursor',
      detected: existsSync(join(home, '.cursor')),
      supported: true,
    },
    {
      id: 'copilot-cli',
      label: 'Copilot CLI',
      detected: isCommandInPath('copilot'),
      supported: true,
      hint: 'MCP-based integration',
    },
    {
      id: 'antigravity',
      label: 'Antigravity',
      detected: existsSync(join(home, '.gemini', 'antigravity')),
      supported: true,
      hint: 'MCP-based integration',
    },
    {
      id: 'goose',
      label: 'Goose',
      detected:
        existsSync(join(home, '.config', 'goose')) || isCommandInPath('goose'),
      supported: true,
      hint: 'MCP-based integration',
    },
    {
      id: 'crush',
      label: 'Crush',
      detected: isCommandInPath('crush'),
      supported: true,
      hint: 'MCP-based integration',
    },
    {
      id: 'roo-code',
      label: 'Roo Code',
      detected: hasVscodeExtension('roo-code'),
      supported: true,
      hint: 'MCP-based integration',
    },
    {
      id: 'warp',
      label: 'Warp',
      detected: existsSync(join(home, '.warp')) || isCommandInPath('warp'),
      supported: true,
      hint: 'MCP-based integration',
    },
  ];
}

/**
 * Return only the IDEs that were detected on this system.
 */
export function getDetectedIDEs(): IDEInfo[] {
  return detectInstalledIDEs().filter((ide) => ide.detected);
}
