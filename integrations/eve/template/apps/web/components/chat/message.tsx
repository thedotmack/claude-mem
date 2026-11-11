"use client";

import type { EveToolPart, EveMessage, EveMessagePart } from "eve/react";
import { ChevronDownIcon, ChevronRightIcon, CheckIcon, Loader2Icon, XIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Markdown } from "@/components/chat/markdown";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const STREAM_TEXT_TICK_MS = 60;
const STREAM_TEXT_CACHE_LIMIT = 40;
const streamingTextCache = new Map<string, string>();

export type AgentAnswer = {
  readonly optionId?: string;
  readonly interactionId: string;
  readonly text?: string;
};

export function AgentMessage({
  canRespond,
  message,
  onAnswers,
}: {
  readonly canRespond: boolean;
  readonly message: EveMessage;
  readonly onAnswers: (responses: readonly AgentAnswer[]) => void | Promise<void>;
}) {
  const isUser = message.role === "user";

  return (
    <article
      className={cn(
        "group flex w-full min-w-0",
        isUser ? "justify-end" : "justify-start",
        message.metadata?.optimistic ? "opacity-90" : undefined,
      )}
    >
      <div
        className={cn(
          "min-w-0",
          isUser
            ? "max-w-[85%] rounded-[18px] border border-border/40 bg-muted/70 px-3 py-1.5 text-[15px] leading-6 text-foreground shadow-sm"
            : "w-full max-w-none text-sm leading-relaxed text-foreground",
        )}
      >
        <AgentMessageParts
          canRespond={canRespond}
          isUser={isUser}
          messageId={message.id}
          onAnswers={onAnswers}
          parts={message.parts}
        />
      </div>
    </article>
  );
}

function AgentMessageParts({
  canRespond,
  isUser,
  messageId,
  onAnswers,
  parts,
}: {
  readonly canRespond: boolean;
  readonly isUser: boolean;
  readonly messageId: string;
  readonly onAnswers: (responses: readonly AgentAnswer[]) => void | Promise<void>;
  readonly parts: readonly EveMessagePart[];
}) {
  const elements: ReactNode[] = [];
  let pendingTools: EveToolPart[] = [];

  const flushTools = () => {
    if (pendingTools.length === 0) {
      return;
    }

    const partsForGroup = pendingTools;

    elements.push(
      <ToolGroup
        canRespond={canRespond}
        key={`tools:${partsForGroup.map((part) => part.callId).join(":")}`}
        onAnswers={onAnswers}
        parts={partsForGroup}
      />,
    );
    pendingTools = [];
  };

  parts.forEach((part, index) => {
    if (part.type === "tool") {
      pendingTools.push(part);
      return;
    }

    flushTools();
    const key = partKey(part, index);

    elements.push(
      <AgentMessagePart isUser={isUser} key={key} part={part} streamKey={`${messageId}:${key}`} />,
    );
  });

  flushTools();

  return elements;
}

function AgentMessagePart({
  isUser,
  part,
  streamKey,
}: {
  readonly isUser: boolean;
  readonly part: EveMessagePart;
  readonly streamKey: string;
}) {
  switch (part.type) {
    case "text":
      return isUser ? (
        <UserTextPart text={part.text} />
      ) : (
        <AssistantTextPart
          showCaret={part.state === "streaming"}
          streamKey={streamKey}
          text={part.text}
        />
      );
    case "reasoning":
      return <ReasoningPart isStreaming={part.state === "streaming"} text={part.text} />;
    case "tool":
      return null;
  }
}

function UserTextPart({ text }: { readonly text: string }) {
  return <div className="whitespace-pre-wrap break-words">{text}</div>;
}

function AssistantTextPart({
  showCaret,
  streamKey,
  text,
}: {
  readonly showCaret: boolean;
  readonly streamKey: string;
  readonly text: string;
}) {
  const smoothedText = useStreamingText(text, showCaret, streamKey);
  const isRevealActive = smoothedText.length > 0 && (showCaret || smoothedText !== text);
  const showVisibleCaret = showCaret && smoothedText.length > 0;

  return (
    <Markdown
      animated={isRevealActive ? { duration: 0, stagger: 0 } : undefined}
      caret={showVisibleCaret ? "block" : undefined}
      isAnimating={isRevealActive}
    >
      {smoothedText}
    </Markdown>
  );
}

