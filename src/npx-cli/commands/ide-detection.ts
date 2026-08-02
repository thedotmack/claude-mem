import { execFileSync } from 'child_process';
import { existsSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { IS_WINDOWS } from '../utils/paths.js';

export interface IDEInfo {
  id: string;
  label: string;
  detected: boolean;
  hint?: string;
}

function isCommandInPath(command: string): boolean {
  try {
    if (IS_WINDOWS) {
      execFileSync('where.exe', [command], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } else {
      execFileSync('which', [command], { stdio: 'ignore' });
    }
    return true;
  } catch (error: unknown) {
    if (process.env.DEBUG) {
      console.error(`[ide-detection] ${command} not in PATH:`, error instanceof Error ? error.message : String(error));
    }
    return false;
  }
}

function hasVscodeExtension(extensionNameFragment: string): boolean {
  const extensionsDirectory = join(homedir(), '.vscode', 'extensions');
  if (!existsSync(extensionsDirectory)) return false;
  try {
    const entries = readdirSync(extensionsDirectory);
    return entries.some((entry) => entry.toLowerCase().includes(extensionNameFragment.toLowerCase()));
  } catch (error: unknown) {
    console.warn('[ide-detection] Failed to read VS Code extensions directory:', error instanceof Error ? error.message : String(error));
    return false;
  }
}

export function detectInstalledIDEs(): IDEInfo[] {
  const home = homedir();

  return [
    {
      id: 'claude-code',
      label: 'Claude Code',
      detected: isCommandInPath('claude'),
      hint: 'recommended',
    },
    {
      id: 'opencode',
      label: 'OpenCode',
      detected:
        existsSync(join(home, '.config', 'opencode')) || isCommandInPath('opencode'),
      hint: 'plugin-based integration',
    },
    {
      id: 'openclaw',
      label: 'OpenClaw',
      detected: existsSync(join(home, '.openclaw')),
      hint: 'plugin-based integration',
    },
    {
      id: 'windsurf',
      label: 'Windsurf',
      detected: existsSync(join(home, '.codeium', 'windsurf')),
    },
    {
      id: 'codex-cli',
      label: 'Codex CLI',
      detected: existsSync(join(home, '.codex')),
      hint: 'native hooks integration',
    },
    {
      id: 'cursor',
      label: 'Cursor',
      detected: existsSync(join(home, '.cursor')),
      hint: 'hooks + MCP integration',
    },
    {
      id: 'copilot-cli',
      label: 'Copilot CLI',
      detected: isCommandInPath('copilot'),
      hint: 'MCP-based integration',
    },
    {
      id: 'antigravity',
      label: 'Antigravity',
      detected: existsSync(join(home, '.gemini', 'antigravity')) || isCommandInPath('agy'),
      hint: 'hooks + MCP integration',
    },
    {
      id: 'goose',
      label: 'Goose',
      detected:
        existsSync(join(home, '.config', 'goose')) || isCommandInPath('goose'),
      hint: 'MCP-based integration',
    },
    {
      id: 'roo-code',
      label: 'Roo Code',
      detected: hasVscodeExtension('roo-code'),
      hint: 'MCP-based integration',
    },
    {
      id: 'warp',
      label: 'Warp',
      detected: existsSync(join(home, '.warp')) || isCommandInPath('warp'),
      hint: 'MCP-based integration',
    },
  ];
}
