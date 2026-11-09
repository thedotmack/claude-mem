const MARKDOWN_V2_RESERVED = /[_*\[\]()~`>#+\-=|{}.!\\]/g;
// Bounds a stalled connection so it cannot block the alerts queued behind it
// (TelegramNotifier sends one at a time) or hold the wrap-up sent-claim open
// forever. Same budget as NOTION_REQUEST_TIMEOUT_MS (NotionExporter.ts) for
// outbound integration calls; a healthy Telegram sendMessage answers in well
// under a second.
const TELEGRAM_REQUEST_TIMEOUT_MS = 15_000;

export function escapeMarkdownV2(value: string): string {
  return value.replace(MARKDOWN_V2_RESERVED, '\\$&');
}

export async function postTelegramMessage(
  botToken: string,
  chatId: string,
  text: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<void> {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'MarkdownV2',
    }),
    signal: AbortSignal.timeout(TELEGRAM_REQUEST_TIMEOUT_MS),
  });
  try {
    if (!response.ok) {
      const status = response.status;
      const statusText = response.statusText;
      throw new Error(`Telegram API responded ${status} ${statusText}`);
    }
  } finally {
    // Neither caller consumes the response payload. Release the connection on
    // success and failure rather than retaining an unread response body.
    await response.body?.cancel().catch(() => {});
  }
}
