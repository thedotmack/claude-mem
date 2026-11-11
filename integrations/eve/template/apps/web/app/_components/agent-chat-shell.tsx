"use client";

import { CheckIcon, MenuIcon, PanelLeftIcon, UploadIcon } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import {
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  CHAT_BOOTSTRAP_SYNC_EVENT,
  type ChatBootstrapSyncDetail,
} from "@/app/_components/agent-chat-events";
import {
  ChatShellProvider,
  useChatShell,
  type EnabledConnections,
} from "@/app/_components/chat-shell-context";
import { AuthDisplayLoggedOut } from "@/components/auth/auth-display";
import { SignInModal } from "@/components/auth/sign-in-modal";
import { ChatSidebar } from "@/components/chat/sidebar";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  parseSidebarOpen,
  serializeSidebarOpen,
  SIDEBAR_COOKIE_MAX_AGE,
  SIDEBAR_COOKIE_NAME,
} from "@/lib/chat/sidebar-state";
import { deleteClientChat, listClientChats } from "@/lib/chat/persistence-client";
import type { ChatListItem, SetupStatus, Viewer } from "@/lib/chat/types";
import { cn } from "@/lib/utils";

export function AgentChatShell({
  children,
  initialChats,
  initialNextCursor,
  setupStatus,
  viewer,
}: {
  readonly children: ReactNode;
  readonly initialChats: readonly ChatListItem[];
  readonly initialNextCursor: string | null;
  readonly setupStatus: SetupStatus;
  readonly viewer: Viewer | null;
}) {
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [desktopSidebarOpen, setDesktopSidebarOpen] = useState(true);
  const [history, setHistory] = useState<ChatListItem[]>([...initialChats]);
  const [nextCursor, setNextCursor] = useState(initialNextCursor);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [authDialogOpen, setAuthDialogOpen] = useState(false);
  const [draftBeforeSignIn, setDraftBeforeSignIn] = useState("");
  const [signInCallbackPath, setSignInCallbackPath] = useState("/");
  const [viewerState, setViewerState] = useState(viewer);
  const [setupStatusState, setSetupStatusState] = useState(setupStatus);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [enabledConnections, setEnabledConnections] = useState<EnabledConnections>({
    linear: true,
    notion: true,
    sentry: true,
  });
  const cursorRef = useRef(initialNextCursor);
  const activeChatIdRef = useRef(activeChatId);
  const setupReady = setupStatusState.appReady;
  const router = useRouter();

  useEffect(() => {
    activeChatIdRef.current = activeChatId;
  }, [activeChatId]);

  useEffect(() => {
    cursorRef.current = nextCursor;
  }, [nextCursor]);

  useLayoutEffect(() => {
    const saved = readSidebarCookie();

    if (saved !== null) {
      setDesktopSidebarOpen(saved);
      setSidebarDocumentHint(saved);
    }
  }, []);

  const requestSignIn = useCallback((draft?: string) => {
    setDraftBeforeSignIn(draft?.trim() ?? "");
    setSignInCallbackPath(window.location.pathname || "/");
    setAuthDialogOpen(true);
  }, []);

  const setDesktopSidebarOpenPersisted = useCallback((open: boolean) => {
    setDesktopSidebarOpen(open);
    setSidebarDocumentHint(open);
    document.cookie = `${SIDEBAR_COOKIE_NAME}=${serializeSidebarOpen(open)}; Path=/; Max-Age=${SIDEBAR_COOKIE_MAX_AGE}; SameSite=Lax`;
  }, []);

  const setConnectionEnabled = useCallback(
    (connection: keyof EnabledConnections, enabled: boolean) => {
      setEnabledConnections((current) => ({
        ...current,
        [connection]: enabled,
      }));
    },
    [],
  );

  const touchChat = useCallback((chat: ChatListItem) => {
    setHistory((items) => {
      const current = items.find((item) => item.id === chat.id);

      return [
        {
          id: chat.id,
          title: chat.title || current?.title || "New chat",
          updatedAt: chat.updatedAt,
        },
        ...items.filter((item) => item.id !== chat.id),
      ];
    });
  }, []);

  const updateChatTitle = useCallback((chatId: string, title: string) => {
    setHistory((items) => items.map((item) => (item.id === chatId ? { ...item, title } : item)));
  }, []);

  const removeChat = useCallback((chatId: string) => {
    setHistory((items) => items.filter((item) => item.id !== chatId));
  }, []);

  const startNewChat = useCallback(() => {
    activeChatIdRef.current = null;
    setActiveChatId(null);
    setMobileSidebarOpen(false);
    router.push("/", { scroll: false });
  }, [router]);

  const handleSidebarNavigate = useCallback((chatId?: string | null) => {
    setMobileSidebarOpen(false);

    if (chatId !== undefined) {
      activeChatIdRef.current = chatId;
      setActiveChatId(chatId);
    }
  }, []);

  const handleDeleteChat = useCallback(
    async (chatId: string) => {
      try {
        await deleteClientChat(setupStatusState.storageMode, chatId);
        removeChat(chatId);

        if (activeChatIdRef.current === chatId) {
          startNewChat();
        }
      } catch {
        // Deleting a sidebar item is best-effort. Active chat persistence
        // errors are shown by the chat surface where the user is working.
      }
    },
    [removeChat, setupStatusState.storageMode, startNewChat],
  );

  const loadMoreChats = useCallback(async () => {
    const cursor = cursorRef.current;

    if (!cursor || loadingMore || setupStatusState.storageMode !== "database") {
      return;
    }

    setLoadingMore(true);

    try {
      const response = await fetch(`/api/chats?cursor=${encodeURIComponent(cursor)}`);

      if (!response.ok) {
        return;
      }

      const data = (await response.json()) as {
        readonly chats?: readonly ChatListItem[];
        readonly nextCursor?: string | null;
      };
      const incoming = data.chats ?? [];

      setHistory((items) => {
        const existing = new Set(items.map((item) => item.id));
        const fresh = incoming.filter((item) => !existing.has(item.id));

        return [...items, ...fresh];
      });
      setNextCursor(data.nextCursor ?? null);
    } catch {
      // Ignore network hiccups; the observer/button can retry.
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, setupStatusState.storageMode]);

  const setBootstrapData = useCallback(
    ({
      chats,
      nextCursor: incomingNextCursor,
      setupStatus: incomingSetupStatus,
      viewer: incomingViewer,
    }: {
      readonly chats: readonly ChatListItem[];
      readonly nextCursor: string | null;
      readonly setupStatus: SetupStatus;
      readonly viewer: Viewer | null;
    }) => {
      setSetupStatusState(incomingSetupStatus);
      setViewerState(incomingViewer);
      const usesBrowserStorage = incomingSetupStatus.storageMode === "browser";
      const nextChats =
        incomingViewer && usesBrowserStorage
          ? listClientChats(incomingSetupStatus.storageMode)
          : chats;

      setHistory((items) => (incomingViewer ? mergeChatHistory(nextChats, items) : []));
      setNextCursor(usesBrowserStorage ? null : incomingNextCursor);
      setHistoryLoading(false);
      cursorRef.current = usesBrowserStorage ? null : incomingNextCursor;
    },
    [],
  );

  useEffect(() => {
    const target = window as Window & {
      __eveChatBootstrapSync?: ChatBootstrapSyncDetail;
    };
    const handleBootstrapSync = (event: Event) => {
      setBootstrapData((event as CustomEvent<ChatBootstrapSyncDetail>).detail);
    };

    window.addEventListener(CHAT_BOOTSTRAP_SYNC_EVENT, handleBootstrapSync);
    if (target.__eveChatBootstrapSync) {
      setBootstrapData(target.__eveChatBootstrapSync);
    }

    return () => {
      window.removeEventListener(CHAT_BOOTSTRAP_SYNC_EVENT, handleBootstrapSync);
    };
  }, [setBootstrapData]);

  const contextValue = useMemo(
    () => ({
      activeChatId,
      desktopSidebarOpen,
      enabledConnections,
      removeChat,
      requestSignIn,
      setActiveChatId,
      setConnectionEnabled,
      setupStatus: setupStatusState,
      touchChat,
      updateChatTitle,
      viewer: viewerState,
    }),
    [
      activeChatId,
      desktopSidebarOpen,
      enabledConnections,
      removeChat,
      requestSignIn,
      setConnectionEnabled,
      setupStatusState,
      touchChat,
      updateChatTitle,
      viewerState,
    ],
  );

  const sidebar = (
    <ChatSidebar
      activeChatId={activeChatId}
      chats={history}
      hasMoreChats={Boolean(nextCursor)}
      isLoadingChats={historyLoading}
      isLoadingMore={loadingMore}
      onDeleteChat={handleDeleteChat}
      onLoadMoreChats={loadMoreChats}
      onNavigate={handleSidebarNavigate}
      onNewChat={startNewChat}
      onSignIn={() => requestSignIn()}
      onToggleSidebar={() => setDesktopSidebarOpenPersisted(false)}
      setupStatus={setupStatusState}
      viewer={viewerState}
    />
  );
  const loggedOutAuthActions = historyLoading ? (
    <AuthDisplayLoggedOut>
      <AuthTopActions authMode={setupStatusState.authMode} onSignIn={() => requestSignIn()} />
    </AuthDisplayLoggedOut>
  ) : (
    <AuthTopActions authMode={setupStatusState.authMode} onSignIn={() => requestSignIn()} />
  );
  const topRightActions = (
    <div className="pointer-events-auto mt-1 flex min-w-0 items-center justify-end gap-1.5">
      <Suspense fallback={null}>
        <ChatRouteShareButton />
      </Suspense>
      {viewerState ? null : loggedOutAuthActions}
    </div>
  );

  return (
    <ChatShellProvider value={contextValue}>
      <SidebarCookieScript />
      <div className="flex h-dvh overflow-hidden bg-background text-foreground">
        <div
          data-desktop-sidebar
          className={cn(
            "hidden shrink-0 overflow-hidden transition-[width] duration-200 ease-in-out md:block",
            desktopSidebarOpen ? "w-64" : "w-0",
          )}
        >
          {sidebar}
        </div>

        <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
          <div className="pointer-events-none absolute inset-x-0 top-0 z-30 flex items-start justify-between px-2 py-2 md:px-3">
            <div className="pointer-events-auto flex items-center gap-1">
              <Button
                aria-label="Open sidebar"
                className="md:hidden"
                onClick={() => setMobileSidebarOpen(true)}
                size="icon-sm"
                type="button"
                variant="ghost"
              >
                <MenuIcon className="size-4" />
              </Button>
              {!desktopSidebarOpen ? (
                <Button
                  aria-label="Open sidebar"
                  className="hidden md:inline-flex"
                  onClick={() => setDesktopSidebarOpenPersisted(true)}
                  size="icon-sm"
                  type="button"
                  variant="ghost"
                >
                  <PanelLeftIcon className="size-4" />
                </Button>
              ) : null}
            </div>
            {topRightActions}
          </div>

          {children}
        </main>

        <div
          className={cn(
            "fixed inset-0 z-40 bg-black/50 transition-opacity md:hidden",
            mobileSidebarOpen ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0",
          )}
          onClick={() => setMobileSidebarOpen(false)}
        />
        {mobileSidebarOpen ? (
          <div className="fixed inset-y-0 left-0 z-50 md:hidden">
            <ChatSidebar
              activeChatId={activeChatId}
              chats={history}
              className="w-[84vw] max-w-80"
              hasMoreChats={Boolean(nextCursor)}
              isLoadingChats={historyLoading}
              isLoadingMore={loadingMore}
              onDeleteChat={handleDeleteChat}
              onLoadMoreChats={loadMoreChats}
              onNavigate={handleSidebarNavigate}
              onNewChat={startNewChat}
              onSignIn={() => requestSignIn()}
              setupStatus={setupStatusState}
              viewer={viewerState}
            />
          </div>
        ) : null}

        <SignInModal
          authMode={setupStatusState.authMode}
          callbackPath={signInCallbackPath}
          disabled={!setupReady}
          onBeforeSignIn={() => {
            if (draftBeforeSignIn) {
              window.sessionStorage.setItem("eve-chat-draft", draftBeforeSignIn);
            }
          }}
          onOpenChange={setAuthDialogOpen}
          open={authDialogOpen}
        />
      </div>
    </ChatShellProvider>
  );
}

function SidebarCookieScript() {
  const source = `try{var match=document.cookie.match(/(?:^|; )${SIDEBAR_COOKIE_NAME}=([^;]*)/);var value=match?decodeURIComponent(match[1]):"";if(value==="closed"){document.documentElement.dataset.eveChatSidebar="closed";}}catch{}`;

  return <script dangerouslySetInnerHTML={{ __html: source }} />;
}

function readSidebarCookie() {
  const match = document.cookie.match(new RegExp(`(?:^|; )${SIDEBAR_COOKIE_NAME}=([^;]*)`));

  if (!match?.[1]) {
    return null;
  }

  return parseSidebarOpen(match[1]);
}

function setSidebarDocumentHint(open: boolean) {
  if (open) {
    delete document.documentElement.dataset.eveChatSidebar;
  } else {
    document.documentElement.dataset.eveChatSidebar = "closed";
  }
}

function ChatRouteShareButton() {
  const pathname = usePathname();
  const { setupStatus } = useChatShell();

  if (!pathname.startsWith("/chat/") || setupStatus.storageMode === "browser") {
    return null;
  }

  return <ShareChatButton />;
}

function ShareChatButton() {
  const [copied, setCopied] = useState(false);
  const copyResetTimerRef = useRef<number | null>(null);

  const clearCopyResetTimer = useCallback(() => {
    if (copyResetTimerRef.current === null) {
      return;
    }

    window.clearTimeout(copyResetTimerRef.current);
    copyResetTimerRef.current = null;
  }, []);

  const handleCopyLink = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      clearCopyResetTimer();
      setCopied(true);
      copyResetTimerRef.current = window.setTimeout(() => {
        copyResetTimerRef.current = null;
        setCopied(false);
      }, 1600);
    } catch {
      setCopied(false);
    }
  }, [clearCopyResetTimer]);

  useEffect(() => clearCopyResetTimer, [clearCopyResetTimer]);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          aria-label={copied ? "Copied chat link" : "Copy chat link"}
          className="text-muted-foreground hover:text-foreground"
          onClick={handleCopyLink}
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          {copied ? <CheckIcon className="size-4" /> : <UploadIcon className="size-4" />}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{copied ? "Copied" : "Copy link"}</TooltipContent>
    </Tooltip>
  );
}

