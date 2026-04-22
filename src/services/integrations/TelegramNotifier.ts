/**
 * TelegramNotifier
 *
 * Fire-and-forget Telegram notification module. Fires one message per observation
 * whose type or concepts match user-configured triggers. Never throws; all errors
 * are caught per-observation and logged as warnings. Bot token is never logged.
 */

import { ParsedObservation } from '../../sdk/parser.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { logger } from '../../utils/logger.js';

export interface TelegramNotifyInput {
  observations: ParsedObservation[];
  observationIds: number[];
  project: string;
  memorySessionId: string;
}

const MARKDOWN_V2_RESERVED = /[_*\[\]()~`>#+\-=|{}.!\\]/g;

function escapeMarkdownV2(value: string): string {
  return value.replace(MARKDOWN_V2_RESERVED, '\\$&');
}

function splitCsv(value: string): string[] {
  return value
    .split(',')
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0);
}

function formatMessage(
  obs: ParsedObservation,
  project: string,
  memorySessionId: string,
  observationId: number,
): string {
  const type = escapeMarkdownV2(obs.type);
  const title = escapeMarkdownV2(obs.title ?? '');
  const subtitle = escapeMarkdownV2(obs.subtitle ?? '');
  const projectEscaped = escapeMarkdownV2(project);
  const idEscaped = escapeMarkdownV2(String(observationId));
  return `🚨 *${type}* — ${title}\n${subtitle}\nProject: \`${projectEscaped}\` · obs \\#${idEscaped}`;
}

async function postOne(botToken: string, chatId: string, text: string): Promise<void> {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'MarkdownV2',
    }),
  });
  if (!response.ok) {
    const status = response.status;
    const statusText = response.statusText;
    throw new Error(`Telegram API responded ${status} ${statusText}`);
  }
}

export async function notifyTelegram(input: TelegramNotifyInput): Promise<void> {
  const botToken = SettingsDefaultsManager.get('CLAUDE_MEM_TELEGRAM_BOT_TOKEN');
  const chatId = SettingsDefaultsManager.get('CLAUDE_MEM_TELEGRAM_CHAT_ID');
  if (!botToken || !chatId) {
    return;
  }

  const triggerTypes = splitCsv(SettingsDefaultsManager.get('CLAUDE_MEM_TELEGRAM_TRIGGER_TYPES'));
  const triggerConcepts = splitCsv(SettingsDefaultsManager.get('CLAUDE_MEM_TELEGRAM_TRIGGER_CONCEPTS'));
  if (triggerTypes.length === 0 && triggerConcepts.length === 0) {
    return;
  }

  const { observations, observationIds, project, memorySessionId } = input;
  for (let i = 0; i < observations.length; i++) {
    const obs = observations[i];
    const matchesType = triggerTypes.includes(obs.type);
    const matchesConcept = obs.concepts.some(c => triggerConcepts.includes(c));
    if (!matchesType && !matchesConcept) {
      continue;
    }

    const observationId = observationIds[i];
    try {
      const text = formatMessage(obs, project, memorySessionId, observationId);
      await postOne(botToken, chatId, text);
    } catch (error) {
      logger.warn('TELEGRAM', 'Failed to send Telegram notification', {
        observationId,
        project,
        memorySessionId,
        type: obs.type,
      }, error as Error);
    }
  }
}
