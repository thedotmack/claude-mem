/**
 * TelegramClient
 *
 * Minimal Telegram Bot API client for the Claude-mem feed.
 * Supports getMe, getUpdates, getChat, sendMessage.
 * Base URL is overridable for testing with a mock server.
 */

import { logger } from '../../utils/logger.js';

const REQUEST_TIMEOUT_MS = 10_000;

export interface TelegramUser {
  username: string;
  firstName: string;
}

export interface TelegramChat {
  chatId: string;
  chatTitle: string;
  chatType: string;
}

export interface TelegramChatInfo {
  title: string;
  type: string;
}

export class TelegramClient {
  private botToken: string;
  private baseUrl: string;

  constructor(botToken: string, baseUrl?: string) {
    this.botToken = botToken;
    this.baseUrl = baseUrl || process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';
  }

  private async request<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    const url = `${this.baseUrl}/bot${this.botToken}/${method}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: params ? JSON.stringify(params) : undefined,
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Telegram API error ${response.status}: ${text}`);
      }

      const data = await response.json() as { ok: boolean; result: T; description?: string };
      if (!data.ok) {
        throw new Error(`Telegram API returned error: ${data.description || 'Unknown error'}`);
      }

      return data.result;
    } finally {
      clearTimeout(timeout);
    }
  }

  async getMe(): Promise<TelegramUser> {
    const result = await this.request<{ username: string; first_name: string }>('getMe');
    return {
      username: result.username,
      firstName: result.first_name,
    };
  }

  async getUpdates(): Promise<TelegramChat[]> {
    const updates = await this.request<Array<{
      message?: {
        chat: { id: number; title?: string; type: string };
      };
    }>>('getUpdates');

    const seen = new Map<string, TelegramChat>();
    for (const update of updates) {
      if (update.message?.chat) {
        const chat = update.message.chat;
        const chatId = String(chat.id);
        if (!seen.has(chatId)) {
          seen.set(chatId, {
            chatId,
            chatTitle: chat.title || `Private chat ${chatId}`,
            chatType: chat.type,
          });
        }
      }
    }

    return Array.from(seen.values());
  }

  async getChat(chatId: string): Promise<TelegramChatInfo> {
    const result = await this.request<{ title?: string; type: string }>('getChat', {
      chat_id: chatId,
    });
    return {
      title: result.title || 'Private chat',
      type: result.type,
    };
  }

  async sendMessage(chatId: string, text: string, parseMode?: string): Promise<void> {
    await this.request('sendMessage', {
      chat_id: chatId,
      text,
      ...(parseMode && { parse_mode: parseMode }),
    });
    logger.debug('FEED', 'Message sent to Telegram', { chatId });
  }
}
