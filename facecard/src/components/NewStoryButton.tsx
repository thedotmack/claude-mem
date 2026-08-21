"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { tap } from "@/lib/haptics";

/** Starts a movie from a trending premise (or lets the engine pick). */
export default function NewStoryButton({
  templateKey, label, sub, className = "", variant = "button",
}: {
  templateKey?: string;
  label: string;
  sub?: string;
  className?: string;
  variant?: "button" | "card";
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    tap();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/story", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(templateKey ? { templateKey } : {}),
      });
      const json = await res.json();
      if (res.status === 401) return router.push("/login?next=/feed");
      if (res.status === 409) return router.push("/create");
      if (!res.ok || !json.ok) throw new Error(json.error ?? "Could not start.");
      router.push(`/play/${json.storyId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setBusy(false);
    }
  }

  if (variant === "card") {
    return (
      <button onClick={start} disabled={busy} className={`choice-card glass px-4 py-4 text-left ${className}`}>
        <span className="block text-[0.88rem] font-semibold tracking-[0.04em]">{busy ? "Starting…" : label}</span>
        {sub && <span className="mt-1.5 block text-[0.7rem] leading-snug text-[color:var(--color-muted)]">{sub}</span>}
        {error && <span className="mt-2 block text-[0.66rem] text-[#E0836F]">{error}</span>}
      </button>
    );
  }

  return (
    <button
      onClick={start}
      disabled={busy}
      className={`choice-card glass px-5 py-2.5 text-[0.7rem] font-semibold uppercase tracking-[0.16em] ${className}`}
    >
      {busy ? "…" : label}
    </button>
  );
}
