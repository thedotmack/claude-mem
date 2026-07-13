import { logger } from '../../utils/logger.js';

export function describeProviderAuthMethod(provider: string, claudeAuthMethod: string): string {
  if (provider === 'codex') return 'Codex CLI login';
  if (provider === 'gemini') return 'Gemini API key';
  if (provider === 'agy-cli') return 'Antigravity CLI login';
  if (provider === 'openrouter') return 'OpenRouter API key';
  if (provider !== 'claude') {
    logger.debug('WORKER', 'Unknown provider auth method, falling back to Claude auth method', { provider });
  }
  return claudeAuthMethod;
}
