/**
 * NotificationManager - Orchestrates notifications and session continuation
 *
 * Coordinates between:
 * - SlackService (send/receive messages)
 * - SessionStore (track waiting sessions)
 * - ClaudeCodeLauncher (continue sessions)
 */

import { SlackService, SlackNotification, SlackResponse } from './SlackService.js';
import { ClaudeCodeLauncher } from '../cli/ClaudeCodeLauncher.js';
import { SessionStore } from '../sqlite/SessionStore.js';
import { logger } from '../../utils/logger.js';

export class NotificationManager {
  private slackService: SlackService;
  private claudeLauncher: ClaudeCodeLauncher;
  private sessionStore: SessionStore;
  private expiryCheckInterval: NodeJS.Timeout | null = null;

  constructor(sessionStore: SessionStore) {
    this.sessionStore = sessionStore;
    this.slackService = new SlackService();
    this.claudeLauncher = new ClaudeCodeLauncher();
  }

  /**
   * Initialize the notification system
   */
  async initialize(): Promise<void> {
    if (!this.slackService.isEnabled()) {
      logger.info('NOTIFICATIONS', 'Slack notifications are disabled');
      return;
    }

    // Initialize Slack service
    await this.slackService.initialize();

    // Set up response handler
    this.slackService.setResponseHandler(this.handleSlackResponse.bind(this));

    // Start expiry check interval (every 5 minutes)
    this.startExpiryCheck();

    logger.success('NOTIFICATIONS', 'NotificationManager initialized');
  }

  /**
   * Check if notifications are enabled
   */
  isEnabled(): boolean {
    return this.slackService.isEnabled();
  }

  /**
   * Notify that Claude is waiting for user input
   */
  async notifyWaitingForInput(
    claudeSessionId: string,
    project: string,
    cwd: string,
    question: string | null,
    fullMessage: string,
    transcriptPath: string | null
  ): Promise<number | null> {
    if (!this.slackService.isEnabled() || !this.slackService.shouldNotifyOnQuestions()) {
      return null;
    }

    try {
      // Create waiting session record
      const expiryHours = this.slackService.getSessionExpiryHours();
      const waitingSessionId = this.sessionStore.createWaitingSession(
        claudeSessionId,
        project,
        cwd,
        question,
        fullMessage,
        transcriptPath,
        expiryHours
      );

      // Send Slack notification
      const notification: SlackNotification = {
        project,
        sessionId: claudeSessionId,
        question: question || 'Claude is waiting for your response',
        fullMessage,
        waitingSessionId,
      };

      const threadTs = await this.slackService.sendWaitingNotification(notification);

      if (threadTs) {
        // Update waiting session with Slack thread info
        this.sessionStore.updateWaitingSessionSlackThread(
          waitingSessionId,
          threadTs,
          this.slackService.getChannelId()
        );

        logger.success('NOTIFICATIONS', 'Created waiting session with Slack notification', {
          waitingSessionId,
          threadTs,
          project,
        });
      }

      return waitingSessionId;
    } catch (error: any) {
      logger.error('NOTIFICATIONS', 'Failed to notify waiting for input', {
        claudeSessionId,
        project,
      }, error);
      return null;
    }
  }

  /**
   * Handle incoming Slack response
   */
  private async handleSlackResponse(response: SlackResponse): Promise<void> {
    logger.info('NOTIFICATIONS', 'Processing Slack response', {
      threadTs: response.threadTs,
      textLength: response.text.length,
    });

    // Find waiting session by Slack thread
    const waitingSession = this.sessionStore.getWaitingSessionBySlackThread(response.threadTs);

    if (!waitingSession) {
      // Check if this thread was already responded to (for better UX)
      const respondedSession = this.sessionStore.getRespondedSessionBySlackThread(response.threadTs);

      if (respondedSession) {
        // Already responded - send friendly message instead of error
        logger.info('NOTIFICATIONS', 'Thread already responded to', {
          threadTs: response.threadTs,
          respondedAt: respondedSession.responded_at,
          responseSource: respondedSession.response_source,
        });
        await this.slackService.sendInfoMessage(
          response.channelId,
          response.threadTs,
          `This question was already answered${respondedSession.response_source === 'local' ? ' from Claude Code' : ''}. The session has continued.`
        );
      } else {
        // Session expired or doesn't exist
        logger.warn('NOTIFICATIONS', 'No waiting session found for thread', {
          threadTs: response.threadTs,
        });
        await this.slackService.sendErrorMessage(
          response.channelId,
          response.threadTs,
          'This session has expired or is no longer available.'
        );
      }
      return;
    }

    // Check interaction mode - if local-only, don't process Slack responses
    const interactionMode = this.getInteractionMode();
    if (interactionMode === 'local-only') {
      logger.info('NOTIFICATIONS', 'Ignoring Slack response - interaction mode is local-only');
      await this.slackService.sendInfoMessage(
        response.channelId,
        response.threadTs,
        'Slack responses are currently disabled. Please respond in Claude Code or VS Code.'
      );
      return;
    }

    // Handle special responses
    const responseText = this.normalizeResponse(response.text);

    try {
      // Mark session as responded (from Slack)
      this.sessionStore.markWaitingSessionResponded(waitingSession.id, responseText, 'slack');

      // Send confirmation
      await this.slackService.sendResponseConfirmation(
        response.channelId,
        response.threadTs,
        responseText
      );

      // Continue the Claude Code session
      logger.info('NOTIFICATIONS', 'Continuing Claude Code session', {
        sessionId: waitingSession.claude_session_id,
        project: waitingSession.project,
        cwd: waitingSession.cwd,
      });

      await this.claudeLauncher.continueSession(
        waitingSession.claude_session_id,
        responseText,
        waitingSession.cwd
      );

      logger.success('NOTIFICATIONS', 'Successfully continued session', {
        waitingSessionId: waitingSession.id,
        sessionId: waitingSession.claude_session_id,
      });
    } catch (error: any) {
      logger.error('NOTIFICATIONS', 'Failed to continue session', {
        waitingSessionId: waitingSession.id,
      }, error);

      await this.slackService.sendErrorMessage(
        response.channelId,
        response.threadTs,
        `Failed to continue session: ${error.message}`
      );
    }
  }

