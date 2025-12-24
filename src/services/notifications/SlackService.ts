/**
 * SlackService - Slack Socket Mode Integration
 *
 * Handles bidirectional communication with Slack:
 * - Sends notifications when Claude Code is waiting for user input
 * - Receives responses via Socket Mode (no public URL needed)
 * - Triggers session continuation via ClaudeCodeLauncher
 */

import { WebClient } from '@slack/web-api';
import { SocketModeClient } from '@slack/socket-mode';
import { logger } from '../../utils/logger.js';
import { SettingsDefaultsManager, SettingsDefaults } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';

export interface SlackNotification {
  project: string;
  sessionId: string;
  question: string;
  fullMessage: string;
  waitingSessionId: number;
}

export interface SlackResponse {
  threadTs: string;
  channelId: string;
  text: string;
  userId: string;
}

type ResponseHandler = (response: SlackResponse) => Promise<void>;

export class SlackService {
  private webClient: WebClient | null = null;
  private socketClient: SocketModeClient | null = null;
  private settings: SettingsDefaults;
  private isConnected: boolean = false;
  private responseHandler: ResponseHandler | null = null;

  constructor() {
    this.settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
  }

  /**
   * Check if Slack integration is enabled and configured
   */
  isEnabled(): boolean {
    return (
      this.settings.CLAUDE_MEM_SLACK_ENABLED === 'true' &&
      !!this.settings.CLAUDE_MEM_SLACK_BOT_TOKEN &&
      !!this.settings.CLAUDE_MEM_SLACK_APP_TOKEN &&
      !!this.settings.CLAUDE_MEM_SLACK_CHANNEL_ID
    );
  }

  /**
   * Check if notifications on questions are enabled
   */
  shouldNotifyOnQuestions(): boolean {
    return this.settings.CLAUDE_MEM_SLACK_NOTIFY_ON_QUESTIONS === 'true';
  }

  /**
   * Get session expiry hours
   */
  getSessionExpiryHours(): number {
    return parseInt(this.settings.CLAUDE_MEM_SLACK_SESSION_EXPIRY_HOURS, 10) || 24;
  }

  /**
   * Get the configured channel ID
   */
  getChannelId(): string {
    return this.settings.CLAUDE_MEM_SLACK_CHANNEL_ID;
  }

  /**
   * Set the handler for incoming responses
   */
  setResponseHandler(handler: ResponseHandler): void {
    this.responseHandler = handler;
  }

  /**
   * Initialize Slack clients and connect
   */
  async initialize(): Promise<void> {
    if (!this.isEnabled()) {
      logger.info('SLACK', 'Slack integration is disabled');
      return;
    }

    try {
      // Initialize Web API client (for sending messages)
      this.webClient = new WebClient(this.settings.CLAUDE_MEM_SLACK_BOT_TOKEN);

      // Initialize Socket Mode client (for receiving events)
      this.socketClient = new SocketModeClient({
        appToken: this.settings.CLAUDE_MEM_SLACK_APP_TOKEN,
        // Auto-reconnect on disconnect
      });

      // Set up event handlers
      this.setupEventHandlers();

      // Connect to Slack
      await this.socketClient.start();
      this.isConnected = true;

      logger.success('SLACK', 'Connected to Slack via Socket Mode');
    } catch (error: any) {
      logger.error('SLACK', 'Failed to initialize Slack', {}, error);
      this.isConnected = false;
    }
  }

