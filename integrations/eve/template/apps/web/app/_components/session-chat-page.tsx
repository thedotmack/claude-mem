"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  AgentChatSession,
  ComposerFooterControls,
  ErrorToast,
  type AgentChatController,
  type AgentChatControllerStatus,
} from "@/app/_components/agent-chat";
import {
  CHAT_ROUTE_SYNC_EVENT,
  type ChatRouteSyncDetail,
} from "@/app/_components/agent-chat-events";
import { useChatShell } from "@/app/_components/chat-shell-context";
import { ChatComposer } from "@/components/chat/composer";
import {
  clearPendingChatMessage,
  isProvisionalChatId,
  readPendingChatMessage,
  writePendingChatMessage,
} from "@/lib/chat/provisional-chat";
import { createClientChat, getClientChat } from "@/lib/chat/persistence-client";
import type { ActiveChat, SetupStatus } from "@/lib/chat/types";

const IDLE_CONTROLLER_STATUS: AgentChatControllerStatus = {
  isBusy: false,
  isDisabled: false,
  isEmpty: true,
};

export function SessionChatPage({
  chatId,
  children,
}: {
  readonly chatId: string;
  readonly children: ReactNode;
}) {
  const { setActiveChatId, setupStatus, touchChat, viewer } = useChatShell();
  const [activeChat, setActiveChat] = useState<ActiveChat | null>(null);
  const [draft, setDraft] = useState("");
  const [controllerReady, setControllerReady] = useState(false);
  const [controllerStatus, setControllerStatus] = useState(IDLE_CONTROLLER_STATUS);
  const [pendingUserMessage, setPendingUserMessage] = useState<string | null>(null);
  const [clientError, setClientError] = useState<string | null>(null);
  const [dismissedError, setDismissedError] = useState<string | null>(null);
  const controllerRef = useRef<AgentChatController | null>(null);
  const currentChatIdRef = useRef(chatId);
  const pendingConsumedRef = useRef(false);
  const provisionalCreateStartedRef = useRef(new Set<string>());
  const settledPendingMessagesRef = useRef(new Set<string>());
  const isProvisionalChat = isProvisionalChatId(chatId);
  const router = useRouter();
  const toastError = clientError && dismissedError !== clientError ? clientError : null;
  const isLoadingChat = !activeChat;

  useEffect(() => {
    currentChatIdRef.current = chatId;
  }, [chatId]);

  useEffect(() => {
    controllerRef.current = null;
    setControllerReady(false);
    setControllerStatus(IDLE_CONTROLLER_STATUS);
    setActiveChat(null);
    setDraft("");
    setPendingUserMessage(null);
    pendingConsumedRef.current = false;
    settledPendingMessagesRef.current = new Set();
  }, [chatId]);

  useEffect(() => {
    const restoredPendingMessage = readPendingChatMessage(chatId);

    if (restoredPendingMessage) {
      setPendingUserMessage((current) => current ?? restoredPendingMessage);
      setClientError(null);
    }
  }, [chatId]);

  useEffect(() => {
    if (!isProvisionalChat || !viewer || !setupStatus.appReady) {
      return;
    }

    const pendingMessage = readPendingChatMessage(chatId);

    if (!pendingMessage) {
      setClientError("Message could not be restored. Start a new chat.");
      return;
    }

    setPendingUserMessage((current) => current ?? pendingMessage);

    if (provisionalCreateStartedRef.current.has(chatId)) {
      return;
    }

    provisionalCreateStartedRef.current.add(chatId);
    setClientError(null);

    void (async () => {
      try {
        const created = await createClientChat(setupStatus.storageMode, {
          pendingUserMessage: pendingMessage,
        });

        if (currentChatIdRef.current !== chatId) {
          return;
        }

        writePendingChatMessage(created.id, pendingMessage);
        clearPendingChatMessage(chatId);
        touchChat(created);
        setActiveChatId(created.id);
        router.replace(`/chat/${created.id}`, { scroll: false });
      } catch (error) {
        if (currentChatIdRef.current !== chatId) {
          return;
        }

        clearPendingChatMessage(chatId);
        setPendingUserMessage(null);

        try {
          window.sessionStorage.setItem("eve-chat-draft", pendingMessage);
        } catch {}

        setClientError(error instanceof Error ? error.message : "Failed to start chat.");
        router.replace("/", { scroll: false });
      }
    })();
  }, [
    chatId,
    isProvisionalChat,
    router,
    setActiveChatId,
    setupStatus.appReady,
    setupStatus.storageMode,
    touchChat,
    viewer,
  ]);

  useEffect(() => {
    setActiveChatId(chatId);

    return () => {
      setActiveChatId(null);
    };
  }, [chatId, setActiveChatId]);

  useEffect(() => {
    const applyRouteSync = (detail: ChatRouteSyncDetail) => {
      if (detail.chatId !== chatId) {
        return;
      }
      setActiveChat((current) => {
        if (!detail.activeChat && current?.id === chatId) {
          return current;
        }

        return detail.activeChat;
      });
      setPendingUserMessage((current) => {
        if (detail.activeChat) {
          return getRestorablePendingUserMessage(
            detail.activeChat.pendingUserMessage,
            settledPendingMessagesRef.current,
          );
        }

        return current;
      });
    };
    const target = window as Window & {
      __eveChatRouteSync?: ChatRouteSyncDetail;
    };
    const handleRouteSync = (event: Event) => {
      applyRouteSync((event as CustomEvent<ChatRouteSyncDetail>).detail);
    };

    window.addEventListener(CHAT_ROUTE_SYNC_EVENT, handleRouteSync);
    if (target.__eveChatRouteSync) {
      applyRouteSync(target.__eveChatRouteSync);
    }

    return () => {
      window.removeEventListener(CHAT_ROUTE_SYNC_EVENT, handleRouteSync);
    };
  }, [chatId]);

  useEffect(() => {
    if (!viewer || !setupStatus.appReady || isProvisionalChat) {
      return;
    }

    const abortController = new AbortController();
    let cancelled = false;

    void (async () => {
      try {
        const chat = await getClientChat(setupStatus.storageMode, chatId);

        if (cancelled) {
          return;
        }

        if (!chat) {
          setClientError("Chat not found.");
          return;
        }

        setActiveChat(chat);
        const nextPendingUserMessage = getRestorablePendingUserMessage(
          chat.pendingUserMessage,
          settledPendingMessagesRef.current,
        );

        setPendingUserMessage(nextPendingUserMessage);

        if (!nextPendingUserMessage) {
          clearPendingChatMessage(chatId);
        }
        setClientError(null);
      } catch (error) {
        if (!cancelled && !abortController.signal.aborted) {
          setClientError(error instanceof Error ? error.message : "Failed to load chat history.");
        }
      }
    })();

    return () => {
      cancelled = true;
      abortController.abort();
    };
  }, [chatId, isProvisionalChat, setupStatus.appReady, setupStatus.storageMode, viewer]);

  useEffect(() => {
    if (!viewer) {
      return;
    }

    const restoredDraft = window.sessionStorage.getItem("eve-chat-draft");

    if (restoredDraft) {
      setDraft(restoredDraft);
      window.sessionStorage.removeItem("eve-chat-draft");
    }
  }, [viewer]);

  useEffect(() => {
    if (
      pendingConsumedRef.current ||
      isLoadingChat ||
      !controllerReady ||
      controllerStatus.isBusy ||
      controllerStatus.isDisabled
    ) {
      return;
    }

    if (!pendingUserMessage) {
      return;
    }

    const controller = controllerRef.current;

    if (!controller) {
      return;
    }

    pendingConsumedRef.current = true;

    void controller.sendMessage(pendingUserMessage, {
      clearDraft: () => setDraft(""),
      restoreDraft: (value) => {
        setPendingUserMessage(null);
        setDraft(value);
      },
    });
  }, [
    chatId,
    controllerReady,
    controllerStatus.isBusy,
    controllerStatus.isDisabled,
    isLoadingChat,
    pendingUserMessage,
  ]);

  useEffect(() => {
    setDismissedError(null);
  }, [clientError]);

  const handleControllerChange = useCallback(
    (controller: AgentChatController | null, status: AgentChatControllerStatus) => {
      controllerRef.current = controller;
      setControllerReady(Boolean(controller));
      setControllerStatus((current) =>
        current.isBusy === status.isBusy &&
        current.isDisabled === status.isDisabled &&
        current.isEmpty === status.isEmpty
          ? current
          : status,
      );
    },
    [],
  );

  const handleComposerSubmit = useCallback(
    async (text: string) => {
      if (isLoadingChat) {
        setClientError("Chat history is still loading.");
        return;
      }

      const controller = controllerRef.current;

      if (!controller) {
        setClientError("Chat is still getting ready.");
        return;
      }

      await controller.sendMessage(text, {
        clearDraft: () => setDraft(""),
        restoreDraft: setDraft,
      });
    },
    [isLoadingChat],
  );

  const handleComposerStop = useCallback(() => {
    controllerRef.current?.stop();
  }, []);

  const handlePendingUserMessageSettled = useCallback(
    (message?: string) => {
      clearPendingChatMessage(chatId);

      if (message) {
        settledPendingMessagesRef.current.add(message);
      }

      setPendingUserMessage((current) => (!message || current === message ? null : current));
    },
    [chatId],
  );

  const handleActiveChatUpdated = useCallback((nextActiveChat: ActiveChat) => {
    setActiveChat(nextActiveChat);
    setPendingUserMessage(
      getRestorablePendingUserMessage(
        nextActiveChat.pendingUserMessage,
        settledPendingMessagesRef.current,
      ),
    );
  }, []);

  const composerDisabled =
    !setupStatus.appReady ||
    isLoadingChat ||
    Boolean(pendingUserMessage) ||
    controllerStatus.isDisabled;
  const sessionInstanceKey = activeChat ? `${chatId}:loaded` : `${chatId}:loading`;
  const composerDisabledReason = getSessionComposerDisabledReason({
    controllerStatus,
    isLoadingChat,
    pendingUserMessage,
    setupStatus,
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {toastError ? (
        <ErrorToast message={toastError} onDismiss={() => setDismissedError(toastError)} />
      ) : null}

      <AgentChatSession
        activeChat={activeChat}
        chatId={chatId}
        key={sessionInstanceKey}
        onActiveChatUpdated={handleActiveChatUpdated}
        onPendingUserMessageSettled={handlePendingUserMessageSettled}
        onControllerChange={handleControllerChange}
        pendingUserMessage={pendingUserMessage}
      />

      <div className="shrink-0 pb-4 sm:pb-6">
        <div className="mx-auto w-full max-w-2xl px-4 sm:px-6">
          <ChatComposer
            disabled={composerDisabled}
            disabledReason={composerDisabledReason}
            footerStart={<ComposerFooterControls setupStatus={setupStatus} />}
            isBusy={controllerStatus.isBusy}
            onChange={setDraft}
            onStop={handleComposerStop}
            onSubmit={handleComposerSubmit}
            placeholder="Ask anything..."
            value={draft}
          />
        </div>
      </div>

      <div className="hidden" aria-hidden>
        {children}
      </div>
    </div>
  );
}

function getRestorablePendingUserMessage(
  pendingUserMessage: string | null | undefined,
  settledMessages: ReadonlySet<string>,
) {
  if (!pendingUserMessage || settledMessages.has(pendingUserMessage)) {
    return null;
  }

  return pendingUserMessage;
}

function getSessionComposerDisabledReason({
  controllerStatus,
  isLoadingChat,
  pendingUserMessage,
  setupStatus,
}: {
  readonly controllerStatus: AgentChatControllerStatus;
  readonly isLoadingChat: boolean;
  readonly pendingUserMessage: string | null;
  readonly setupStatus: SetupStatus;
}) {
  if (controllerStatus.disabledReason) {
    return controllerStatus.disabledReason;
  }

  if (pendingUserMessage) {
    return "Sending message.";
  }

  if (isLoadingChat) {
    return "Chat history is still loading.";
  }

  if (!setupStatus.authReady) {
    const missing = setupStatus.missing.length
      ? ` Missing: ${setupStatus.missing.join(", ")}.`
      : "";

    return `Finish auth setup before chatting.${missing}`;
  }

  if (controllerStatus.isDisabled) {
    return "Chat is unavailable.";
  }

  if (controllerStatus.isBusy) {
    return "eve is responding.";
  }

  return undefined;
}
