import { execSync } from 'child_process';
import { existsSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { IS_WINDOWS } from '../utils/paths.js';

export interface IDEInfo {
  id: string;
  label: string;
  detected: boolean;
  supported: boolean;
  hint?: string;
}

function isCommandInPath(command: string): boolean {
  try {
    const whichCommand = IS_WINDOWS ? 'where' : 'which';
    execSync(`${whichCommand} ${command}`, { stdio: 'pipe' });
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
      hint: 'native hooks integration',
    },
    {
      id: 'cursor',
      label: 'Cursor',
      detected: existsSync(join(home, '.cursor')),
      supported: true,
      hint: 'hooks + MCP integration',
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
