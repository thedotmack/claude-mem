const MARKDOWN_V2_RESERVED = /[_*\[\]()~`>#+\-=|{}.!\\]/g;
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
