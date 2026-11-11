"use client";

import type { ClientSessionState, SessionStoreSnapshot, SessionStreamEvent } from "eve/client";
import {
  activeTurn,
  activity,
  openInteractions,
  session as sessionState,
  type Interaction,
} from "eve/events";
import type { EveMessage } from "eve/react";
import { useEveAgent } from "eve/react";
import {
  AlertCircleIcon,
  ChevronDownIcon,
  ExternalLinkIcon,
  LockIcon,
  PlugIcon,
  XIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useChatShell, type EnabledConnections } from "@/app/_components/chat-shell-context";
import {
  ChatConversation,
  ChatConversationContent,
  ChatScrollButton,
} from "@/components/chat/conversation";
import { IntegrationsMenu } from "@/components/chat/integrations-menu";
import { AgentMessage } from "@/components/chat/message";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { getChatMessageLengthError } from "@/lib/chat/limits";
import {
  appendClientChatEvent,
  checkClientSendLimit,
  clearClientChatPendingMessage,
  createClientChat,
  markClientChatPendingMessage,
  saveClientChatSession,
  saveClientChatSnapshot,
} from "@/lib/chat/persistence-client";
import type { ActiveChat, SetupStatus } from "@/lib/chat/types";

export type DraftHandlers = {
  readonly clearDraft: () => void;
  readonly restoreDraft: (value: string) => void;
};

export type AgentChatController = {
  readonly reset: () => void;
  readonly sendMessage: (text: string, draftHandlers: DraftHandlers) => Promise<void>;
  readonly stop: () => void;
};

export type AgentChatControllerStatus = {
  readonly disabledReason?: string;
  readonly isBusy: boolean;
  readonly isDisabled: boolean;
  readonly isEmpty: boolean;
};

const IDLE_CONTROLLER_STATUS: AgentChatControllerStatus = {
  isBusy: false,
  isDisabled: false,
  isEmpty: true,
};

const THINKING_EXIT_DURATION_MS = 180;

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

