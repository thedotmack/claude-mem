/**
 * Step 5: Save Config
 *
 * Shows summary and saves feed configuration to settings.json.
 */

import * as p from '@clack/prompts';
import { saveFeedConfig } from '../../../services/feed/FeedConfig.js';

export async function saveConfigStep(
  botToken: string,
  botUsername: string,
  chatId: string,
  chatTitle: string,
  nonInteractive: boolean = false
): Promise<boolean | symbol> {
  // Mask the token for display
  const maskedToken = botToken.slice(0, 8) + '...' + botToken.slice(-4);

  p.note(
    `Bot: @${botUsername}\n` +
    `Token: ${maskedToken}\n` +
    `Group: ${chatTitle}\n` +
    `Chat ID: ${chatId}`,
    'Configuration Summary'
  );

  if (!nonInteractive) {
    const confirm = await p.confirm({
      message: 'Save this configuration?',
    });
    if (p.isCancel(confirm)) return confirm;
    if (!confirm) return false;
  }

  saveFeedConfig({
    enabled: true,
    channel: 'telegram',
    botToken,
    chatId,
  });

  p.log.success('Configuration saved to ~/.claude-mem/settings.json');
  return true;
}