function AuthTopActions({
  authMode,
  onSignIn,
}: {
  readonly authMode: SetupStatus["authMode"];
  readonly onSignIn: () => void;
}) {
  const usesPassword = authMode === "password";

  return (
    <div className="flex max-w-[calc(100vw-4rem)] items-center gap-1.5">
      <Button
        className="h-8 rounded-md border border-border bg-background/70 px-3 text-sm font-medium text-foreground shadow-sm hover:bg-muted/60"
        onClick={onSignIn}
        type="button"
        variant="outline"
      >
        {usesPassword ? "Sign in" : "Log In"}
      </Button>
      {usesPassword ? null : (
        <Button
          className="h-8 rounded-md bg-foreground px-3 text-sm font-medium text-background hover:bg-foreground/90"
          onClick={onSignIn}
          type="button"
        >
          Sign Up
        </Button>
      )}
    </div>
  );
}

function mergeChatHistory(incoming: readonly ChatListItem[], current: readonly ChatListItem[]) {
  const incomingById = new Map(incoming.map((item) => [item.id, item]));
  const currentIds = new Set(current.map((item) => item.id));
  const freshIncoming = incoming.filter((item) => !currentIds.has(item.id));

  return [...freshIncoming, ...current.map((item) => incomingById.get(item.id) ?? item)];
}
