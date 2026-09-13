import { type SettingsDefaults, SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { SessionStore } from '../sqlite/SessionStore.js';
import { logger } from '../../utils/logger.js';
import { escapeMarkdownV2, postTelegramMessage } from './telegram-transport.js';

const MAX_WRAPUP_FIELD_CHARS = 600;
const MAX_PROJECT_CHARS = 300;
const MAX_PLATFORM_CHARS = 100;
const MAX_PROMPT_NUMBER_CHARS = 50;

export interface TelegramWrapupRoute {
  chat_id: string;
  bot_token?: string;
  key?: string;
}

export interface TelegramWrapupConfig {
  enabled: boolean;
  wrapupsEnabled: boolean;
  botToken: string;
  routes: Record<string, TelegramWrapupRoute>;
}

export interface ResolvedTelegramWrapupRoute {
  chatId: string;
  botToken: string;
  routeKey: string;
  matchedProject: string;
}

export interface WrapupMessageInput {
  project: string;
  platformSource: string;
  contentSessionId: string;
  summary: {
    request: string | null;
    completed: string | null;
    next_steps: string | null;
    notes: string | null;
    prompt_number: number | null;
  };
}

export interface WrapupDeliveryInput {
  sessionStore: SessionStore;
  sessionDbId: number;
  settings?: SettingsDefaults;
  fetchImpl?: typeof fetch;
}

function isRouteMap(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toRoute(value: unknown): TelegramWrapupRoute | null {
  if (!isRouteMap(value) || typeof value.chat_id !== 'string' || !value.chat_id) {
    return null;
  }
  if (value.bot_token !== undefined && typeof value.bot_token !== 'string') {
    return null;
  }
  if (value.key !== undefined && typeof value.key !== 'string') {
    return null;
  }
  return {
    chat_id: value.chat_id,
    ...(typeof value.bot_token === 'string' ? { bot_token: value.bot_token } : {}),
    ...(typeof value.key === 'string' ? { key: value.key } : {}),
  };
}

export function loadTelegramWrapupConfig(settings: SettingsDefaults): TelegramWrapupConfig {
  const parsedRoutes: unknown = JSON.parse(settings.CLAUDE_MEM_TELEGRAM_WRAPUP_ROUTES || '{}');
  if (!isRouteMap(parsedRoutes)) {
    throw new Error('CLAUDE_MEM_TELEGRAM_WRAPUP_ROUTES must be a JSON object');
  }

  const routes: Record<string, TelegramWrapupRoute> = {};
  for (const [project, routeValue] of Object.entries(parsedRoutes)) {
    const route = toRoute(routeValue);
    if (route) {
      routes[project] = route;
    }
  }

  return {
    enabled: settings.CLAUDE_MEM_TELEGRAM_ENABLED === 'true',
    wrapupsEnabled: settings.CLAUDE_MEM_TELEGRAM_WRAPUPS_ENABLED === 'true',
    botToken: settings.CLAUDE_MEM_TELEGRAM_BOT_TOKEN,
    routes,
  };
}

function resolveRouteEntry(
  config: TelegramWrapupConfig,
  project: string,
): ResolvedTelegramWrapupRoute | null {
  const route = config.routes[project];
  if (!route) return null;
  return {
    chatId: route.chat_id,
    botToken: route.bot_token ?? config.botToken,
    routeKey: route.key ?? project,
    matchedProject: project,
  };
}

export function resolveWrapupRoute(
  config: TelegramWrapupConfig,
  project: string,
): ResolvedTelegramWrapupRoute | null {
  const exact = resolveRouteEntry(config, project);
  if (exact) return exact;

  const separator = project.indexOf('/');
  if (separator < 0) return null;
  return resolveRouteEntry(config, project.slice(0, separator));
}

function escapeAndTruncate(value: string | null | undefined, maxChars: number): string {
  const chars = Array.from(value ?? '');
  const candidate = chars.slice(0, maxChars).join('');
  const escapedCandidate = escapeMarkdownV2(candidate);
  if (chars.length <= maxChars && escapedCandidate.length <= maxChars) {
    return escapedCandidate;
  }

  let escaped = '';
  for (const char of chars.slice(0, Math.max(0, maxChars - 1))) {
    const escapedChar = escapeMarkdownV2(char);
    if (escaped.length + escapedChar.length > maxChars - 1) break;
    escaped += escapedChar;
  }
  return escaped + '…';
}

export function formatWrapupMessage(input: WrapupMessageInput): string {
  const request = escapeAndTruncate(input.summary.request, MAX_WRAPUP_FIELD_CHARS);
  const completed = escapeAndTruncate(input.summary.completed, MAX_WRAPUP_FIELD_CHARS);
  const nextSteps = escapeAndTruncate(input.summary.next_steps, MAX_WRAPUP_FIELD_CHARS);
  const notes = input.summary.notes === null
    ? null
    : escapeAndTruncate(input.summary.notes, MAX_WRAPUP_FIELD_CHARS);
  const project = escapeAndTruncate(input.project, MAX_PROJECT_CHARS);
  const platformSource = escapeAndTruncate(input.platformSource, MAX_PLATFORM_CHARS);
  const sessionId = escapeMarkdownV2(input.contentSessionId.slice(0, 8));
  const promptNumber = escapeAndTruncate(
    String(input.summary.prompt_number ?? 'unknown'),
    MAX_PROMPT_NUMBER_CHARS,
  );

  const inlineCode = String.fromCharCode(96);
  return [
    '✅ *Session wrap\\-up* — ' + inlineCode + project + inlineCode,
    '*Request:* ' + request,
    '*Completed:* ' + completed,
    '*Next steps:* ' + nextSteps,
    ...(notes === null ? [] : ['*Notes:* ' + notes]),
    '_' + platformSource + ' · session ' + sessionId + ' · turn ' + promptNumber + '_',
  ].join('\n');
}

export async function deliverSessionWrapup(
  input: WrapupDeliveryInput,
): Promise<'sent' | 'already_sent' | 'no_route' | 'no_summary' | 'disabled' | 'unknown_session'> {
  try {
    const settings = input.settings ?? SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    const config = loadTelegramWrapupConfig(settings);
    if (!config.enabled || !config.wrapupsEnabled) {
      return 'disabled';
    }
    if (Object.keys(config.routes).length === 0) {
      logger.debug('TELEGRAM', 'Telegram wrap-up routes are not configured', {
        sessionDbId: input.sessionDbId,
      });
      return 'disabled';
    }

    const session = input.sessionStore.getSessionById(input.sessionDbId);
    if (!session) {
      return 'unknown_session';
    }
    if (!session.memory_session_id) {
      logger.info('TELEGRAM', 'No summary available for Telegram session wrap-up', {
        sessionDbId: input.sessionDbId,
        contentSessionId: session.content_session_id,
      });
      return 'no_summary';
    }

    const summary = input.sessionStore.getSummaryForSession(session.memory_session_id);
    if (!summary) {
      logger.info('TELEGRAM', 'No summary available for Telegram session wrap-up', {
        sessionDbId: input.sessionDbId,
        contentSessionId: session.content_session_id,
      });
      return 'no_summary';
    }

    const route = resolveWrapupRoute(config, session.project);
    if (!route) {
      logger.warn('TELEGRAM', 'No wrap-up route for project', {
        project: session.project,
        platformSource: session.platform_source,
        contentSessionId: session.content_session_id,
      });
      return 'no_route';
    }

    const ledgerInput = {
      platformSource: session.platform_source,
      contentSessionId: session.content_session_id,
      project: session.project,
      routeKey: route.routeKey,
    };
    const claimed = input.sessionStore.claimTelegramWrapup({
      ...ledgerInput,
      summaryCreatedAtEpoch: summary.created_at_epoch,
    });
    if (!claimed) {
      return 'already_sent';
    }

    try {
      const text = formatWrapupMessage({
        project: session.project,
        platformSource: session.platform_source,
        contentSessionId: session.content_session_id,
        summary,
      });
      await postTelegramMessage(route.botToken, route.chatId, text, input.fetchImpl);
    } catch (error) {
      input.sessionStore.releaseTelegramWrapupClaim(ledgerInput);
      throw error;
    }

    try {
      input.sessionStore.markTelegramWrapupSent(ledgerInput);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.warn('TELEGRAM', 'Telegram session wrap-up was sent but could not be marked sent; retaining claim', {
        sessionDbId: input.sessionDbId,
        project: session.project,
        platformSource: session.platform_source,
        contentSessionId: session.content_session_id,
      }, err);
      throw err;
    }

    return 'sent';
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.warn('TELEGRAM', 'Failed to deliver Telegram session wrap-up', {
      sessionDbId: input.sessionDbId,
    }, err);
    throw err;
  }
}
