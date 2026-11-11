import type { ActiveChat, ChatListItem, SetupStatus, Viewer } from "@/lib/chat/types";

export const CHAT_BOOTSTRAP_SYNC_EVENT = "eve-chat:bootstrap-sync";
export const CHAT_ROUTE_SYNC_EVENT = "eve-chat:route-sync";

export type ChatBootstrapSyncDetail = {
  readonly chats: readonly ChatListItem[];
  readonly nextCursor: string | null;
  readonly setupStatus: SetupStatus;
  readonly viewer: Viewer | null;
};

export type ChatRouteSyncDetail = {
  readonly activeChat: ActiveChat | null;
  readonly chatId: string | null;
};