export function AgentChatSession({
  activeChat,
  chatId,
  emptyComposer,
  onActiveChatUpdated,
  onPendingUserMessageSettled,
  onControllerChange,
  pendingUserMessage,
}: {
  readonly activeChat: ActiveChat | null;
  readonly chatId?: string | null;
  readonly emptyComposer?: ReactNode;
  readonly onActiveChatUpdated?: (activeChat: ActiveChat) => void;
  readonly onPendingUserMessageSettled?: (message?: string) => void;
  readonly onControllerChange: (
    controller: AgentChatController | null,
    status: AgentChatControllerStatus,
  ) => void;
  readonly pendingUserMessage?: string | null;
}) {
  const {
    activeChatId: shellActiveChatId,
    enabledConnections,
    requestSignIn,
    setActiveChatId: setShellActiveChatId,
    setupStatus,
    touchChat,
    viewer,
  } = useChatShell();
  const [activeChatId, setActiveChatId] = useState(activeChat?.id ?? chatId ?? null);
  const [clientError, setClientError] = useState<string | null>(null);
  const [dismissedError, setDismissedError] = useState<string | null>(null);
  const {
    clearMessage: clearLocalPendingUserMessage,
    message: localPendingUserMessage,
    messageRef: localPendingUserMessageRef,
    setMessage: setLocalPendingUserMessage,
  } = usePendingUserMessage();
  const [skippingAuthorizationKey, setSkippingAuthorizationKey] = useState<string | null>(null);
  const activeChatIdRef = useRef(activeChat?.id ?? chatId ?? null);
  const eventIndexRef = useRef(activeChat?.events.length ?? 0);
  const eventIndexChatIdRef = useRef(activeChat?.id ?? chatId ?? null);
  const currentTitleRef = useRef(activeChat?.title ?? "New chat");
  const resumeStartedRef = useRef(activeChat?.session === undefined);
  const persistenceRef = useRef(Promise.resolve());
  const isSetupReady = setupStatus.appReady;
  const storageMode = setupStatus.storageMode;
  const router = useRouter();

  // Events, cursors, snapshots and pending messages must reach storage in stream order.
  const persist = useCallback((write: () => Promise<void>) => {
    const pending = persistenceRef.current.then(write);
    persistenceRef.current = pending.catch(() => {});
    return pending;
  }, []);

  const persistSnapshot = useCallback(
    async (snapshot: SessionStoreSnapshot) => {
      const chatId = activeChatIdRef.current;

      if (!viewer || !chatId) return;

      const { events, session } = snapshot;
      try {
        await persist(() => saveClientChatSnapshot(storageMode, { chatId, events, session }));
        if (activeChatIdRef.current !== chatId) return;
        touchChat({
          id: chatId,
          title: currentTitleRef.current,
          updatedAt: new Date().toISOString(),
        });
        onActiveChatUpdated?.({
          events,
          id: chatId,
          pendingUserMessage: null,
          session,
          title: currentTitleRef.current,
        });
        onPendingUserMessageSettled?.();
      } catch (error) {
        setClientError(error instanceof Error ? error.message : "Failed to save chat.");
      }
    },
    [onActiveChatUpdated, onPendingUserMessageSettled, persist, touchChat, storageMode, viewer],
  );

  const persistStreamEvent = useCallback(
    (event: SessionStreamEvent) => {
      const chatId = activeChatIdRef.current;

      if (!viewer || !chatId) {
        return;
      }

      const eventIndex = eventIndexRef.current;
      eventIndexRef.current += 1;

      void persist(() =>
        appendClientChatEvent(storageMode, {
          chatId,
          event,
          eventIndex,
        }),
      ).catch((error) => {
        setClientError(error instanceof Error ? error.message : "Failed to save stream progress.");
      });
    },
    [persist, storageMode, viewer],
  );

  const persistSessionState = useCallback(
    async (session: ClientSessionState) => {
      const chatId = activeChatIdRef.current;

      if (!viewer || !chatId || !session.sessionId) {
        return;
      }

      try {
        await persist(() =>
          saveClientChatSession(storageMode, {
            chatId,
            session,
          }),
        );
      } catch (error) {
        setClientError(error instanceof Error ? error.message : "Failed to save session state.");
      }
    },
    [persist, storageMode, viewer],
  );

  const agent = useEveAgent({
    initialEvents: activeChat?.events ?? [],
    initialSession: activeChat?.session,
    onEvent: persistStreamEvent,
    onSessionChange(session) {
      if (session) void persistSessionState(session);
    },
  });

  const displayMessages = agent.messages;
  const isResuming = agent.status === "resuming";
  const currentActivity = activity(agent.view);
  const displayChatId = chatId ?? activeChatId ?? "new";
  const hasLocalPendingUserMessage = Boolean(localPendingUserMessage);
  const pendingAuthorizations = openInteractions(agent.view, { kind: "sign-in" }).map(
    toPendingAuthorization,
  );
  const isWaitingForAuthorization = pendingAuthorizations.length > 0;

  const latestSnapshotRef = useRef<SessionStoreSnapshot>(agent);
  latestSnapshotRef.current = agent;
  // Save phase boundaries, not each progress or optimistic-only update. Commands resolve on
  // acceptance; a pause or completed catch-up is observed through shared state.
  useEffect(() => {
    const snapshot = latestSnapshotRef.current;
    if (
      !resumeStartedRef.current ||
      !snapshot.session ||
      sessionState(snapshot.view).status === "new" ||
      snapshot.status === "resuming"
    )
      return;
    if (
      activity(snapshot.view).kind !== "waiting-on-interaction" &&
      snapshot.status !== "idle" &&
      snapshot.error === undefined
    )
      return;
    void persistSnapshot(snapshot);
  }, [agent.status, currentActivity.kind, persistSnapshot]);
  const isBusy =
    isResuming ||
    hasLocalPendingUserMessage ||
    (currentActivity.kind !== "waiting-on-interaction" && agent.status === "busy");
  const isTurnBlocked = isBusy;
  const pendingMessage = pendingUserMessage
    ? createPendingUserMessage(displayChatId, pendingUserMessage)
    : null;
  const localPendingMessage = localPendingUserMessage
    ? createPendingUserMessage(displayChatId, localPendingUserMessage, "local-pending-user-message")
    : null;
  const disabledReason = isWaitingForAuthorization
    ? getConnectionAuthorizationDisabledReason(pendingAuthorizations)
    : undefined;
  const visibleMessages = appendPendingUserMessages(displayMessages, [
    pendingMessage,
    localPendingMessage,
  ]);
  const isEmpty = visibleMessages.length === 0 && !isTurnBlocked && !isWaitingForAuthorization;
  const isChatRoute = Boolean(shellActiveChatId || chatId);
  const showThinking =
    !isWaitingForAuthorization &&
    currentActivity.kind !== "waiting-on-interaction" &&
    (Boolean(pendingMessage || localPendingMessage) || isTurnBlocked);
  const thinkingPresence = useThinkingPresence(showThinking);
  const displayError = clientError ?? agent.error?.message ?? null;
  const toastError = displayError && dismissedError !== displayError ? displayError : null;

  const resetSession = useCallback(() => {
    agent.newSession();
    setActiveChatId(null);
    activeChatIdRef.current = null;
    eventIndexRef.current = 0;
    eventIndexChatIdRef.current = null;
    currentTitleRef.current = "New chat";
    resumeStartedRef.current = true;
    clearLocalPendingUserMessage();
    setClientError(null);
  }, [agent, clearLocalPendingUserMessage]);

  const prepareSend = useCallback(
    async (firstMessage: string) => {
      const limit = await checkClientSendLimit(storageMode, { message: firstMessage });

      if (!limit.allowed) {
        setClientError(`${limit.message} Retry in ${limit.retryAfter}s.`);
        return false;
      }

      if (!activeChatIdRef.current) {
        const created = await createClientChat(storageMode, {
          pendingUserMessage: firstMessage,
        });

        touchChat(created);
        setActiveChatId(created.id);
        setShellActiveChatId(created.id);
        activeChatIdRef.current = created.id;
        eventIndexChatIdRef.current = created.id;
        eventIndexRef.current = 0;
        currentTitleRef.current = created.title;
        router.replace(`/chat/${created.id}`, { scroll: false });
      }

      return true;
    },
    [router, setShellActiveChatId, storageMode, touchChat],
  );

  const sendMessage = useCallback(
    async (text: string, draftHandlers: DraftHandlers) => {
      const message = text.trim();

      if (!message || isTurnBlocked || localPendingUserMessageRef.current) {
        return;
      }

      const lengthError = getChatMessageLengthError(message);

      if (lengthError) {
        setClientError(lengthError);
        return;
      }

      if (isWaitingForAuthorization) {
        draftHandlers.restoreDraft(message);
        setClientError(disabledReason ?? "Connect the requested service before continuing.");
        return;
      }

      const showLocalPendingMessage = () => {
        setLocalPendingUserMessage(message);
        draftHandlers.clearDraft();
      };
      const restoreAfterFailedSend = (errorMessage?: string) => {
        clearLocalPendingUserMessage();
        draftHandlers.restoreDraft(message);

        if (errorMessage) {
          setClientError(errorMessage);
        }
      };
      let ready = false;

      setClientError(null);

      if (!isSetupReady) {
        setClientError("Finish setup before chatting.");
        return;
      }

      if (!viewer) {
        requestSignIn(message);
        return;
      }

      showLocalPendingMessage();
      onPendingUserMessageSettled?.(message);

      try {
        ready = await prepareSend(message);
      } catch (error) {
        restoreAfterFailedSend(error instanceof Error ? error.message : "Failed to prepare chat.");
        return;
      }

      if (!ready) {
        const chatId = activeChatIdRef.current;

        if (chatId) {
          void persist(() => clearClientChatPendingMessage(storageMode, chatId)).catch(() => {});
        }
        restoreAfterFailedSend();
        return;
      }

      const chatId = activeChatIdRef.current;

      if (!chatId) {
        restoreAfterFailedSend("Chat is still getting ready.");
        return;
      }

      try {
        await persist(async () => {
          const updated = await markClientChatPendingMessage(storageMode, { chatId, message });
          touchChat(updated);
        });
      } catch (error) {
        restoreAfterFailedSend(
          error instanceof Error ? error.message : "Failed to save pending message.",
        );
        return;
      }

      try {
        await agent.send(message, {
          turnPolicy: activeTurn(agent.view) !== undefined ? "steer" : undefined,
          clientContext: createConnectionClientContext(
            enabledConnections,
            setupStatus.connectionsAvailable,
          ),
        });
      } catch (error) {
        if (isAbortError(error)) {
          return;
        }

        void persist(() => clearClientChatPendingMessage(storageMode, chatId)).catch(() => {});
        restoreAfterFailedSend(error instanceof Error ? error.message : "Failed to send message.");
      }
    },
    [
      agent,
      clearLocalPendingUserMessage,
      disabledReason,
      enabledConnections,
      isSetupReady,
      isTurnBlocked,
      isWaitingForAuthorization,
      prepareSend,
      requestSignIn,
      setLocalPendingUserMessage,
      setupStatus.connectionsAvailable,
      persist,
      storageMode,
      onPendingUserMessageSettled,
      touchChat,
      viewer,
    ],
  );

  const handleAnswers = useCallback(
    async (
      responses: readonly {
        readonly optionId?: string;
        readonly interactionId: string;
        readonly text?: string;
      }[],
    ) => {
      if (isResuming) {
        return;
      }

      if (!viewer) {
        requestSignIn();
        return;
      }

      if (!activeChatIdRef.current) {
        setClientError("Start a chat before responding.");
        return;
      }

      const limit = await checkClientSendLimit(storageMode);

      if (!limit.allowed) {
        setClientError(`${limit.message} Retry in ${limit.retryAfter}s.`);
        return;
      }

      try {
        await agent.respond(responses);
      } catch (error) {
        setClientError(error instanceof Error ? error.message : "Failed to send response.");
      }
    },
    [agent, isResuming, requestSignIn, storageMode, viewer],
  );

  const handleSkipAuthorization = useCallback(
    async (authorization: PendingConnectionAuthorization) => {
      const chatId = activeChatIdRef.current;

      if (!viewer) {
        requestSignIn();
        return;
      }

      if (!chatId) {
        setClientError("Start a chat before skipping authorization.");
        return;
      }

      setSkippingAuthorizationKey(authorization.key);
      setClientError(null);
      try {
        await agent.cancel();
      } catch (error) {
        setClientError(error instanceof Error ? error.message : "Failed to skip authorization.");
      } finally {
        setSkippingAuthorizationKey(null);
      }
    },
    [agent.cancel, requestSignIn, viewer],
  );

  useEffect(() => {
    activeChatIdRef.current = activeChatId;
  }, [activeChatId]);

  useEffect(() => {
    const nextChatId = activeChat?.id ?? chatId ?? null;
    const nextTitle = activeChat?.title ?? "New chat";
    const nextEventIndex = activeChat?.events.length ?? 0;

    setActiveChatId(nextChatId);
    activeChatIdRef.current = nextChatId;
    if (eventIndexChatIdRef.current !== nextChatId) {
      eventIndexChatIdRef.current = nextChatId;
      eventIndexRef.current = nextEventIndex;
      clearLocalPendingUserMessage();
    }
    currentTitleRef.current = nextTitle;
  }, [
    activeChat?.events.length,
    activeChat?.id,
    activeChat?.title,
    chatId,
    clearLocalPendingUserMessage,
  ]);

  useEffect(() => {
    if (
      !viewer ||
      !activeChat?.session?.sessionId ||
      resumeStartedRef.current ||
      agent.status !== "idle"
    ) {
      return;
    }

    resumeStartedRef.current = true;
    void agent.resume().catch((error) => {
      setClientError(error instanceof Error ? error.message : "Failed to resume stream.");
    });
  }, [activeChat?.session?.sessionId, agent.resume, agent.status, viewer]);

  useEffect(() => {
    setDismissedError(null);
  }, [displayError]);

  useEffect(() => {
    if (localPendingUserMessage && hasLatestUserMessage(displayMessages, localPendingUserMessage)) {
      clearLocalPendingUserMessage();
    }
  }, [clearLocalPendingUserMessage, displayMessages, localPendingUserMessage]);

  useEffect(() => {
    onControllerChange(
      {
        reset: resetSession,
        sendMessage,
        stop: () => void agent.cancel(),
      },
      {
        disabledReason,
        isBusy,
        isDisabled: !isSetupReady || isWaitingForAuthorization || isResuming,
        isEmpty,
      },
    );
  }, [
    agent.cancel,
    disabledReason,
    isBusy,
    isResuming,
    isEmpty,
    isSetupReady,
    isWaitingForAuthorization,
    onControllerChange,
    resetSession,
    sendMessage,
  ]);

  useEffect(() => {
    return () => {
      onControllerChange(null, IDLE_CONTROLLER_STATUS);
    };
  }, [onControllerChange]);

  return (
    <>
      {toastError ? (
        <ErrorToast message={toastError} onDismiss={() => setDismissedError(toastError)} />
      ) : null}

      {isEmpty && !activeChatId && !isChatRoute && emptyComposer ? (
        <EmptyChatBody composer={emptyComposer} />
      ) : (
        <>
          {isChatRoute ? <SessionHeader /> : null}
          {isEmpty ? (
            <BlankChatBody />
          ) : (
            <ChatConversation>
              <ChatConversationContent>
                {visibleMessages.map((message) => (
                  <AgentMessage
                    canRespond={
                      !isResuming && !isWaitingForAuthorization && Boolean(viewer) && isSetupReady
                    }
                    key={message.id}
                    message={message}
                    onAnswers={handleAnswers}
                  />
                ))}
                {pendingAuthorizations.map((authorization) => (
                  <ConnectionAuthorizationPrompt
                    authorization={authorization}
                    isSkipping={skippingAuthorizationKey === authorization.key}
                    key={authorization.key}
                    onSkip={handleSkipAuthorization}
                  />
                ))}
                {thinkingPresence.shouldRender ? (
                  <ThinkingMessage isVisible={thinkingPresence.isVisible} />
                ) : null}
              </ChatConversationContent>
              <ChatScrollButton />
            </ChatConversation>
          )}
        </>
      )}
    </>
  );
}

