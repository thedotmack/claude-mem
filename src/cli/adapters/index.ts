import type { PlatformAdapter } from '../types.js';
import { antigravityCliAdapter } from './antigravity-cli.js';
import { claudeCodeAdapter } from './claude-code.js';
import { codexAdapter } from './codex.js';
import { cursorAdapter } from './cursor.js';
import { geminiCliAdapter } from './gemini-cli.js';
import { kimiAdapter } from './kimi.js';
import { rawAdapter } from './raw.js';
import { windsurfAdapter } from './windsurf.js';

export function getPlatformAdapter(platform: string): PlatformAdapter {
  switch (platform) {
    case 'claude':
    case 'claude-code': return claudeCodeAdapter;
    case 'codex': return codexAdapter;
    case 'cursor': return cursorAdapter;
    case 'gemini':
    case 'gemini-cli': return geminiCliAdapter;
    case 'kimi':
    case 'kimi-code': return kimiAdapter;
    case 'windsurf': return windsurfAdapter;
    case 'antigravity': case 'antigravity-cli': return antigravityCliAdapter;
    case 'raw': return rawAdapter;
    default: return rawAdapter;
  }
}

export { claudeCodeAdapter, codexAdapter, cursorAdapter, geminiCliAdapter, kimiAdapter, rawAdapter, windsurfAdapter };
