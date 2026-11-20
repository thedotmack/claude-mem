"use client";

import { useEffect } from "react";
import { CHAT_ROUTE_SYNC_EVENT } from "@/app/_components/agent-chat-events";
import type { ActiveChat } from "@/lib/chat/types";

export function AgentChatRouteSync({
  activeChat,
  chatId,
}: {
  readonly activeChat: ActiveChat | null;
  readonly chatId: string | null;
}) {
  useEffect(() => {
    const detail = { activeChat, chatId };
    const target = window as Window & {
      __eveChatRouteSync?: typeof detail;
    };

    target.__eveChatRouteSync = detail;
    window.dispatchEvent(
      new CustomEvent(CHAT_ROUTE_SYNC_EVENT, {
        detail,
      }),
    );
  }, [activeChat, chatId]);

  return null;
}
