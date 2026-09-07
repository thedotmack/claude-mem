
import { ParsedObservation } from '../../sdk/parser.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';

export interface TelegramNotifyInput {
  observations: ParsedObservation[];
  observationIds: number[];
  project: string;
  memorySessionId: string;
}

interface TriggerMatchReason {
  matchedType: boolean;
  matchedConcepts: string[];
}

const MARKDOWN_V2_RESERVED = /[_*\[\]()~`>#+\-=|{}.!\\]/g;

const TYPE_EMOJI: Record<string, string> = {
  security_alert: '🚨',
  security_note: '🔐',
  sensitive: '🤫',
};
const DEFAULT_EMOJI = '🔔';

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
  const emoji = TYPE_EMOJI[obs.type] ?? DEFAULT_EMOJI;
  const type = escapeMarkdownV2(obs.type);
  const title = escapeMarkdownV2(obs.title ?? '');
  const subtitle = escapeMarkdownV2(obs.subtitle ?? '');
  const projectEscaped = escapeMarkdownV2(project);
  const idEscaped = escapeMarkdownV2(String(observationId));
  return `${emoji} *${type}* — ${title}\n${subtitle}\nProject: \`${projectEscaped}\` · obs \\#${idEscaped}`;
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

function getTriggerMatchReason(
  observation: ParsedObservation,
  triggerTypes: string[],
  triggerConcepts: string[],
): TriggerMatchReason {
  const matchedType = triggerTypes.includes(observation.type);
  const matchedConcepts = observation.concepts.filter(concept => triggerConcepts.includes(concept));
  return { matchedType, matchedConcepts };
}

async function postBrainbeat(
  webhookUrl: string,
  sharedSecret: string,
  observation: ParsedObservation,
  observationId: number,
  project: string,
  reason: TriggerMatchReason,
): Promise<void> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (sharedSecret.trim().length > 0) {
    headers['x-claude-mem-shared-secret'] = sharedSecret;
  }

  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      event: 'claude_mem.brainbeat',
      observation_id: observationId,
      type: observation.type,
      title: observation.title,
      subtitle: observation.subtitle,
      project,
      concepts: observation.concepts,
      why_fired: {
        matched_type: reason.matchedType,
        matched_concepts: reason.matchedConcepts,
      },
      timestamp: new Date().toISOString(),
    }),
  });
  if (!response.ok) {
    throw new Error(`Brainbeat webhook responded ${response.status} ${response.statusText}`);
  }
}

export async function notifyTelegram(input: TelegramNotifyInput): Promise<void> {
  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);

  const telegramEnabled = settings.CLAUDE_MEM_TELEGRAM_ENABLED === 'true';
  const botToken = settings.CLAUDE_MEM_TELEGRAM_BOT_TOKEN;
  const chatId = settings.CLAUDE_MEM_TELEGRAM_CHAT_ID;
  const canSendTelegram = telegramEnabled && Boolean(botToken) && Boolean(chatId);
  const webhookUrl = settings.CLAUDE_MEM_GROK_BOT_WEBHOOK_URL.trim();
  const webhookSecret = settings.CLAUDE_MEM_GROK_BOT_WEBHOOK_SECRET;
  const canSendBrainbeat = webhookUrl.length > 0;

  const triggerTypes = splitCsv(settings.CLAUDE_MEM_TELEGRAM_TRIGGER_TYPES);
  const triggerConcepts = splitCsv(settings.CLAUDE_MEM_TELEGRAM_TRIGGER_CONCEPTS);
  if (triggerTypes.length === 0 && triggerConcepts.length === 0) {
    return;
  }
  if (!canSendTelegram && !canSendBrainbeat) {
    return;
  }

  const { observations, observationIds, project, memorySessionId } = input;
  for (let i = 0; i < observations.length; i++) {
    const obs = observations[i];
    const reason = getTriggerMatchReason(obs, triggerTypes, triggerConcepts);
    if (!reason.matchedType && reason.matchedConcepts.length === 0) {
      continue;
    }

    const observationId = observationIds[i];
    if (canSendTelegram) {
      try {
        const text = formatMessage(obs, project, memorySessionId, observationId);
        await postOne(botToken, chatId, text);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        logger.warn('TELEGRAM', 'Failed to send Telegram notification', {
          observationId,
          project,
          memorySessionId,
          type: obs.type,
        }, err);
      }
    }

    if (canSendBrainbeat) {
      try {
        await postBrainbeat(webhookUrl, webhookSecret, obs, observationId, project, reason);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        logger.warn('TELEGRAM', 'Failed to send brainbeat webhook', {
          observationId,
          project,
          memorySessionId,
          type: obs.type,
          webhookUrl,
        }, err);
      }
    }
  }
}