type PendingConnectionAuthorization = {
  readonly description: string;
  readonly displayName: string;
  /** The sign-in's interaction id. */
  readonly key: string;
  readonly url?: string;
};

function getConnectionAuthorizationDisabledReason(
  authorizations: readonly PendingConnectionAuthorization[],
) {
  const displayName = authorizations[0]?.displayName ?? "the requested service";

  return `Connect ${displayName} to continue this turn, or skip it.`;
}

function toPendingAuthorization(interaction: Interaction): PendingConnectionAuthorization {
  const { request } = interaction;
  const challenge = request.signIn;
  const name = challenge?.name ?? request.title ?? "service";
  const displayName = challenge?.displayName ?? name;

  return {
    description:
      challenge?.instructions ?? request.prompt ?? `Connect ${displayName} to let eve continue.`,
    displayName,
    key: interaction.interactionId,
    url: challenge?.url ?? request.link?.url,
  };
}

function ConnectionAuthorizationPrompt({
  authorization,
  isSkipping,
  onSkip,
}: {
  readonly authorization: PendingConnectionAuthorization;
  readonly isSkipping: boolean;
  readonly onSkip: (authorization: PendingConnectionAuthorization) => Promise<void>;
}) {
  return (
    <article aria-live="polite" className="flex w-full justify-start px-3">
      <div className="w-full max-w-md rounded-lg border border-border/70 bg-muted/20 p-3 text-sm shadow-sm">
        <div className="flex gap-3">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-background text-muted-foreground">
            <PlugIcon className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="font-medium text-foreground">Connect {authorization.displayName}</p>
            <p className="mt-1 text-muted-foreground">{authorization.description}</p>
            <div className="mt-2.5 flex items-center gap-2">
              {authorization.url ? (
                <Button asChild size="xs" type="button">
                  <a href={authorization.url} rel="noreferrer" target="_blank">
                    Connect
                    <ExternalLinkIcon className="size-3" />
                  </a>
                </Button>
              ) : null}
              <Button
                disabled={isSkipping}
                onClick={() => {
                  void onSkip(authorization);
                }}
                size="xs"
                type="button"
                variant="outline"
              >
                {isSkipping ? "Skipping..." : "Skip"}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </article>
  );
}

