"use client";

import { useState } from "react";
import { tap } from "@/lib/haptics";

export default function FollowButton({ userId, initial }: { userId: string; initial: boolean }) {
  const [following, setFollowing] = useState(initial);
  const [busy, setBusy] = useState(false);

  return (
    <button
      disabled={busy}
      onClick={async () => {
        tap();
        setBusy(true);
        setFollowing((v) => !v);
        await fetch("/api/social", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "follow", userId }),
        });
        setBusy(false);
      }}
      className="choice-card glass px-5 py-2.5 text-[0.68rem] font-semibold uppercase tracking-[0.16em]"
      style={{ color: following ? "var(--color-muted)" : "var(--color-gold)" }}
    >
      {following ? "Following" : "Follow"}
    </button>
  );
}
