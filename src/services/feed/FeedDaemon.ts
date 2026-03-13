/**
 * FeedDaemon
 *
 * Lives inside the worker process. Listens for SSE broadcast events
 * (new_observation, new_summary) via SSEBroadcaster.onBroadcast() and
 * sends formatted messages to Telegram.
 *
 * No HTTP loopback - uses internal listener API directly.
 * Uses HTML parse mode to avoid Markdown escaping issues with code symbols.
 */

import { TelegramClient } from './TelegramClient.js';
import { loadFeedConfig, isFeedConfigured, type FeedConfig } from './FeedConfig.js';
import type { SSEBroadcaster } from '../worker/SSEBroadcaster.js';
import { logger } from '../../utils/logger.js';

// Emoji for observation types
const TYPE_EMOJI: Record<string, string> = {
  discovery: '\u{1F535}',        // blue circle
  bugfix: '\u{1F534}',           // red circle
  change: '\u{2705}',            // check mark
  decision: '\u{2696}\u{FE0F}',  // balance scale
  refactor: '\u{1F504}',         // arrows counterclockwise
  feature: '\u{1F7E3}',          // purple circle
};
const DEFAULT_EMOJI = '\u{1F4DD}'; // memo

// Failure backoff: mute sends after consecutive failures
const MAX_CONSECUTIVE_FAILURES = 5;
const MUTE_DURATION_MS = 60_000;

/**
 * Escape HTML special characters for Telegram HTML parse mode.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export class FeedDaemon {
  private client: TelegramClient | null = null;
  private unsubscribe: (() => void) | null = null;
  private config: FeedConfig | null = null;
  private lastMessageTime: number = 0;
  private _running: boolean = false;
  private consecutiveFailures: number = 0;
  private mutedUntil: number = 0;

  get running(): boolean {
    return this._running;
  }

  /**
   * Start the feed daemon. Loads config, creates Telegram client,
   * subscribes to SSE broadcasts.
   */
  start(broadcaster: SSEBroadcaster): boolean {
    if (this._running) {
      logger.warn('FEED', 'Feed daemon already running');
      return true;
    }

    this.config = loadFeedConfig();

    if (!this.config.enabled || !isFeedConfigured(this.config)) {
      logger.debug('FEED', 'Feed not configured or disabled, skipping start');
      return false;
    }

    this.client = new TelegramClient(this.config.botToken);
    this.consecutiveFailures = 0;
    this.mutedUntil = 0;

    this.unsubscribe = broadcaster.onBroadcast((event) => {
      this.handleEvent(event);
    });

    this._running = true;
    logger.info('FEED', 'Feed daemon started', { chatId: this.config.chatId });
    return true;
  }

  /**
   * Stop the feed daemon. Unsubscribes from broadcasts.
   */
  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    this.client = null;
    this._running = false;
    logger.info('FEED', 'Feed daemon stopped');
  }

  /**
   * Reload config and restart if needed.
   */
  restart(broadcaster: SSEBroadcaster): boolean {
    this.stop();
    return this.start(broadcaster);
  }

  /**
   * Send a test message to verify the connection.
   */
  async sendTestMessage(): Promise<void> {
    const config = this.config ?? loadFeedConfig();
    if (!isFeedConfigured(config)) {
      throw new Error('Feed not configured');
    }
    const client = this.client ?? new TelegramClient(config.botToken);
    await client.sendMessage(
      config.chatId,
      '\u{1F9E0} Claude-Mem Feed connected! Session observations will appear here.'
    );
  }

  getStatus(): {
    running: boolean;
    enabled: boolean;
    configured: boolean;
    chatId: string;
    lastMessageTime: number;
  } {
    const config = this.config ?? loadFeedConfig();
    return {
      running: this._running,
      enabled: config.enabled,
      configured: isFeedConfigured(config),
      chatId: config.chatId,
      lastMessageTime: this.lastMessageTime,
    };
  }

  private handleEvent(event: Record<string, unknown>): void {
    const type = event.type as string;

    if (type === 'new_observation' && event.observation) {
      this.sendObservation(event.observation as Record<string, unknown>);
    } else if (type === 'new_summary' && event.summary) {
      this.sendSummary(event.summary as Record<string, unknown>);
    }
  }

  /**
   * Check if currently muted due to consecutive failures.
   */
  private isMuted(): boolean {
    if (this.mutedUntil > 0 && Date.now() < this.mutedUntil) {
      return true;
    }
    if (this.mutedUntil > 0 && Date.now() >= this.mutedUntil) {
      // Mute period expired, reset
      this.mutedUntil = 0;
      this.consecutiveFailures = 0;
      logger.info('FEED', 'Mute period expired, resuming sends');
    }
    return false;
  }

  /**
   * Record a send failure. After MAX_CONSECUTIVE_FAILURES, mute for MUTE_DURATION_MS.
   */
  private recordFailure(err: Error): void {
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      this.mutedUntil = Date.now() + MUTE_DURATION_MS;
      logger.warn('FEED', `Muting feed for ${MUTE_DURATION_MS / 1000}s after ${this.consecutiveFailures} consecutive failures`, {
        lastError: err.message,
      });
    } else {
      logger.error('FEED', 'Failed to send to Telegram', {
        consecutiveFailures: this.consecutiveFailures,
      }, err);
    }
  }

  private recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.lastMessageTime = Date.now();
  }

  private sendObservation(obs: Record<string, unknown>): void {
    if (!this.client || !this.config || this.isMuted()) return;

    const obsType = (obs.type as string) || 'unknown';
    const emoji = TYPE_EMOJI[obsType] || DEFAULT_EMOJI;
    const title = escapeHtml((obs.title as string) || 'Untitled');
    const project = (obs.project as string) || '';
    const narrative = (obs.narrative as string) || (obs.text as string) || '';

    const projectLabel = project ? `[${escapeHtml(project.split('/').pop()!)}]` : '';
    const lines = [
      `${emoji} <b>${title}</b> ${projectLabel}`,
    ];

    if (narrative) {
      const maxLen = 500;
      const truncated = narrative.length > maxLen
        ? narrative.slice(0, maxLen) + '...'
        : narrative;
      lines.push(escapeHtml(truncated));
    }

    const text = lines.join('\n');
    this.client.sendMessage(this.config.chatId, text, 'HTML').then(
      () => this.recordSuccess(),
      (err) => this.recordFailure(err as Error),
    );
  }

  private sendSummary(summary: Record<string, unknown>): void {
    if (!this.client || !this.config || this.isMuted()) return;

    const project = (summary.project as string) || '';
    const projectLabel = project ? `[${escapeHtml(project.split('/').pop()!)}]` : '';
    const request = (summary.request as string) || '';
    const completed = (summary.completed as string) || '';

    const lines = [
      `\u{1F4CB} <b>Session Summary</b> ${projectLabel}`,
    ];

    if (request) lines.push(`<b>Request:</b> ${escapeHtml(request)}`);
    if (completed) lines.push(`<b>Completed:</b> ${escapeHtml(completed)}`);

    const text = lines.join('\n');
    this.client.sendMessage(this.config.chatId, text, 'HTML').then(
      () => this.recordSuccess(),
      (err) => this.recordFailure(err as Error),
    );
  }
}
