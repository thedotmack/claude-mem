
import { ParsedObservation } from '../../sdk/parser.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';
import { escapeMarkdownV2, postTelegramMessage } from './telegram-transport.js';

export interface TelegramNotifyInput {
  observations: ParsedObservation[];
  observationIds: number[];
  project: string;
  memorySessionId: string;
}

const TYPE_EMOJI: Record<string, string> = {
  security_alert: '🚨',
  security_note: '🔐',
  sensitive: '🤫',
};
const DEFAULT_EMOJI = '🔔';

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

export async function notifyTelegram(input: TelegramNotifyInput): Promise<void> {
  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);

  if (settings.CLAUDE_MEM_TELEGRAM_ENABLED !== 'true') {
    return;
  }
  if (settings.CLAUDE_MEM_TELEGRAM_OBSERVATION_ALERTS_ENABLED !== 'true') {
    return;
  }

  const botToken = settings.CLAUDE_MEM_TELEGRAM_BOT_TOKEN;
  const chatId = settings.CLAUDE_MEM_TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) {
    return;
  }

  const triggerTypes = splitCsv(settings.CLAUDE_MEM_TELEGRAM_TRIGGER_TYPES);
  const triggerConcepts = splitCsv(settings.CLAUDE_MEM_TELEGRAM_TRIGGER_CONCEPTS);
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
      await postTelegramMessage(botToken, chatId, text);
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
}
