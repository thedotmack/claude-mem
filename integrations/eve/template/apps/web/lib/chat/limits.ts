export const MAX_CHAT_MESSAGE_CHARS = 8000;

export function getChatMessageLength(message: string) {
  return Array.from(message).length;
}

export function getChatMessageLengthError(message: string) {
  if (getChatMessageLength(message.trim()) <= MAX_CHAT_MESSAGE_CHARS) {
    return null;
  }

  return `Messages must be ${MAX_CHAT_MESSAGE_CHARS.toLocaleString()} characters or fewer.`;
}

export function assertChatMessageLength(message: string) {
  const error = getChatMessageLengthError(message);

  if (error) {
    throw new Error(error);
  }
}
