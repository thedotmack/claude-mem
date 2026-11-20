"use client";

import type { ComponentType } from "react";
import { HammerIcon } from "lucide-react";
import { LinearIcon, NotionIcon, SentryIcon } from "@/components/icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { EnabledConnections } from "@/app/_components/chat-shell-context";
import type { SetupStatus } from "@/lib/chat/types";
import { cn } from "@/lib/utils";

type ConnectionItem = {
  readonly key: keyof EnabledConnections;
  readonly label: string;
  readonly Icon: ComponentType<{ readonly className?: string }>;
};

const CONNECTION_ITEMS: readonly ConnectionItem[] = [
  { key: "notion", label: "Notion", Icon: NotionIcon },
  { key: "linear", label: "Linear", Icon: LinearIcon },
  { key: "sentry", label: "Sentry", Icon: SentryIcon },
];

export function IntegrationsMenu({
  enabledConnections,
  onConnectionEnabledChange,
  setupStatus,
}: {
  readonly enabledConnections: EnabledConnections;
  readonly onConnectionEnabledChange: (
    connection: keyof EnabledConnections,
    enabled: boolean,
  ) => void;
  readonly setupStatus: SetupStatus;
}) {
  const setupReady = setupStatus.appReady;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          aria-label="Connections"
          className="inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground/75 transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:bg-muted/60 focus-visible:text-foreground focus-visible:outline-none dark:text-muted-foreground/60 [&_*]:cursor-pointer"
          type="button"
        >
          <HammerIcon className="size-4 shrink-0 cursor-pointer" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-48 rounded-md border-border bg-popover p-1"
        sideOffset={4}
      >
        {CONNECTION_ITEMS.map(({ Icon, key, label }) => {
          const enabled = enabledConnections[key];

          return (
            <DropdownMenuItem
              aria-checked={enabled}
              className="h-9 cursor-pointer gap-2 rounded-sm px-2 py-1 text-sm focus:bg-muted/70"
              disabled={!setupReady}
              key={key}
              onSelect={(event) => {
                event.preventDefault();

                if (setupReady) {
                  onConnectionEnabledChange(key, !enabled);
                }
              }}
              role="menuitemcheckbox"
            >
              <span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border bg-background text-foreground">
                <Icon className="size-[18px] text-foreground" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-foreground">{label}</span>
              </span>
              <span
                aria-hidden="true"
                className={cn(
                  "relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors",
                  enabled ? "bg-emerald-500" : "bg-muted",
                )}
              >
                <span
                  className={cn(
                    "size-3 rounded-full bg-white shadow-sm transition-transform",
                    enabled ? "translate-x-[15px]" : "translate-x-0.5",
                  )}
                />
              </span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
