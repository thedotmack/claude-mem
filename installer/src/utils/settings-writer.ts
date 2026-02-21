import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { ProviderConfig } from '../steps/provider.js';
import type { SettingsConfig } from '../steps/settings.js';

export function expandDataDir(dataDir: string): string {
  if (dataDir.startsWith('~')) {
    return join(homedir(), dataDir.slice(1));
  }
  return dataDir;
}

export function buildSettingsObject(
  providerConfig: ProviderConfig,
  settingsConfig: SettingsConfig,
): Record<string, string> {
  const settings: Record<string, string> = {
    CLAUDE_MEM_WORKER_PORT: settingsConfig.workerPort,
    CLAUDE_MEM_WORKER_HOST: '127.0.0.1',
    CLAUDE_MEM_DATA_DIR: expandDataDir(settingsConfig.dataDir),
    CLAUDE_MEM_CONTEXT_OBSERVATIONS: settingsConfig.contextObservations,
    CLAUDE_MEM_LOG_LEVEL: settingsConfig.logLevel,
    CLAUDE_MEM_PYTHON_VERSION: settingsConfig.pythonVersion,
    CLAUDE_MEM_PROVIDER: providerConfig.provider,
  };

  // Provider-specific settings
  if (providerConfig.provider === 'claude') {
    settings.CLAUDE_MEM_CLAUDE_AUTH_METHOD = providerConfig.claudeAuthMethod ?? 'cli';
  }

  if (providerConfig.provider === 'gemini') {
    if (providerConfig.apiKey) settings.CLAUDE_MEM_GEMINI_API_KEY = providerConfig.apiKey;
    if (providerConfig.model) settings.CLAUDE_MEM_GEMINI_MODEL = providerConfig.model;
    settings.CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED = providerConfig.rateLimitingEnabled !== false ? 'true' : 'false';
  }

  if (providerConfig.provider === 'openrouter') {
    if (providerConfig.apiKey) settings.CLAUDE_MEM_OPENROUTER_API_KEY = providerConfig.apiKey;
    if (providerConfig.model) settings.CLAUDE_MEM_OPENROUTER_MODEL = providerConfig.model;
  }

  // Chroma settings
  if (settingsConfig.chromaEnabled) {
    settings.CLAUDE_MEM_CHROMA_MODE = settingsConfig.chromaMode ?? 'local';
    if (settingsConfig.chromaMode === 'remote') {
      if (settingsConfig.chromaHost) settings.CLAUDE_MEM_CHROMA_HOST = settingsConfig.chromaHost;
      if (settingsConfig.chromaPort) settings.CLAUDE_MEM_CHROMA_PORT = settingsConfig.chromaPort;
      if (settingsConfig.chromaSsl !== undefined) settings.CLAUDE_MEM_CHROMA_SSL = String(settingsConfig.chromaSsl);
    }
  }

  return settings;
}

export function writeSettings(
  providerConfig: ProviderConfig,
  settingsConfig: SettingsConfig,
): void {
  const dataDir = expandDataDir(settingsConfig.dataDir);
  const settingsPath = join(dataDir, 'settings.json');

  // Ensure data directory exists
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  // Merge with existing settings if upgrading
  let existingSettings: Record<string, string> = {};
  if (existsSync(settingsPath)) {
    const raw = readFileSync(settingsPath, 'utf-8');
    existingSettings = JSON.parse(raw);
  }

  const newSettings = buildSettingsObject(providerConfig, settingsConfig);

  // Merge: new settings override existing ones
  const merged = { ...existingSettings, ...newSettings };

  writeFileSync(settingsPath, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
}
