"use client";

import { useState } from "react";
import { ChevronsUpDownIcon, Loader2Icon, LogOutIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { VercelIcon } from "@/components/icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { authClient } from "@/lib/auth-client";
import type { AuthMode, Viewer } from "@/lib/chat/types";

export function UserMenu({
  authMode,
  viewer,
}: {
  readonly authMode: AuthMode;
  readonly viewer: Viewer;
}) {
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);

  if (authMode === "local-dev") {
    return (
      <div className="flex w-full items-center gap-2 rounded-md px-2 py-1.5">
        <UserAvatar viewer={viewer} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium text-foreground">
            Local development
          </span>
          <span className="block truncate text-[11px] text-muted-foreground">Browser storage</span>
        </span>
      </div>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted/50 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
          type="button"
        >
          <UserAvatar viewer={viewer} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs font-medium text-foreground">
              {viewer.name}
            </span>
            <span className="block truncate text-[11px] text-muted-foreground">{viewer.email}</span>
          </span>
          <ChevronsUpDownIcon className="size-3.5 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56" side="top" sideOffset={8}>
        <DropdownMenuLabel className="min-w-0">
          <span className="block truncate text-sm">{viewer.name}</span>
          <span className="block truncate text-xs font-normal text-muted-foreground">
            {viewer.email}
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          aria-busy={signingOut}
          disabled={signingOut}
          onSelect={(event) => {
            event.preventDefault();

            if (signingOut) {
              return;
            }

            setSigningOut(true);
            const signOut =
              authMode === "password"
                ? fetch("/api/password-auth/logout", { method: "POST" }).then((response) => {
                    if (!response.ok) {
                      throw new Error("Failed to sign out.");
                    }
                  })
                : authClient.signOut().then(() => undefined);

            void signOut
              .then(() => {
                router.replace("/");
                router.refresh();
              })
              .catch(() => {
                setSigningOut(false);
              });
          }}
        >
          {signingOut ? (
            <Loader2Icon className="size-4 animate-spin" />
          ) : (
            <LogOutIcon className="size-4" />
          )}
          {signingOut ? "Signing out..." : "Sign out"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function UserAvatar({ viewer }: { readonly viewer: Viewer }) {
  if (viewer.image) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        alt=""
        className="size-7 rounded-md border border-border object-cover"
        src={viewer.image}
      />
    );
  }

  return (
    <span className="flex size-7 items-center justify-center rounded-md border border-border bg-background">
      <VercelIcon className="size-3 text-muted-foreground" />
    </span>
  );
}