function appendPendingUserMessages(
  messages: readonly EveMessage[],
  pendingMessages: readonly (EveMessage | null)[],
) {
  let nextMessages = messages;

  for (const pendingMessage of pendingMessages) {
    const pendingText = pendingMessage ? getMessageText(pendingMessage) : null;

    if (!pendingMessage || !pendingText || hasLatestUserMessage(nextMessages, pendingText)) {
      continue;
    }

    nextMessages = [...nextMessages, pendingMessage];
  }

  return nextMessages;
}

function createPendingUserMessage(
  chatId: string,
  text: string,
  idSuffix = "pending-user-message",
): EveMessage {
  return {
    id: `${chatId}:${idSuffix}`,
    metadata: {
      optimistic: true,
      status: "submitted",
    },
    parts: [
      {
        state: "done",
        text,
        type: "text",
      },
    ],
    role: "user",
  };
}

function usePendingUserMessage() {
  const [message, setMessageState] = useState<string | null>(null);
  const messageRef = useRef<string | null>(null);

  const setMessage = useCallback((nextMessage: string | null) => {
    messageRef.current = nextMessage;
    setMessageState(nextMessage);
  }, []);

  const clearMessage = useCallback(() => {
    setMessage(null);
  }, [setMessage]);

  return { clearMessage, message, messageRef, setMessage };
}

