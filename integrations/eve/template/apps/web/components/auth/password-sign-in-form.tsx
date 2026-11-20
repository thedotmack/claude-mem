"use client";

import { Loader2Icon } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function PasswordSignInForm({
  callbackPath,
  onBeforeSignIn,
}: {
  readonly callbackPath?: string;
  readonly onBeforeSignIn?: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!password || pending) {
      return;
    }

    setError(null);
    setPending(true);

    try {
      const response = await fetch("/api/password-auth/login", {
        body: JSON.stringify({ password }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const result = (await response.json().catch(() => null)) as {
        readonly error?: string;
      } | null;

      if (!response.ok) {
        setError(result?.error ?? "Unable to sign in.");
        setPending(false);
        return;
      }

      onBeforeSignIn?.();
      window.location.assign(resolveCallbackPath(callbackPath));
    } catch {
      setError("Unable to sign in. Check your connection and try again.");
      setPending(false);
    }
  }

  return (
    <form className="space-y-3" onSubmit={handleSubmit}>
      <Input
        aria-label="Password"
        autoComplete="current-password"
        autoFocus
        disabled={pending}
        id="eve-chat-password"
        onChange={(event) => setPassword(event.target.value)}
        type="password"
        value={password}
      />
      {error ? (
        <p aria-live="polite" className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      <Button aria-busy={pending} className="h-11 w-full" disabled={pending} type="submit">
        {pending ? <Loader2Icon className="size-4 animate-spin" /> : null}
        {pending ? "Signing in..." : "Continue"}
      </Button>
    </form>
  );
}

function resolveCallbackPath(path: string | undefined) {
  if (!path || !path.startsWith("/") || path.startsWith("//")) {
    return "/";
  }

  return path;
}