function useStreamingText(text: string, isStreaming: boolean, streamKey: string) {
  const [visibleText, setVisibleText] = useState(() =>
    getInitialStreamingText(text, isStreaming, streamKey),
  );
  const visibleTextRef = useRef(visibleText);

  useEffect(() => {
    visibleTextRef.current = visibleText;
  }, [visibleText]);

  useEffect(() => {
    const current = visibleTextRef.current;

    if (!isStreaming && (current === text || !text.startsWith(current))) {
      if (current !== text) {
        visibleTextRef.current = text;
        rememberStreamingText(streamKey, text);
        setVisibleText(text);
      }

      return;
    }

    const catchUp = !isStreaming;
    let interval: number | undefined;

    const advance = () => {
      const next = nextStreamingText(visibleTextRef.current, text, catchUp);

      if (next !== visibleTextRef.current) {
        visibleTextRef.current = next;
        rememberStreamingText(streamKey, next);
        setVisibleText(next);
      }

      if (catchUp && next === text && interval !== undefined) {
        window.clearInterval(interval);
        interval = undefined;
      }
    };

    advance();

    if (catchUp && visibleTextRef.current === text) {
      return;
    }

    interval = window.setInterval(advance, STREAM_TEXT_TICK_MS);

    return () => {
      if (interval !== undefined) {
        window.clearInterval(interval);
      }
    };
  }, [isStreaming, streamKey, text]);

  useEffect(() => {
    if (!isStreaming && visibleText === text) {
      streamingTextCache.delete(streamKey);
    }
  }, [isStreaming, streamKey, text, visibleText]);

  return visibleText;
}

function getInitialStreamingText(text: string, isStreaming: boolean, streamKey: string) {
  const cachedText = streamingTextCache.get(streamKey);

  if (cachedText && text.startsWith(cachedText)) {
    return cachedText;
  }

  return isStreaming ? "" : text;
}

function rememberStreamingText(streamKey: string, text: string) {
  if (!text) {
    return;
  }

  streamingTextCache.delete(streamKey);
  streamingTextCache.set(streamKey, text);

  if (streamingTextCache.size <= STREAM_TEXT_CACHE_LIMIT) {
    return;
  }

  const oldestKey = streamingTextCache.keys().next().value;

  if (oldestKey) {
    streamingTextCache.delete(oldestKey);
  }
}

function nextStreamingText(current: string, target: string, catchUp = false) {
  if (current === target) {
    return current;
  }

  if (!target.startsWith(current)) {
    return target;
  }

  const remaining = target.length - current.length;
  const step = catchUp
    ? remaining > 160
      ? 18
      : remaining > 80
        ? 12
        : remaining > 32
          ? 7
          : remaining > 12
            ? 4
            : 2
    : remaining > 160
      ? 6
      : remaining > 80
        ? 5
        : remaining > 32
          ? 3
          : remaining > 12
            ? 2
            : 1;

  return target.slice(0, current.length + Math.min(remaining, step));
}

function ReasoningPart({
  isStreaming,
  text,
}: {
  readonly isStreaming: boolean;
  readonly text: string;
}) {
  const [open, setOpen] = useState(isStreaming);

  useEffect(() => {
    if (isStreaming) {
      setOpen(true);
    }
  }, [isStreaming]);

  return (
    <Collapsible className="my-3 w-full" onOpenChange={setOpen} open={open}>
      <CollapsibleTrigger className="flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground">
        <span className={isStreaming ? "shimmer-text" : undefined}>
          {isStreaming ? "Thinking..." : "Reasoning"}
        </span>
        <ChevronDownIcon className={cn("size-4 transition-transform", open ? "rotate-180" : "")} />
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-3 border-l border-border pl-4 text-muted-foreground">
        <Markdown>{text}</Markdown>
      </CollapsibleContent>
    </Collapsible>
  );
}

