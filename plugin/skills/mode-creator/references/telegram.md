# Telegram notifications for a custom mode

Read this only after the user opts into alerts.

## How matching works

claude-mem reads these settings from its data-directory `settings.json`:

- `CLAUDE_MEM_TELEGRAM_ENABLED`
- `CLAUDE_MEM_TELEGRAM_BOT_TOKEN`
- `CLAUDE_MEM_TELEGRAM_CHAT_ID`
- `CLAUDE_MEM_TELEGRAM_TRIGGER_TYPES`
- `CLAUDE_MEM_TELEGRAM_TRIGGER_CONCEPTS`

An observation sends when its single type matches any configured trigger type **or** one of its concepts matches any configured trigger concept. No trigger list means no messages.

Messages contain the observation type, title, subtitle, project, and observation ID. They do not include the full narrative or facts, but titles and subtitles can still contain sensitive information. Make the privacy tradeoff explicit before configuration.

## Bot setup

1. Open Telegram's official [@BotFather](https://t.me/BotFather).
2. Send `/newbot`, choose a display name, then choose a unique username ending in `bot`.
3. BotFather returns an authentication token. Treat it like a password; anyone with it controls the bot.
4. Open the new bot, press **Start**, and send it a message. Bots cannot initiate a private conversation before the user contacts them.
5. Run `scripts/configure-telegram.mjs` from this skill. It collects the token through hidden terminal input, validates it with `getMe`, uses `getUpdates` to discover a recent chat when possible, sends a test with `sendMessage`, and stores the result with owner-only permissions.

Official references: [Telegram bots introduction](https://core.telegram.org/bots), [BotFather features](https://core.telegram.org/bots/features), and [Bot API methods](https://core.telegram.org/bots/api).

## Security rules

- Never request the token through an ordinary chat response or interactive question whose answer is reproduced in the transcript.
- Never put the token in a URL printed to the terminal, a shell command, an environment assignment shown in chat, or a command-line argument.
- Never print `settings.json` wholesale after configuration.
- It is safe to report whether a token is present, the bot username returned by `getMe`, and the selected chat ID.
- Keep settings and backups mode `0600`.
- If a token was exposed, tell the user to revoke it through BotFather and create a replacement before continuing.

## Troubleshooting

- `getMe failed: Unauthorized`: the token is wrong or revoked. Generate a new token in BotFather.
- No chats found: the user must press Start and send the bot a message, then retry.
- `getUpdates` says a webhook is active: automatic discovery cannot run while a webhook owns updates. Enter the numeric chat ID manually; do not delete a webhook without explicit permission.
- `sendMessage` says chat not found: verify the chat ID and ensure the bot was started or added to the group.
- Group alerts: add the bot to the group, send a message that the bot can receive, and use the negative group chat ID.
- Test succeeds but observations do not alert: confirm the generated observation's type/concepts exactly match the configured lowercase IDs and restart the worker after settings changes.
