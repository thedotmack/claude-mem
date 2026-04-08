/**
 * OneShotQuery: Lightweight single-turn LLM call for conversation observation.
 * Uses the active provider (Gemini/OpenRouter) for a simple prompt→response cycle.
 * Does NOT use the Claude Agent SDK query() which spawns a full subprocess.
 */

import { isGeminiSelected, isGeminiAvailable } from './GeminiAgent.js';
import { isOpenRouterSelected, isOpenRouterAvailable } from './OpenRouterAgent.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { EnvManager } from '../../shared/EnvManager.js';
import { logger } from '../../utils/logger.js';

const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

/**
 * Execute a one-shot LLM query using the best available provider.
 * Priority: Gemini → OpenRouter → Anthropic Messages API
 * Returns the text response or null if no provider is available.
 */
export async function oneShotQuery(prompt: string): Promise<string | null> {
  // Try Gemini first (cheapest, simplest)
  if (isGeminiSelected() && isGeminiAvailable()) {
    return await queryGemini(prompt);
  }

  // Try OpenRouter
  if (isOpenRouterSelected() && isOpenRouterAvailable()) {
    return await queryOpenRouter(prompt);
  }

  // Try Anthropic Messages API directly (if API key available)
  const anthropicKey = getAnthropicApiKey();
  if (anthropicKey) {
    return await queryAnthropic(prompt, anthropicKey);
  }

  logger.debug('ONE_SHOT', 'No provider available for one-shot query');
  return null;
}

async function queryGemini(prompt: string): Promise<string | null> {
  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
  const apiKey = settings.CLAUDE_MEM_GEMINI_API_KEY || process.env.GEMINI_API_KEY;
  const model = settings.CLAUDE_MEM_GEMINI_MODEL || 'gemini-2.0-flash';

  if (!apiKey) return null;

  const url = `${GEMINI_API_URL}/${model}:generateContent?key=${apiKey}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 4096 }
    })
  });

  if (!response.ok) {
    logger.warn('ONE_SHOT', 'Gemini query failed', { status: response.status });
    return null;
  }

  const data = await response.json() as any;
  return data?.candidates?.[0]?.content?.parts?.[0]?.text || null;
}

async function queryOpenRouter(prompt: string): Promise<string | null> {
  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
  const apiKey = settings.CLAUDE_MEM_OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEY;
  const model = settings.CLAUDE_MEM_OPENROUTER_MODEL || 'anthropic/claude-sonnet-4-5';

  if (!apiKey) return null;

  const response = await fetch(OPENROUTER_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://claude-mem.ai',
      'X-Title': 'claude-mem-observer'
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 4096
    })
  });

  if (!response.ok) {
    logger.warn('ONE_SHOT', 'OpenRouter query failed', { status: response.status });
    return null;
  }

  const data = await response.json() as any;
  return data?.choices?.[0]?.message?.content || null;
}

async function queryAnthropic(prompt: string, apiKey: string): Promise<string | null> {
  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
  const model = settings.CLAUDE_MEM_MODEL || 'claude-sonnet-4-5';

  const response = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3
    })
  });

  if (!response.ok) {
    logger.warn('ONE_SHOT', 'Anthropic query failed', { status: response.status });
    return null;
  }

  const data = await response.json() as any;
  return data?.content?.[0]?.text || null;
}

function getAnthropicApiKey(): string | null {
  const credentials = EnvManager.loadClaudeMemCredentials();
  return credentials.ANTHROPIC_API_KEY || null;
}