  /**
   * Set up Socket Mode event handlers
   */
  private setupEventHandlers(): void {
    if (!this.socketClient) return;

    // Handle all Socket Mode events (for debugging)
    this.socketClient.on('slack_event', async ({ event, body, ack }) => {
      // Acknowledge the event immediately
      if (ack) await ack();

      // The Slack SDK passes event data in body.event for slack_event handler
      const actualEvent = body?.event || event;

      // Log event for debugging (reduced verbosity)
      logger.debug('SLACK', 'Received slack_event', {
        type: actualEvent?.type,
        hasThreadTs: !!actualEvent?.thread_ts,
        hasBotId: !!actualEvent?.bot_id,
      });

      // Only handle message events
      if (actualEvent?.type !== 'message') {
        return;
      }

      // Only process thread replies (not top-level messages)
      if (!actualEvent.thread_ts || actualEvent.thread_ts === actualEvent.ts) {
        logger.debug('SLACK', 'Ignoring non-thread message', { ts: actualEvent.ts });
        return;
      }

      // Ignore bot messages (including our own)
      if (actualEvent.bot_id || actualEvent.subtype === 'bot_message') {
        logger.debug('SLACK', 'Ignoring bot message', { botId: actualEvent.bot_id });
        return;
      }

      const response: SlackResponse = {
        threadTs: actualEvent.thread_ts,
        channelId: actualEvent.channel,
        text: actualEvent.text || '',
        userId: actualEvent.user || '',
      };

      logger.info('SLACK', 'Received thread reply', {
        threadTs: response.threadTs,
        channelId: response.channelId,
        textLength: response.text.length,
      });

      if (this.responseHandler) {
        try {
          await this.responseHandler(response);
        } catch (error: any) {
          logger.error('SLACK', 'Error handling response', {}, error);
        }
      }
    });

    // Also handle 'message' event type for backwards compatibility
    this.socketClient.on('message', async ({ event, ack }: any) => {
      if (ack) await ack();

      // Log event for debugging (reduced verbosity)
      logger.debug('SLACK', 'Received message event', {
        type: event?.type,
        hasThreadTs: !!event?.thread_ts,
        hasBotId: !!event?.bot_id,
      });

      // Only process thread replies (not top-level messages)
      if (!event?.thread_ts || event.thread_ts === event.ts) {
        return;
      }

      // Ignore bot messages (including our own)
      if (event.bot_id || event.subtype === 'bot_message') {
        return;
      }

      const response: SlackResponse = {
        threadTs: event.thread_ts,
        channelId: event.channel,
        text: event.text || '',
        userId: event.user || '',
      };

      logger.info('SLACK', 'Received thread reply via message event', {
        threadTs: response.threadTs,
        channelId: response.channelId,
        textLength: response.text.length,
      });

      if (this.responseHandler) {
        try {
          await this.responseHandler(response);
        } catch (error: any) {
          logger.error('SLACK', 'Error handling response', {}, error);
        }
      }
    });

    // Handle connection events
    this.socketClient.on('connected', () => {
      logger.info('SLACK', 'Socket Mode connected');
      this.isConnected = true;
    });

    this.socketClient.on('disconnected', () => {
      logger.warn('SLACK', 'Socket Mode disconnected');
      this.isConnected = false;
    });

    this.socketClient.on('error', (error) => {
      logger.error('SLACK', 'Socket Mode error', {}, error as Error);
    });
  }

  /**
   * Send a notification to Slack when Claude is waiting for input
   * Returns the thread timestamp for correlation
   */
  async sendWaitingNotification(notification: SlackNotification): Promise<string | null> {
    if (!this.webClient || !this.isEnabled()) {
      logger.warn('SLACK', 'Cannot send notification - Slack not initialized');
      return null;
    }

    try {
      const blocks = this.buildNotificationBlocks(notification);

      const result = await this.webClient.chat.postMessage({
        channel: this.settings.CLAUDE_MEM_SLACK_CHANNEL_ID,
        text: `🤖 Claude is waiting for your response (${notification.project})`,
        blocks,
        unfurl_links: false,
        unfurl_media: false,
      });

      const threadTs = result.ts || null;

      if (threadTs) {
        logger.success('SLACK', 'Sent waiting notification', {
          project: notification.project,
          threadTs,
          waitingSessionId: notification.waitingSessionId,
        });
      }

      return threadTs;
    } catch (error: any) {
      logger.error('SLACK', 'Failed to send notification', {
        project: notification.project,
      }, error);
      return null;
    }
  }

