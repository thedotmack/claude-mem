/**
 * Step 3: Detect Chat ID
 *
 * Auto-detects group chat ID via getUpdates. Falls back to manual input.
 */

import * as p from '@clack/prompts';
import { TelegramClient, type TelegramChat } from '../../../services/feed/TelegramClient.js';

export interface DetectChatIdResult {
  chatId: string;
  chatTitle: string;
}

export async function detectChatIdStep(
  botToken: string,
  presetChatId?: string
): Promise<DetectChatIdResult | symbol> {
  if (presetChatId) {
    // Non-interactive: validate the provided chat ID
    const client = new TelegramClient(botToken);
    try {
      const chatInfo = await client.getChat(presetChatId);
      return { chatId: presetChatId, chatTitle: chatInfo.title };
    } catch {
      throw new Error(`Invalid chat ID: ${presetChatId}`);
    }
  }

  const s = p.spinner();
  s.start('Looking for groups with your bot...');

  const client = new TelegramClient(botToken);
  let chats: TelegramChat[] = [];

  try {
    chats = await client.getUpdates();
    // Filter to groups/supergroups
    chats = chats.filter(c => c.chatType === 'group' || c.chatType === 'supergroup');
  } catch (err) {
    s.stop('Could not fetch updates');
    p.log.warn(`getUpdates failed: ${(err as Error).message}`);
  }

  if (chats.length === 1) {
    s.stop(`Found group: ${chats[0].chatTitle}`);

    const confirm = await p.confirm({
      message: `Use "${chats[0].chatTitle}" (${chats[0].chatId})?`,
    });
    if (p.isCancel(confirm)) return confirm;

    if (confirm) {
      return { chatId: chats[0].chatId, chatTitle: chats[0].chatTitle };
    }
  } else if (chats.length > 1) {
    s.stop(`Found ${chats.length} groups`);

    const selected = await p.select({
      message: 'Which group should receive the feed?',
      options: chats.map(c => ({
        value: c.chatId,
        label: `${c.chatTitle} (${c.chatId})`,
      })),
    });
    if (p.isCancel(selected)) return selected;

    const chat = chats.find(c => c.chatId === selected)!;
    return { chatId: chat.chatId, chatTitle: chat.chatTitle };
  } else {
    s.stop('No groups found');
    p.log.info('Make sure you added the bot to a group and sent a message.');
  }

  // Manual fallback
  const manualId = await p.text({
    message: 'Enter the chat ID manually:',
    placeholder: '-1001234567890',
    validate: (value) => {
      if (!value.trim()) return 'Chat ID is required';
      if (!/^-?\d+$/.test(value.trim())) return 'Chat ID should be a number';
    },
  });
  if (p.isCancel(manualId)) return manualId;

  const chatId = (manualId as string).trim();

  // Validate via getChat
  const vs = p.spinner();
  vs.start('Validating chat ID...');
  try {
    const info = await client.getChat(chatId);
    vs.stop(`Validated: ${info.title} (${info.type})`);
    return { chatId, chatTitle: info.title };
  } catch (err) {
    vs.stop('Validation failed');
    throw new Error(`Invalid chat ID: ${(err as Error).message}`);
  }
}
