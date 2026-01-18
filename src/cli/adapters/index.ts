import type { PlatformAdapter } from '../types.js';
import { claudeCodeAdapter } from './claude-code.js';
import { cursorAdapter } from './cursor.js';
import { opencodeAdapter } from './opencode.js';
import { rawAdapter } from './raw.js';

export function getPlatformAdapter(platform: string): PlatformAdapter {
  switch (platform) {
    case 'claude-code': return claudeCodeAdapter;
    case 'cursor': return cursorAdapter;
    case 'opencode': return opencodeAdapter;
    case 'raw': return rawAdapter;
    default: throw new Error(`Unknown platform: ${platform}`);
  }
}

export { claudeCodeAdapter, cursorAdapter, opencodeAdapter, rawAdapter };
