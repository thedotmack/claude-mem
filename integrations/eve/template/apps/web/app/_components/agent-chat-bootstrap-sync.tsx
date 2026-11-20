"use client";

import { useEffect } from "react";
import { CHAT_BOOTSTRAP_SYNC_EVENT } from "@/app/_components/agent-chat-events";
import type { ChatListItem, SetupStatus, Viewer } from "@/lib/chat/types";

export function AgentChatBootstrapSync({
  chats,
  nextCursor,
  setupStatus,
  viewer,
}: {
  readonly chats: readonly ChatListItem[];
  readonly nextCursor: string | null;
  readonly setupStatus: SetupStatus;
  readonly viewer: Viewer | null;
}) {
  useEffect(() => {
    const detail = { chats, nextCursor, setupStatus, viewer };
    const target = window as Window & {
      __eveChatBootstrapSync?: typeof detail;
    };

    target.__eveChatBootstrapSync = detail;
    window.dispatchEvent(
      new CustomEvent(CHAT_BOOTSTRAP_SYNC_EVENT, {
        detail,
      }),
    );
  }, [chats, nextCursor, setupStatus, viewer]);

  return null;
}