const CONNECTION_LABELS = {
  linear: "Linear",
  notion: "Notion",
  sentry: "Sentry",
} satisfies Record<keyof EnabledConnections, string>;

function createConnectionClientContext(
  enabledConnections: EnabledConnections,
  connectionsAvailable: boolean,
) {
  if (!connectionsAvailable) {
    return "No external connections are configured. Do not search or call connection tools.";
  }

  const entries = Object.entries(CONNECTION_LABELS) as [keyof EnabledConnections, string][];
  const enabled = entries
    .filter(([connection]) => enabledConnections[connection])
    .map(([, label]) => label);
  const disabled = entries
    .filter(([connection]) => !enabledConnections[connection])
    .map(([, label]) => label);

  if (enabled.length > 0) {
    const disabledContext =
      disabled.length > 0
        ? ` Do not use disabled connections unless the user enables them first: ${disabled.join(", ")}.`
        : "";

    return `The user has enabled these external connections for this turn: ${enabled.join(", ")}. Use an enabled connection when it is relevant to the user's request.${disabledContext}`;
  }

  return "The user has disabled all external connections for this turn. Do not search or call connection tools unless the user enables a connection first.";
}

function useThinkingPresence(active: boolean) {
  const [shouldRender, setShouldRender] = useState(active);
  const [isVisible, setIsVisible] = useState(active);

  useEffect(() => {
    if (active) {
      setShouldRender(true);

      const frame = window.requestAnimationFrame(() => {
        setIsVisible(true);
      });

      return () => {
        window.cancelAnimationFrame(frame);
      };
    }

    setIsVisible(false);

    const timeout = window.setTimeout(() => {
      setShouldRender(false);
    }, THINKING_EXIT_DURATION_MS);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [active]);

  return { isVisible, shouldRender };
}

function ThinkingMessage({ isVisible }: { readonly isVisible: boolean }) {
  return (
    <article
      aria-live={isVisible ? "polite" : "off"}
      className={[
        "flex w-full justify-start overflow-hidden transition-[opacity,transform,max-height] duration-200 ease-out",
        isVisible ? "max-h-8 translate-y-0 opacity-100" : "max-h-0 -translate-y-1 opacity-0",
      ].join(" ")}
      role="status"
    >
      <div className="px-3 text-[15px] font-medium leading-6 text-muted-foreground">
        <span className="shimmer-text">Thinking...</span>
      </div>
    </article>
  );
}

function SessionHeader() {
  return <div className="h-12 shrink-0" />;
}

function BlankChatBody() {
  return <div className="min-h-0 flex-1" />;
}

export function EmptyChatBody({ composer }: { readonly composer?: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col pt-14 md:pt-8">
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <div className="w-full max-w-2xl space-y-8 sm:space-y-10 md:space-y-12">
          <h1 className="flex justify-center">
            <img
              alt="eve"
              className="size-16 select-none invert sm:size-20 md:size-24 dark:invert-0"
              draggable={false}
              src="/eve.svg"
            />
          </h1>
          {composer}
        </div>
      </div>
    </div>
  );
}

export function ErrorToast({
  message,
  onDismiss,
}: {
  readonly message: string;
  readonly onDismiss: () => void;
}) {
  return (
    <div
      aria-live="assertive"
      className="fixed top-3 right-3 z-50 flex w-[calc(100vw-1.5rem)] max-w-sm items-start gap-3 rounded-md border border-destructive/30 bg-background/95 p-3 text-sm shadow-lg backdrop-blur sm:top-4 sm:right-4"
      role="alert"
    >
      <AlertCircleIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">Request failed</p>
        <p className="mt-0.5 text-muted-foreground">{message}</p>
      </div>
      <Button
        aria-label="Dismiss error"
        className="-mt-1 -mr-1 text-muted-foreground hover:text-foreground"
        onClick={onDismiss}
        size="icon-xs"
        type="button"
        variant="ghost"
      >
        <XIcon className="size-3.5" />
      </Button>
    </div>
  );
}

export function ComposerFooterControls({ setupStatus }: { readonly setupStatus: SetupStatus }) {
  const { enabledConnections, setConnectionEnabled } = useChatShell();

  return (
    <div className="flex min-w-0 max-w-full items-center gap-1.5 overflow-hidden">
      <ComposerHint setupStatus={setupStatus} />
      {setupStatus.connectionsAvailable ? (
        <IntegrationsMenu
          enabledConnections={enabledConnections}
          onConnectionEnabledChange={setConnectionEnabled}
          setupStatus={setupStatus}
        />
      ) : null}
    </div>
  );
}

function ComposerHint({ setupStatus }: { readonly setupStatus: SetupStatus }) {
  if (!setupStatus.appReady) {
    const reason = getSetupRequiredReason(setupStatus);

    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className="inline-flex h-8 min-w-0 max-w-full items-center gap-1 rounded-md px-2 text-[15px] text-muted-foreground/50"
            tabIndex={0}
          >
            <LockIcon className="size-3.5 shrink-0" />
            <span className="truncate">Setup required</span>
            <ChevronDownIcon className="size-3.5 shrink-0" />
          </span>
        </TooltipTrigger>
        <TooltipContent side="top">{reason}</TooltipContent>
      </Tooltip>
    );
  }

  return null;
}

function getSetupRequiredReason(setupStatus: SetupStatus) {
  return setupStatus.missing.length
    ? `Finish setup. Missing: ${setupStatus.missing.join(", ")}.`
    : "Finish setup before chatting.";
}

function hasLatestUserMessage(messages: readonly EveMessage[], text: string) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];

    if (message?.role !== "user") {
      continue;
    }

    return getMessageText(message) === text.trim();
  }

  return false;
}

function getMessageText(message: EveMessage) {
  const text = message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();

  return text || null;
}