function ToolGroup({
  canRespond,
  onAnswers,
  parts,
}: {
  readonly canRespond: boolean;
  readonly onAnswers: (responses: readonly AgentAnswer[]) => void | Promise<void>;
  readonly parts: readonly EveToolPart[];
}) {
  const shouldOpen = parts.some(needsAnswer);
  const [open, setOpen] = useState(shouldOpen);
  const status = getToolGroupStatus(parts);
  const label = summarizeToolGroup(parts);
  const canExpand = parts.length > 1 ? parts.some(hasToolDetails) : hasToolDetails(parts[0]!);

  useEffect(() => {
    if (shouldOpen) {
      setOpen(true);
    }
  }, [shouldOpen]);

  return (
    <Collapsible
      className="my-2 px-3"
      onOpenChange={canExpand ? setOpen : undefined}
      open={canExpand ? open : false}
    >
      <CollapsibleTrigger
        className={cn(
          "group flex max-w-full items-center gap-2 py-0.5 text-left text-sm leading-6 text-muted-foreground transition-colors",
          canExpand ? "cursor-pointer hover:text-foreground" : "cursor-default",
        )}
        disabled={!canExpand}
      >
        <ToolStatusIcon status={status} />
        <span className="truncate">{label}</span>
        <span className="sr-only">{toolStatusLabel(status)}</span>
        {canExpand ? (
          <ChevronRightIcon
            className={cn(
              "size-3 shrink-0 self-center transition-all",
              open ? "rotate-90 opacity-100" : "opacity-0 group-hover:opacity-100",
            )}
          />
        ) : null}
      </CollapsibleTrigger>
      {canExpand ? (
        <CollapsibleContent className="ml-2 border-l border-border/40 pl-3 pt-0.5 pb-1">
          {parts.length === 1 ? (
            <ToolDetails canRespond={canRespond} onAnswers={onAnswers} part={parts[0]!} />
          ) : (
            parts.map((part) => (
              <ToolCallItem
                canRespond={canRespond}
                key={part.callId}
                onAnswers={onAnswers}
                part={part}
              />
            ))
          )}
        </CollapsibleContent>
      ) : null}
    </Collapsible>
  );
}

function ToolCallItem({
  canRespond,
  onAnswers,
  part,
}: {
  readonly canRespond: boolean;
  readonly onAnswers: (responses: readonly AgentAnswer[]) => void | Promise<void>;
  readonly part: EveToolPart;
}) {
  const shouldOpen = needsAnswer(part);
  const [open, setOpen] = useState(shouldOpen);
  const status = getToolStatus(part);
  const canExpand = hasToolDetails(part);

  useEffect(() => {
    if (shouldOpen) {
      setOpen(true);
    }
  }, [shouldOpen]);

  const button = (
    <button
      className={cn(
        "flex w-full items-center gap-2 py-0.5 text-left text-sm leading-6 text-muted-foreground transition-colors",
        canExpand ? "cursor-pointer hover:text-foreground" : "cursor-default",
      )}
      type="button"
    >
      <ToolStatusIcon status={status} />
      <ToolNameLabel part={part} />
      <span className="truncate text-foreground/80">{part.label}</span>
      {canExpand ? (
        <ChevronRightIcon
          className={cn(
            "ml-auto size-3 shrink-0 self-center transition-transform",
            open ? "rotate-90" : "",
          )}
        />
      ) : null}
    </button>
  );

  if (!canExpand) {
    return <div className="py-0.5">{button}</div>;
  }

  return (
    <Collapsible className="py-0.5" onOpenChange={setOpen} open={open}>
      <CollapsibleTrigger asChild>{button}</CollapsibleTrigger>
      <CollapsibleContent className="mt-1 ml-5">
        <ToolDetails canRespond={canRespond} onAnswers={onAnswers} part={part} />
      </CollapsibleContent>
    </Collapsible>
  );
}

