"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { tap } from "@/lib/haptics";

export interface FeedItem {
  id: string; storyId: string; title: string; genre: string;
  endingTitle: string; rarity: string; decisions: number;
  views: number; likes: number; comments: number; remixes: number;
  poster: string | null; creator: string; creatorId: string;
  score: number | null; archetype: string; liked: boolean;
}

const RARITY_TINT: Record<string, string> = {
  secret: "rgba(216,176,114,.95)", rare: "rgba(216,176,114,.75)",
  uncommon: "rgba(245,243,240,.6)", common: "rgba(245,243,240,.4)",
};

export default function FeedList({ items, signedIn }: { items: FeedItem[]; signedIn: boolean }) {
  return (
    <div className="mt-4 flex flex-col gap-5">
      {items.map((item, i) => (
        <FeedCard key={item.id} item={item} signedIn={signedIn} delay={i * 60} />
      ))}
    </div>
  );
}

function FeedCard({ item, signedIn, delay }: { item: FeedItem; signedIn: boolean; delay: number }) {
  const router = useRouter();
  const [liked, setLiked] = useState(item.liked);
  const [likes, setLikes] = useState(item.likes);
  const [busy, setBusy] = useState(false);

  async function act(action: "like" | "remix") {
    if (!signedIn) return router.push("/login?next=/feed");
    tap();
    setBusy(true);
    try {
      if (action === "like") {
        setLiked((v) => !v);
        setLikes((n) => n + (liked ? -1 : 1));
        await fetch("/api/social", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "like", movieId: item.id }),
        });
      } else {
        const res = await fetch("/api/story", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ remixedFrom: item.storyId }),
        });
        const json = await res.json();
        if (json.ok) router.push(`/play/${json.storyId}`);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="rise glass overflow-hidden" style={{ animationDelay: `${delay}ms` }}>
      {/* Video/poster is the hero. */}
      <a href={`/m/${item.storyId}`} className="relative block aspect-[4/5] w-full overflow-hidden bg-black">
        {item.poster ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={item.poster} alt="" className="h-full w-full object-cover" loading="lazy" />
        ) : (
          <div
            className="flex h-full w-full items-center justify-center"
            style={{ background: "radial-gradient(70% 55% at 50% 25%, rgba(216,176,114,.2), transparent 70%), #08080A" }}
          >
            <span className="display px-8 text-center text-[1.6rem] opacity-70">{item.title}</span>
          </div>
        )}
        <div className="pointer-events-none absolute inset-0" style={{ background: "linear-gradient(180deg,transparent 45%,rgba(0,0,0,.88))" }} />
        <div className="absolute inset-x-4 bottom-4">
          <p className="kicker" style={{ color: RARITY_TINT[item.rarity] }}>{item.endingTitle}</p>
          <h3 className="display mt-1 text-[1.35rem]">{item.title}</h3>
          <p className="mt-1 text-[0.74rem] text-[color:var(--color-muted)]">
            {item.genre} · {item.decisions} choices
          </p>
        </div>
      </a>

      <div className="flex items-center justify-between px-4 py-3.5">
        <a href={`/u/${item.creator}`} className="flex min-w-0 items-center gap-2.5">
          <span className="glass-quiet flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[0.7rem] font-bold">
            {item.creator.slice(0, 1).toUpperCase()}
          </span>
          <span className="min-w-0">
            <span className="block truncate text-[0.82rem] font-semibold">@{item.creator}</span>
            {item.score !== null && (
              <span className="block truncate text-[0.64rem] text-[color:var(--color-faint)]">
                {item.archetype} · {item.score}
              </span>
            )}
          </span>
        </a>

        <div className="flex shrink-0 items-center gap-1.5">
          <button
            onClick={() => act("like")}
            disabled={busy}
            className="choice-card glass-quiet px-3 py-2 text-[0.68rem] tracking-[0.12em]"
            style={{ color: liked ? "var(--color-gold)" : undefined }}
          >
            ♥ {likes}
          </button>
          <button
            onClick={() => act("remix")}
            disabled={busy}
            className="choice-card glass-quiet px-3 py-2 text-[0.68rem] tracking-[0.12em]"
          >
            REMIX
          </button>
          <a href={`/m/${item.storyId}`} className="choice-card glass-quiet px-3 py-2 text-[0.68rem] tracking-[0.12em]">
            WATCH
          </a>
        </div>
      </div>
    </article>
  );
}
