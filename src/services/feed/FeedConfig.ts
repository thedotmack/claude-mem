/**
 * FeedConfig
 *
 * Configuration types, loading, saving, and validation for the Claude-mem feed.
 * Feed settings are stored in ~/.claude-mem/settings.json alongside other settings.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'fs';
import { dirname } from 'path';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';

export interface FeedConfig {
  enabled: boolean;
  channel: string;
  botToken: string;
  chatId: string;
}

const BOT_TOKEN_REGEX = /^\d+:[A-Za-z0-9_-]{35,}$/;

export function validateBotToken(token: string): boolean {
  return BOT_TOKEN_REGEX.test(token.trim());
}

export function loadFeedConfig(): FeedConfig {
  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
  return {
    enabled: settings.CLAUDE_MEM_FEED_ENABLED === 'true',
    channel: settings.CLAUDE_MEM_FEED_CHANNEL || 'telegram',
    botToken: settings.CLAUDE_MEM_FEED_BOT_TOKEN || '',
    chatId: settings.CLAUDE_MEM_FEED_CHAT_ID || '',
  };
}

export function isFeedConfigured(config: FeedConfig): boolean {
  return config.botToken !== '' && config.chatId !== '';
}

export function saveFeedConfig(config: FeedConfig): void {
  let existing: Record<string, unknown> = {};

  if (existsSync(USER_SETTINGS_PATH)) {
    try {
      existing = JSON.parse(readFileSync(USER_SETTINGS_PATH, 'utf-8'));
    } catch {
      existing = {};
    }
  } else {
    const dir = dirname(USER_SETTINGS_PATH);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  existing.CLAUDE_MEM_FEED_ENABLED = config.enabled ? 'true' : 'false';
  existing.CLAUDE_MEM_FEED_CHANNEL = config.channel;
  existing.CLAUDE_MEM_FEED_BOT_TOKEN = config.botToken;
  existing.CLAUDE_MEM_FEED_CHAT_ID = config.chatId;

  writeFileSync(USER_SETTINGS_PATH, JSON.stringify(existing, null, 2), 'utf-8');

  // Settings file contains bot token — restrict to owner-only
  try {
    chmodSync(USER_SETTINGS_PATH, 0o600);
  } catch {
    // Best-effort: Windows doesn't support Unix permissions
  }
}
