"use server";

import type { ClientSessionState, SessionStreamEvent } from "eve/client";
import {
  appendChatEvent,
  clearChatPendingMessage,
  createChat,
  deleteChatForUser,
  listChatsByUser,
  markChatPendingMessage,
  saveChatSnapshot,
  saveChatSessionState,
} from "@/lib/db/queries";
import { assertChatMessageLength } from "@/lib/chat/limits";
import { RateLimitError, enforceRateLimit } from "@/lib/rate-limit";
import { getServerViewer } from "@/lib/session";
import { getSetupStatus } from "@/lib/setup";

const SEND_LIMIT = 25;
const SEND_WINDOW_SECONDS = 60 * 60;

export async function createChatAction(input?: { readonly pendingUserMessage?: string }) {
  const viewer = await requireViewer();

  if (input?.pendingUserMessage) {
    assertChatMessageLength(input.pendingUserMessage);
  }

  await enforceRateLimit({
    key: viewer.id,
    limit: SEND_LIMIT,
    prefix: "chat:create",
    windowSeconds: SEND_WINDOW_SECONDS,
  });

  return createChat(viewer.id, {
    pendingUserMessage: input?.pendingUserMessage,
  });
}

export async function checkSendLimitAction(input?: { readonly message?: string }) {
  const viewer = await requireViewer();

  try {
    if (input?.message) {
      assertChatMessageLength(input.message);
    }

    await enforceRateLimit({
      key: viewer.id,
      limit: SEND_LIMIT,
      prefix: "chat:send",
      windowSeconds: SEND_WINDOW_SECONDS,
    });

    return { allowed: true as const };
  } catch (error) {
    if (error instanceof RateLimitError) {
      return {
        allowed: false as const,
        message: error.message,
        retryAfter: error.retryAfter,
      };
    }

    throw error;
  }
}

export async function saveChatSnapshotAction(input: {
  readonly chatId: string;
  readonly events: readonly SessionStreamEvent[];
  readonly session: ClientSessionState | undefined;
}) {
  const viewer = await requireViewer();

  await saveChatSnapshot({
    chatId: input.chatId,
    events: input.events,
    session: input.session,
    userId: viewer.id,
  });

  return { ok: true };
}

export async function markChatPendingMessageAction(input: {
  readonly chatId: string;
  readonly message: string;
}) {
  const viewer = await requireViewer();

  assertChatMessageLength(input.message);

  return markChatPendingMessage({
    chatId: input.chatId,
    message: input.message,
    userId: viewer.id,
  });
}

export async function clearChatPendingMessageAction(chatId: string) {
  const viewer = await requireViewer();

  await clearChatPendingMessage({
    chatId,
    userId: viewer.id,
  });

  return { ok: true };
}

export async function appendChatEventAction(input: {
  readonly chatId: string;
  readonly event: SessionStreamEvent;
  readonly eventIndex: number;
}) {
  const viewer = await requireViewer();

  await appendChatEvent({
    chatId: input.chatId,
    event: input.event,
    eventIndex: input.eventIndex,
    userId: viewer.id,
  });

  return { ok: true };
}

export async function saveChatSessionStateAction(input: {
  readonly chatId: string;
  readonly session: ClientSessionState;
}) {
  const viewer = await requireViewer();

  await saveChatSessionState({
    chatId: input.chatId,
    session: input.session,
    userId: viewer.id,
  });

  return { ok: true };
}

export async function deleteChatAction(chatId: string) {
  const viewer = await requireViewer();

  await deleteChatForUser(chatId, viewer.id);

  return listChatsByUser(viewer.id);
}

async function requireViewer() {
  const setupStatus = await getSetupStatus();

  if (setupStatus.storageMode !== "database") {
    throw new Error("Database persistence is not enabled.");
  }

  const viewer = await getServerViewer(setupStatus);

  if (!viewer) {
    throw new Error("Sign in to continue.");
  }

  return viewer;
}
