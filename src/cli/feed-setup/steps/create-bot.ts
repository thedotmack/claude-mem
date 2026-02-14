/**
 * Step 1: Create Telegram Bot
 *
 * Shows BotFather instructions, collects bot token, validates via getMe.
 */

import * as p from '@clack/prompts';
import { TelegramClient } from '../../../services/feed/TelegramClient.js';
import { validateBotToken } from '../../../services/feed/FeedConfig.js';

export interface CreateBotResult {
  botToken: string;
  botUsername: string;
}

export async function createBotStep(presetToken?: string): Promise<CreateBotResult | symbol> {
  p.note(
    `To set up the feed, you need a Telegram bot.\n\n` +
    `1. Open Telegram and search for @BotFather\n` +
    `2. Send /newbot\n` +
    `3. Choose a name (e.g. "Claude-Mem Feed")\n` +
    `4. Choose a username (e.g. "claudemem_feed_bot")\n` +
    `5. Copy the bot token BotFather gives you`,
    'Create a Telegram Bot'
  );

  let botToken = presetToken || '';
  let botUsername = '';

  while (true) {
    if (!botToken) {
      const tokenInput = await p.text({
        message: 'Paste your bot token:',
        placeholder: '123456789:ABCdefGHIjklMNOpqrsTUVwxyz1234567890',
        validate: (value) => {
          if (!validateBotToken(value)) {
            return 'Invalid token format. Should look like: 123456789:ABCdefGHI...';
          }
        },
      });

      if (p.isCancel(tokenInput)) return tokenInput;
      botToken = (tokenInput as string).trim();
    }

    const s = p.spinner();
    s.start('Verifying bot token...');

    try {
      const client = new TelegramClient(botToken);
      const me = await client.getMe();
      botUsername = me.username;
      s.stop(`Bot verified: @${botUsername}`);
      break;
    } catch (err) {
      s.stop('Token verification failed');
      p.log.error(`Could not verify token: ${(err as Error).message}`);
      botToken = ''; // Reset to ask again
    }
  }

  return { botToken, botUsername };
}
