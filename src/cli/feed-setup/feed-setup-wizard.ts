/**
 * Feed Setup Wizard Orchestrator
 *
 * Guides users through the full Telegram feed setup in 6 steps:
 * 1. Create Telegram bot (BotFather)
 * 2. Create/select group
 * 3. Detect chat ID
 * 4. Send test message
 * 5. Save configuration
 * 6. Verify live feed
 *
 * Supports --non-interactive mode for CI/Docker with --bot-token and --chat-id flags.
 */

import * as p from '@clack/prompts';
import { loadFeedConfig, isFeedConfigured } from '../../services/feed/FeedConfig.js';
import { createBotStep } from './steps/create-bot.js';
import { createGroupStep } from './steps/create-group.js';
import { detectChatIdStep } from './steps/detect-chat-id.js';
import { testMessageStep } from './steps/test-message.js';
import { saveConfigStep } from './steps/save-config.js';
import { verifyFeedStep } from './steps/verify-feed.js';

export interface WizardOptions {
  nonInteractive?: boolean;
  botToken?: string;
  chatId?: string;
}

export async function runFeedSetupWizard(options: WizardOptions = {}): Promise<void> {
  const { nonInteractive = false, botToken: presetToken, chatId: presetChatId } = options;

  p.intro('\u{1F9E0} Claude-Mem Feed Setup');

  // Non-interactive mode requires both --bot-token and --chat-id
  if (nonInteractive && (!presetToken || !presetChatId)) {
    p.log.error('Non-interactive mode requires --bot-token=TOKEN and --chat-id=ID');
    p.outro('Setup failed');
    return;
  }

  // Pre-flight: check existing configuration
  const existing = loadFeedConfig();
  if (isFeedConfigured(existing) && !nonInteractive) {
    const maskedToken = existing.botToken.slice(0, 8) + '...' + existing.botToken.slice(-4);
    p.note(
      `Enabled: ${existing.enabled}\n` +
      `Token: ${maskedToken}\n` +
      `Chat ID: ${existing.chatId}`,
      'Feed is already configured'
    );

    const action = await p.select({
      message: 'What would you like to do?',
      options: [
        { value: 'reconfigure', label: 'Reconfigure' },
        { value: 'test', label: 'Send test message' },
        { value: 'exit', label: 'Exit' },
      ],
    });

    if (p.isCancel(action) || action === 'exit') {
      p.outro('Done');
      return;
    }

    if (action === 'test') {
      await testMessageStep(existing.botToken, existing.chatId, true);
      p.outro('Done');
      return;
    }
    // action === 'reconfigure' -> continue with wizard
  }

  // Step 1: Create bot
  const botResult = await createBotStep(presetToken);
  if (p.isCancel(botResult)) {
    p.outro('Setup cancelled');
    return;
  }
  const { botToken, botUsername } = botResult;

  // Step 2: Create group (skip in non-interactive mode)
  if (!nonInteractive) {
    const groupResult = await createGroupStep(botUsername);
    if (p.isCancel(groupResult)) {
      p.outro('Setup cancelled');
      return;
    }
  }

  // Step 3: Detect chat ID
  const chatResult = await detectChatIdStep(botToken, presetChatId);
  if (p.isCancel(chatResult)) {
    p.outro('Setup cancelled');
    return;
  }
  const { chatId, chatTitle } = chatResult;

  // Step 4: Test message
  const testResult = await testMessageStep(botToken, chatId, nonInteractive);
  if (p.isCancel(testResult)) {
    p.outro('Setup cancelled');
    return;
  }

  // Step 5: Save config
  const saveResult = await saveConfigStep(botToken, botUsername, chatId, chatTitle, nonInteractive);
  if (p.isCancel(saveResult) || !saveResult) {
    p.outro('Setup cancelled');
    return;
  }

  // Step 6: Verify live feed
  await verifyFeedStep(nonInteractive);

  p.outro('\u{1F980} Feed setup complete! Observations will stream to your Telegram group.');
}
