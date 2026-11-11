"use client";

import type { ClientSessionState, SessionStreamEvent } from "eve/client";
import {
  appendChatEventAction,
  checkSendLimitAction,
  clearChatPendingMessageAction,
  createChatAction,
  deleteChatAction,
  markChatPendingMessageAction,
  saveChatSessionStateAction,
  saveChatSnapshotAction,
} from "@/app/actions/chat";
import {
  appendLocalChatEvent,
  clearLocalChatPendingMessage,
  createLocalChat,
  deleteLocalChat,
  getLocalChat,
  listLocalChats,
  markLocalChatPendingMessage,
  saveLocalChatSession,
  saveLocalChatSnapshot,
} from "./local-store";
import type { StorageMode } from "./types";

export function listClientChats(storageMode: StorageMode) {
  return storageMode === "browser" ? listLocalChats() : [];
}

export async function getClientChat(storageMode: StorageMode, chatId: string) {
  if (storageMode === "browser") {
    return getLocalChat(chatId);
  }

  const response = await fetch(`/api/chats/${encodeURIComponent(chatId)}`);

  if (!response.ok) {
    throw new Error(response.status === 404 ? "Chat not found." : "Failed to load chat history.");
  }

  const data = (await response.json()) as {
    readonly chat: ReturnType<typeof getLocalChat>;
  };

  return data.chat;
}

export async function createClientChat(
  storageMode: StorageMode,
  input?: { readonly pendingUserMessage?: string },
) {
  return storageMode === "browser"
    ? createLocalChat(input?.pendingUserMessage)
    : createChatAction(input);
}

export async function deleteClientChat(storageMode: StorageMode, chatId: string) {
  if (storageMode === "browser") {
    deleteLocalChat(chatId);
    return;
  }

  await deleteChatAction(chatId);
}

export async function checkClientSendLimit(
  storageMode: StorageMode,
  input?: { readonly message?: string },
) {
  return storageMode === "browser" ? ({ allowed: true } as const) : checkSendLimitAction(input);
}

export async function markClientChatPendingMessage(
  storageMode: StorageMode,
  input: { readonly chatId: string; readonly message: string },
) {
  return storageMode === "browser"
    ? markLocalChatPendingMessage(input.chatId, input.message)
    : markChatPendingMessageAction(input);
}

export async function clearClientChatPendingMessage(storageMode: StorageMode, chatId: string) {
  if (storageMode === "browser") {
    clearLocalChatPendingMessage(chatId);
    return;
  }

  await clearChatPendingMessageAction(chatId);
}

export async function appendClientChatEvent(
  storageMode: StorageMode,
  input: {
    readonly chatId: string;
    readonly event: SessionStreamEvent;
    readonly eventIndex: number;
  },
) {
  if (storageMode === "browser") {
    appendLocalChatEvent(input);
    return;
  }

  await appendChatEventAction(input);
}

export async function saveClientChatSession(
  storageMode: StorageMode,
  input: { readonly chatId: string; readonly session: ClientSessionState },
) {
  if (storageMode === "browser") {
    saveLocalChatSession(input.chatId, input.session);
    return;
  }

  await saveChatSessionStateAction(input);
}

export async function saveClientChatSnapshot(
  storageMode: StorageMode,
  input: {
    readonly chatId: string;
    readonly events: readonly SessionStreamEvent[];
    readonly session: ClientSessionState | undefined;
  },
) {
  if (storageMode === "browser") {
    saveLocalChatSnapshot(input);
    return;
  }

  await saveChatSnapshotAction(input);
}
