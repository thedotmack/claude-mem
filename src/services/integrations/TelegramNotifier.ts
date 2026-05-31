
import { ParsedObservation } from '../../sdk/parser.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';

export interface TelegramNotifyInput {
  observations: ParsedObservation[];
  observationIds: number[];
  project: string;
  memorySessionId: string;
  platformSource?: string;
}

const MARKDOWN_V2_RESERVED = /[_*\[\]()~`>#+\-=|{}.!\\]/g;

const TYPE_EMOJI: Record<string, string> = {
  security_alert: '🚨',
  security_note: '🔐',
};
const DEFAULT_EMOJI = '🔔';

function normalizePlatformSource(value: string | undefined): string {
  const normalized = (value ?? '').trim().toLowerCase();
  if (normalized.includes('codex')) return 'codex';
  if (normalized.includes('cursor')) return 'cursor';
  if (normalized.includes('openclaw')) return 'openclaw';
  if (normalized.includes('claude')) return 'claude';
  return normalized || 'claude';
}

function platformSessionLabel(platformSource: string | undefined): string {
  switch (normalizePlatformSource(platformSource)) {
    case 'codex':
      return 'Codex Session';
    case 'cursor':
      return 'Cursor Session';
    case 'openclaw':
      return 'OpenClaw Session';
    default:
      return 'Claude Code Session';
  }
}

function normalizeTitleForPlatform(title: string | null | undefined, platformSource: string | undefined): string {
  const value = title ?? '';
  if (normalizePlatformSource(platformSource) !== 'codex') {
    return value;
  }

  return value.replace(/^Claude Code Session\b/i, platformSessionLabel(platformSource));
}

function escapeMarkdownV2(value: string): string {
  return value.replace(MARKDOWN_V2_RESERVED, '\\$&');
}

function splitCsv(value: string): string[] {
  return value
    .split(',')
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0);
}

export function formatMessage(
  obs: ParsedObservation,
  project: string,
  memorySessionId: string,
  observationId: number,
  platformSource?: string,
): string {
  const emoji = TYPE_EMOJI[obs.type] ?? DEFAULT_EMOJI;
  const type = escapeMarkdownV2(obs.type);
  const title = escapeMarkdownV2(normalizeTitleForPlatform(obs.title, platformSource));
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

export async function notifyTelegram(input: TelegramNotifyInput): Promise<void> {
  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);

  if (settings.CLAUDE_MEM_TELEGRAM_ENABLED !== 'true') {
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

  const { observations, observationIds, project, memorySessionId, platformSource } = input;
  for (let i = 0; i < observations.length; i++) {
    const obs = observations[i];
    const matchesType = triggerTypes.includes(obs.type);
    const matchesConcept = obs.concepts.some(c => triggerConcepts.includes(c));
    if (!matchesType && !matchesConcept) {
      continue;
    }

    const observationId = observationIds[i];
    try {
      const text = formatMessage(obs, project, memorySessionId, observationId, platformSource);
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
