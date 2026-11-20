import type { ClientSessionState, SessionStreamEvent } from "eve/client";

export type Viewer = {
  readonly email: string;
  readonly id: string;
  readonly image: string | null;
  readonly name: string;
};

export type AuthMode = "local-dev" | "password" | "unconfigured" | "vercel";
export type StorageMode = "browser" | "database";

export type ChatListItem = {
  readonly id: string;
  readonly title: string;
  readonly updatedAt: string;
};

export type ChatListPage = {
  readonly items: readonly ChatListItem[];
  readonly nextCursor: string | null;
};

export type ActiveChat = {
  readonly events: readonly SessionStreamEvent[];
  readonly id: string;
  readonly pendingUserMessage: string | null;
  readonly session: ClientSessionState | undefined;
  readonly title: string;
};

export type SetupStatus = {
  readonly appReady: boolean;
  readonly authMode: AuthMode;
  readonly authReady: boolean;
  readonly connectionsAvailable: boolean;
  readonly databaseConfigured: boolean;
  readonly databaseReady: boolean;
  readonly databaseSchemaReady: boolean;
  readonly missing: readonly string[];
  readonly rateLimitReady: boolean;
  readonly storageMode: StorageMode;
};
