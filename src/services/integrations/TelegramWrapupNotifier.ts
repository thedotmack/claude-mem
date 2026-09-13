import { type SettingsDefaults, SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { SessionStore } from '../sqlite/SessionStore.js';
import { logger } from '../../utils/logger.js';
import { escapeMarkdownV2, postTelegramMessage } from './telegram-transport.js';

export const TELEGRAM_WRAPUP_PROMPT = 'format as a very short bulleted list that narratively explains this summary in < 255 char';

const MAX_WRAPUP_CHARS = 255;

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

export interface TelegramWrapupFormatterInput {
  sessionDbId: number;
  contentSessionId: string;
  project: string;
  platformSource: string;
  summaryText: string;
}

export type TelegramWrapupFormatter = (input: TelegramWrapupFormatterInput) => Promise<string>;

export interface WrapupDeliveryInput {
  sessionStore: SessionStore;
  sessionDbId: number;
  formatSummary: TelegramWrapupFormatter;
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

export function joinStoredSummaryForTelegram(summary: {
  request: string | null;
  investigated: string | null;
  learned: string | null;
  completed: string | null;
  next_steps: string | null;
  files_read: string | null;
  files_edited: string | null;
  notes: string | null;
}): string {
  return [
    summary.request ?? '',
    summary.investigated ?? '',
    summary.learned ?? '',
    summary.completed ?? '',
    summary.next_steps ?? '',
    summary.files_read ?? '',
    summary.files_edited ?? '',
    summary.notes ?? '',
  ].join('\n');
}

export function buildTelegramWrapupPrompt(summaryText: string): string {
  return `${TELEGRAM_WRAPUP_PROMPT}\n\n${summaryText}`;
}

function fitsTelegramLimit(value: string): boolean {
  return escapeMarkdownV2(value).length <= MAX_WRAPUP_CHARS;
}

function isBulletStart(line: string): boolean {
  return /^\s*(?:[-*•])(?:\s|$)/.test(line);
}

/** Escape a model-produced list, retaining only complete bullets when it is too long. */
export function formatWrapupMessage(modelOutput: string): string {
  const normalized = modelOutput.trim();
  if (!normalized) {
    const error = new Error('Telegram wrap-up formatter returned no text');
    logger.error('TELEGRAM', error.message, {}, error);
    throw error;
  }
  if (fitsTelegramLimit(normalized)) {
    return escapeMarkdownV2(normalized);
  }

  const lines = normalized.split(/\r?\n/);
  const bulletStarts = lines.reduce<number[]>((starts, line, index) => {
    if (isBulletStart(line)) starts.push(index);
    return starts;
  }, []);

  let capped = '';
  for (let index = 0; index < bulletStarts.length; index++) {
    const start = bulletStarts[index];
    const end = bulletStarts[index + 1] ?? lines.length;
    const bullet = lines.slice(start, end).join('\n').trim();
    const candidate = capped ? `${capped}\n${bullet}` : bullet;
    if (!fitsTelegramLimit(candidate)) break;
    capped = candidate;
  }

  if (!capped) {
    const error = new Error('Telegram wrap-up has no complete bullet within 255 characters');
    logger.error('TELEGRAM', error.message, { outputChars: normalized.length, bullets: bulletStarts.length }, error);
    throw error;
  }
  return escapeMarkdownV2(capped);
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
      const text = formatWrapupMessage(await input.formatSummary({
        sessionDbId: input.sessionDbId,
        contentSessionId: session.content_session_id,
        project: session.project,
        platformSource: session.platform_source,
        summaryText: joinStoredSummaryForTelegram(summary),
      }));
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