  /**
   * Get the current interaction mode from settings
   */
  private getInteractionMode(): 'auto' | 'slack-only' | 'local-only' {
    // This would ideally be loaded from settings, but for now use default
    // TODO: Load from SettingsDefaultsManager when worker has access to settings
    return 'auto';
  }

  /**
   * Notify Slack thread that session was responded from local (Claude Code / VS Code)
   */
  async notifyRespondedFromLocal(
    channelId: string,
    threadTs: string,
    source: 'local' | 'api',
    response: string
  ): Promise<void> {
    if (!this.slackService.isEnabled()) return;

    await this.slackService.sendSessionUpdateMessage(
      channelId,
      threadTs,
      source,
      response
    );
  }

  /**
   * Continue a Claude Code session with a response
   * Exposed for use by SessionRoutes when handling local responses
   */
  async continueSession(
    claudeSessionId: string,
    response: string,
    cwd: string
  ): Promise<void> {
    await this.claudeLauncher.continueSession(claudeSessionId, response, cwd);
  }

  /**
   * Share a session summary to Slack
   */
  async shareSessionSummary(summary: {
    project: string;
    sessionId: string;
    request: string | null;
    completed: string | null;
    learned: string | null;
    nextSteps: string | null;
  }): Promise<string | null> {
    if (!this.slackService.isEnabled()) {
      logger.debug('NOTIFICATIONS', 'Slack not enabled, skipping summary share');
      return null;
    }

    return this.slackService.sendSessionSummary(summary);
  }

  /**
   * Share an observation to Slack
   */
  async shareObservation(observation: {
    id: number;
    project: string;
    type: string;
    title: string;
    narrative: string;
    files?: string[];
  }): Promise<string | null> {
    if (!this.slackService.isEnabled()) {
      logger.debug('NOTIFICATIONS', 'Slack not enabled, skipping observation share');
      return null;
    }

    return this.slackService.sendObservation(observation);
  }

  /**
   * Check if summary sharing is enabled
   */
  shouldShareSummaries(): boolean {
    return this.slackService.isEnabled() && this.slackService.shouldShareSummaries();
  }

  /**
   * Get observation types configured for auto-sharing
   */
  getShareTypes(): string[] {
    return this.slackService.getShareTypes();
  }

  /**
   * Normalize response text (handle special cases)
   */
  private normalizeResponse(text: string): string {
    const trimmed = text.trim();

    // Handle common affirmative shortcuts
    const lowerText = trimmed.toLowerCase();
    if (lowerText === 'y' || lowerText === 'yes' || lowerText === 'ok' || lowerText === 'continue') {
      return 'yes';
    }

    // Handle common negative shortcuts
    if (lowerText === 'n' || lowerText === 'no' || lowerText === 'cancel' || lowerText === 'stop') {
      return 'no';
    }

    return trimmed;
  }

  /**
   * Start periodic check for expired sessions
   */
  private startExpiryCheck(): void {
    // Check every 5 minutes
    this.expiryCheckInterval = setInterval(() => {
      const expired = this.sessionStore.expireOldWaitingSessions();
      if (expired > 0) {
        logger.info('NOTIFICATIONS', 'Expired waiting sessions', { count: expired });
      }
    }, 5 * 60 * 1000);
  }

  /**
   * Cancel a waiting session
   */
  cancelWaitingSession(waitingSessionId: number): void {
    this.sessionStore.markWaitingSessionCancelled(waitingSessionId);
    logger.info('NOTIFICATIONS', 'Cancelled waiting session', { waitingSessionId });
  }

  /**
   * Get all pending waiting sessions
   */
  getPendingWaitingSessions() {
    return this.sessionStore.getPendingWaitingSessions();
  }

  /**
   * Shutdown the notification system
   */
  async shutdown(): Promise<void> {
    if (this.expiryCheckInterval) {
      clearInterval(this.expiryCheckInterval);
      this.expiryCheckInterval = null;
    }

    await this.slackService.disconnect();
    logger.info('NOTIFICATIONS', 'NotificationManager shutdown');
  }
}
