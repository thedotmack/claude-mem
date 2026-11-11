"use client";

import type { ComponentProps, ReactNode } from "react";
import { useState } from "react";
import { Loader2Icon } from "lucide-react";
import { VercelIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";
import { cn } from "@/lib/utils";

export function SignInButton({
  callbackPath,
  children,
  className,
  disabled,
  onBeforeSignIn,
  variant = "default",
}: {
  readonly callbackPath?: string;
  readonly children?: ReactNode;
  readonly className?: string;
  readonly disabled?: boolean;
  readonly onBeforeSignIn?: () => void;
  readonly variant?: ComponentProps<typeof Button>["variant"];
}) {
  const [pending, setPending] = useState(false);

  return (
    <Button
      aria-busy={pending}
      className={cn("gap-2", className)}
      disabled={disabled || pending}
      onClick={async () => {
        setPending(true);

        try {
          onBeforeSignIn?.();

          const result = await authClient.signIn.social({
            provider: "vercel",
            callbackURL: resolveCallbackPath(callbackPath),
          });

          if (result?.error) {
            setPending(false);
          }
        } catch {
          setPending(false);
        }
      }}
      type="button"
      variant={variant}
    >
      {pending ? (
        <Loader2Icon className="size-3.5 animate-spin" />
      ) : (
        <VercelIcon className="size-3.5" />
      )}
      {pending ? "Opening..." : (children ?? "Sign in with Vercel")}
    </Button>
  );
}

function resolveCallbackPath(path: string | undefined) {
  if (!path || !path.startsWith("/") || path.startsWith("//")) {
    return "/";
  }

  return path;
}