function ToolDetails({
  canRespond,
  onAnswers,
  part,
}: {
  readonly canRespond: boolean;
  readonly onAnswers: (responses: readonly AgentAnswer[]) => void | Promise<void>;
  readonly part: EveToolPart;
}) {
  const failed =
    ["completed", "failed", "rejected", "cancelled"].includes(part.state) &&
    part.state !== "completed";

  return (
    <div className="space-y-1.5">
      <InteractionActions canRespond={canRespond} onAnswers={onAnswers} part={part} />
      <ToolPayload label="input" value={part.input} />
      {["completed", "failed", "rejected", "cancelled"].includes(part.state) ? (
        <ToolPayload
          label={failed ? "error" : "result"}
          tone={failed ? "destructive" : "default"}
          value={failed ? part.error?.message : part.output}
        />
      ) : null}
    </div>
  );
}

function ToolStatusIcon({ status }: { readonly status: ToolStatus }) {
  const className = "size-3 shrink-0";

  if (status === "running") {
    return (
      <span className="flex size-4 shrink-0 items-center justify-center self-center">
        <Loader2Icon className={cn(className, "animate-spin")} />
      </span>
    );
  }

  if (status === "error" || status === "denied") {
    return (
      <span className="flex size-4 shrink-0 items-center justify-center self-center">
        <XIcon className={cn(className, "text-destructive")} />
      </span>
    );
  }

  return (
    <span className="flex size-4 shrink-0 items-center justify-center self-center">
      <CheckIcon className={cn(className, "text-emerald-500")} />
    </span>
  );
}

function ToolNameLabel({ part }: { readonly part: EveToolPart }) {
  return (
    <span className="shrink-0 rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
      {formatToolName(part.name)}
    </span>
  );
}

function ToolPayload({
  label,
  tone = "default",
  value,
}: {
  readonly label: string;
  readonly tone?: "default" | "destructive";
  readonly value: unknown;
}) {
  if (value === undefined) {
    return null;
  }

  return (
    <div className="space-y-1">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <pre
        className={cn(
          "max-h-56 overflow-auto rounded bg-muted/30 p-2 font-mono text-[11px] leading-5 text-muted-foreground",
          tone === "destructive" ? "bg-destructive/10 text-destructive" : undefined,
        )}
      >
        {formatPayload(value)}
      </pre>
    </div>
  );
}

function InteractionActions({
  canRespond,
  onAnswers,
  part,
}: {
  readonly canRespond: boolean;
  readonly onAnswers: (responses: readonly AgentAnswer[]) => void | Promise<void>;
  readonly part: EveToolPart;
}) {
  const [freeformText, setFreeformText] = useState("");
  const interaction = part.interaction;

  if (!interaction) {
    return null;
  }

  const { request, answer } = interaction;
  const selectedOption = request.options?.find((option) => option.id === answer?.optionId);

  if (answer) {
    return (
      <div className="rounded-md border border-border bg-background px-3 py-2 text-sm">
        <span className="text-muted-foreground">Responded: </span>
        <span className="font-medium">
          {selectedOption?.label ?? answer.text ?? answer.optionId}
        </span>
      </div>
    );
  }

  const sendTextResponse = () => {
    const text = freeformText.trim();
    if (!text) {
      return;
    }
    void onAnswers([{ interactionId: interaction.interactionId, text }]);
    setFreeformText("");
  };

  return (
    <div className="space-y-3 rounded-md border border-amber-500/30 bg-amber-500/5 p-3">
      <p className="text-sm text-muted-foreground">{request.prompt}</p>
      {request.options?.length ? (
        <div className="flex flex-wrap gap-2">
          {request.options.map((option) => (
            <Button
              disabled={!canRespond}
              key={option.id}
              onClick={() => {
                void onAnswers([
                  {
                    optionId: option.id,
                    interactionId: interaction.interactionId,
                  },
                ]);
              }}
              size="sm"
              type="button"
              variant={option.style === "danger" ? "destructive" : "default"}
            >
              {option.label}
            </Button>
          ))}
        </div>
      ) : null}
      {request.allowFreeform || request.display === "text" ? (
        <div className="flex gap-2">
          <Input
            disabled={!canRespond}
            onChange={(event) => setFreeformText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                sendTextResponse();
              }
            }}
            placeholder="Type a response"
            value={freeformText}
          />
          <Button
            disabled={!canRespond || freeformText.trim().length === 0}
            onClick={sendTextResponse}
            type="button"
          >
            Reply
          </Button>
        </div>
      ) : null}
    </div>
  );
}