  /**
   * Build Slack Block Kit blocks for the notification
   */
  private buildNotificationBlocks(notification: SlackNotification): any[] {
    const truncatedMessage = notification.fullMessage.length > 2000
      ? notification.fullMessage.substring(0, 2000) + '...'
      : notification.fullMessage;

    return [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: '🤖 Claude is waiting for your response',
          emoji: true,
        },
      },
      {
        type: 'section',
        fields: [
          {
            type: 'mrkdwn',
            text: `*Project:*\n${notification.project}`,
          },
          {
            type: 'mrkdwn',
            text: `*Session:*\n\`${notification.sessionId.substring(0, 8)}...\``,
          },
        ],
      },
      {
        type: 'divider',
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Question:*\n>${notification.question || 'See full message below'}`,
        },
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `_Reply in this thread to respond, or react with ✅ to continue with "yes"_`,
          },
        ],
      },
      {
        type: 'divider',
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Full Message:*\n\`\`\`${truncatedMessage}\`\`\``,
        },
      },
    ];
  }

  /**
   * Send a confirmation message after processing a response
   */
  async sendResponseConfirmation(
    channelId: string,
    threadTs: string,
    responseText: string
  ): Promise<void> {
    if (!this.webClient) return;

    try {
      await this.webClient.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: `✅ Got it! Continuing Claude Code session with your response:\n>"${responseText.substring(0, 100)}${responseText.length > 100 ? '...' : ''}"`,
      });
    } catch (error: any) {
      logger.error('SLACK', 'Failed to send confirmation', {}, error);
    }
  }

  /**
   * Send an error message to the thread
   */
  async sendErrorMessage(
    channelId: string,
    threadTs: string,
    errorMessage: string
  ): Promise<void> {
    if (!this.webClient) return;

    try {
      await this.webClient.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: `❌ Error: ${errorMessage}`,
      });
    } catch (error: any) {
      logger.error('SLACK', 'Failed to send error message', {}, error);
    }
  }

  /**
   * Send an informational message to the thread (not an error)
   */
  async sendInfoMessage(
    channelId: string,
    threadTs: string,
    message: string
  ): Promise<void> {
    if (!this.webClient) return;

    try {
      await this.webClient.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: `ℹ️ ${message}`,
      });
    } catch (error: any) {
      logger.error('SLACK', 'Failed to send info message', {}, error);
    }
  }

  /**
   * Send an update message when session is responded from a different channel
   */
  async sendSessionUpdateMessage(
    channelId: string,
    threadTs: string,
    source: 'local' | 'api',
    response: string
  ): Promise<void> {
    if (!this.webClient) return;

    const sourceLabel = source === 'local' ? 'Claude Code / VS Code' : 'API';

    try {
      await this.webClient.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: `✅ Session continued from ${sourceLabel} with: "${response.substring(0, 100)}${response.length > 100 ? '...' : ''}"`,
      });
    } catch (error: any) {
      logger.error('SLACK', 'Failed to send session update', {}, error);
    }
  }

  /**
   * Check if session summary sharing is enabled
   */
  shouldShareSummaries(): boolean {
    return this.settings.CLAUDE_MEM_SLACK_SHARE_SUMMARIES === 'true';
  }

  /**
   * Get observation types to auto-share
   */
  getShareTypes(): string[] {
    const types = this.settings.CLAUDE_MEM_SLACK_SHARE_TYPES || '';
    return types.split(',').map(t => t.trim()).filter(t => t.length > 0);
  }

  /**
   * Send a session summary to Slack
   */
  async sendSessionSummary(summary: {
    project: string;
    sessionId: string;
    request: string | null;
    completed: string | null;
    learned: string | null;
    nextSteps: string | null;
  }): Promise<string | null> {
    if (!this.webClient || !this.isEnabled() || !this.shouldShareSummaries()) {
      return null;
    }

    try {
      const blocks = this.buildSummaryBlocks(summary);

      const result = await this.webClient.chat.postMessage({
        channel: this.settings.CLAUDE_MEM_SLACK_CHANNEL_ID,
        text: `📋 Session Summary: ${summary.project}`,
        blocks,
        unfurl_links: false,
        unfurl_media: false,
      });

      const threadTs = result.ts || null;

      if (threadTs) {
        logger.success('SLACK', 'Sent session summary', {
          project: summary.project,
          threadTs,
        });
      }

      return threadTs;
    } catch (error: any) {
      logger.error('SLACK', 'Failed to send session summary', {
        project: summary.project,
      }, error);
      return null;
    }
  }

  /**
   * Build Slack Block Kit blocks for session summary
   */
  private buildSummaryBlocks(summary: {
    project: string;
    sessionId: string;
    request: string | null;
    completed: string | null;
    learned: string | null;
    nextSteps: string | null;
  }): any[] {
    const blocks: any[] = [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: '📋 Claude Session Summary',
          emoji: true,
        },
      },
      {
        type: 'section',
        fields: [
          {
            type: 'mrkdwn',
            text: `*Project:*\n${summary.project}`,
          },
          {
            type: 'mrkdwn',
            text: `*Session:*\n\`${summary.sessionId.substring(0, 8)}...\``,
          },
        ],
      },
      {
        type: 'divider',
      },
    ];

    // Add request if present
    if (summary.request) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*🎯 Request:*\n${this.truncateText(summary.request, 500)}`,
        },
      });
    }

    // Add completed if present
    if (summary.completed) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*✅ Completed:*\n${this.truncateText(summary.completed, 500)}`,
        },
      });
    }

    // Add learned if present
    if (summary.learned) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*💡 Learned:*\n${this.truncateText(summary.learned, 500)}`,
        },
      });
    }

    // Add next steps if present
    if (summary.nextSteps) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*📌 Next Steps:*\n${this.truncateText(summary.nextSteps, 500)}`,
        },
      });
    }

    // Add timestamp footer
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `_Generated by claude-mem at ${new Date().toLocaleString()}_`,
        },
      ],
    });

    return blocks;
  }

  /**
   * Send an observation to Slack
   */
  async sendObservation(observation: {
    id: number;
    project: string;
    type: string;
    title: string;
    narrative: string;
    files?: string[];
  }): Promise<string | null> {
    if (!this.webClient || !this.isEnabled()) {
      return null;
    }

    // Check if this type should be shared
    const shareTypes = this.getShareTypes();
    if (shareTypes.length > 0 && !shareTypes.includes(observation.type)) {
      return null;
    }

    try {
      const typeEmoji = this.getTypeEmoji(observation.type);
      const blocks = this.buildObservationBlocks(observation, typeEmoji);

      const result = await this.webClient.chat.postMessage({
        channel: this.settings.CLAUDE_MEM_SLACK_CHANNEL_ID,
        text: `${typeEmoji} ${observation.type}: ${observation.title}`,
        blocks,
        unfurl_links: false,
        unfurl_media: false,
      });

      const threadTs = result.ts || null;

      if (threadTs) {
        logger.success('SLACK', 'Sent observation', {
          observationId: observation.id,
          type: observation.type,
        });
      }

      return threadTs;
    } catch (error: any) {
      logger.error('SLACK', 'Failed to send observation', {
        observationId: observation.id,
      }, error);
      return null;
    }
  }

  /**
   * Build Slack Block Kit blocks for observation
   */
  private buildObservationBlocks(observation: {
    id: number;
    project: string;
    type: string;
    title: string;
    narrative: string;
    files?: string[];
  }, typeEmoji: string): any[] {
    const blocks: any[] = [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `${typeEmoji} ${observation.type.charAt(0).toUpperCase() + observation.type.slice(1)}`,
          emoji: true,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${observation.title}*`,
        },
        accessory: {
          type: 'button',
          text: {
            type: 'plain_text',
            text: `#${observation.id}`,
          },
          url: `http://localhost:37777/#observation-${observation.id}`,
        },
      },
      {
        type: 'section',
        fields: [
          {
            type: 'mrkdwn',
            text: `*Project:*\n${observation.project}`,
          },
        ],
      },
    ];

    // Add narrative
    if (observation.narrative) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: this.truncateText(observation.narrative, 1000),
        },
      });
    }

    // Add files if present
    if (observation.files && observation.files.length > 0) {
      blocks.push({
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `📁 Files: ${observation.files.slice(0, 5).join(', ')}${observation.files.length > 5 ? ` (+${observation.files.length - 5} more)` : ''}`,
          },
        ],
      });
    }

    return blocks;
  }

  /**
   * Get emoji for observation type
   */
  private getTypeEmoji(type: string): string {
    const emojis: Record<string, string> = {
      decision: '⚖️',
      bugfix: '🔴',
      feature: '🟣',
      refactor: '🔄',
      discovery: '🔵',
      change: '✅',
    };
    return emojis[type] || '📝';
  }

  /**
   * Truncate text to max length
   */
  private truncateText(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength - 3) + '...';
  }

  /**
   * Disconnect from Slack
   */
  async disconnect(): Promise<void> {
    if (this.socketClient) {
      await this.socketClient.disconnect();
      this.isConnected = false;
      logger.info('SLACK', 'Disconnected from Slack');
    }
  }
}
