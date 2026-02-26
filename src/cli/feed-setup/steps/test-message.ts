/**
 * Step 4: Test Message
 *
 * Sends a test message to the configured group to verify connectivity.
 */

import * as p from '@clack/prompts';
import { TelegramClient } from '../../../services/feed/TelegramClient.js';

export async function testMessageStep(
  botToken: string,
  chatId: string,
  nonInteractive: boolean = false
): Promise<boolean | symbol> {
  const s = p.spinner();
  s.start('Sending test message...');

  try {
    const client = new TelegramClient(botToken);
    await client.sendMessage(
      chatId,
      '\u{1F9E0} Claude-Mem Feed connected! Session observations will appear here.'
    );
    s.stop('Test message sent!');
  } catch (err) {
    s.stop('Failed to send test message');
    p.log.error((err as Error).message);
    return false;
  }

  if (nonInteractive) return true;

  const confirmed = await p.confirm({
    message: 'Did you see the message in your Telegram group?',
  });

  return confirmed;
}