type ToolStatus = "completed" | "denied" | "error" | "running";

function needsAnswer(part: EveToolPart) {
  return part.interaction?.status === "open";
}

function hasToolDetails(part: EveToolPart) {
  const hasInput = part.input !== undefined && formatPayload(part.input).trim().length > 0;
  const hasOutput = part.output !== undefined && formatPayload(part.output).trim().length > 0;
  const hasError = (part.error?.message.trim().length ?? 0) > 0;

  return hasInput || hasOutput || hasError || part.interaction !== undefined;
}

function getToolStatus(part: EveToolPart): ToolStatus {
  switch (part.state) {
    case "completed":
      return "completed";
    case "rejected":
      return "denied";
    case "failed":
    case "cancelled":
      return "error";
    default:
      return "running";
  }
}

function getToolGroupStatus(parts: readonly EveToolPart[]): ToolStatus {
  const statuses = parts.map(getToolStatus);

  if (statuses.includes("error")) {
    return "error";
  }

  if (statuses.includes("denied")) {
    return "denied";
  }

  if (statuses.includes("running")) {
    return "running";
  }

  return "completed";
}

function toolStatusLabel(status: ToolStatus) {
  switch (status) {
    case "completed":
      return "Complete";
    case "denied":
      return "Denied";
    case "error":
      return "Error";
    case "running":
      return "Running";
  }
}

function summarizeToolGroup(parts: readonly EveToolPart[]) {
  if (parts.length === 1) {
    return parts[0]!.label;
  }

  const counts = new Map<string, number>();

  for (const part of parts) {
    const category = toolCategory(part.name);
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }

  const labels: string[] = [];
  const order: [string, string, string, string][] = [
    ["searched", "Searched", "thing", "things"],
    ["read", "Read", "item", "items"],
    ["wrote", "Wrote", "item", "items"],
    ["ran", "Ran", "action", "actions"],
  ];

  for (const [key, verb, singular, plural] of order) {
    const count = counts.get(key);

    if (count) {
      labels.push(`${verb} ${count} ${count === 1 ? singular : plural}`);
    }
  }

  return labels.join(", ") || `Used ${parts.length} tools`;
}

function toolCategory(name: string) {
  const normalized = normalizeToolName(name);

  if (normalized.includes("search") || normalized.includes("grep")) {
    return "searched";
  }

  if (normalized.includes("read") || normalized.includes("fetch")) {
    return "read";
  }

  if (normalized.includes("write") || normalized.includes("edit")) {
    return "wrote";
  }

  return "ran";
}

function formatToolName(name: string) {
  return normalizeToolName(name).replace(/\s+/g, " ").trim();
}

function normalizeToolName(name: string) {
  return name.replace(/__/g, " ").replace(/[_-]/g, " ").trim().toLowerCase();
}

function formatPayload(value: unknown): string {
  if (typeof value === "string") {
    return truncateText(value, 4000);
  }

  try {
    return truncateText(JSON.stringify(value, null, 2), 4000);
  } catch {
    return truncateText(String(value), 4000);
  }
}

function truncateText(text: string, maxLength: number) {
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength)}\n...`;
}

function partKey(part: EveMessagePart, index: number): string {
  switch (part.type) {
    case "tool":
      return part.callId;
    case "text":
    case "reasoning":
      return part.id ?? `${part.type}:${index}`;
    default:
      return `${part.type}:${index}`;
  }
}
