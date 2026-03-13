/**
 * Step 2: Create/Select Group
 *
 * Instructs user to create a Telegram group and add the bot.
 */

import * as p from '@clack/prompts';

export async function createGroupStep(botUsername: string): Promise<boolean | symbol> {
  p.note(
    `Now create a Telegram group for your feed:\n\n` +
    `1. Open Telegram and create a new group\n` +
    `2. Name it (e.g. "Claude-Mem Feed")\n` +
    `3. Add @${botUsername} to the group\n` +
    `4. Send any message in the group (so the bot can detect it)`,
    'Create a Telegram Group'
  );

  const done = await p.confirm({
    message: 'Done? (bot added to group and message sent)',
  });

  return done;
}
