"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { GlassButton } from "./Glass";
import { tap } from "@/lib/haptics";
import type { ScriptLine } from "@/lib/engine/types";

interface Movie {
  id: string; storyId: string; title: string; genre: string; logline: string;
  endingTitle: string; rarity: string; decisions: number; views: number;
  likes: number; remixes: number; creator: string; poster: string | null;
}

interface SceneRow {
  id: string; seq: number; title: string;
  script: { slug: string; lines: ScriptLine[]; question: string };
  selected_choice: { key: string; label: string } | null;
  generated_assets: { still?: string };
}

export default function MovieView({
  movie, ending, scenes, liked: initialLiked, comments: initialComments, signedIn, isOwner,
}: {
  movie: Movie;
  ending: { title: string; summary: string; final_line: string; rarity: string } | null;
  scenes: SceneRow[];
  liked: boolean;
  comments: { id: string; body: string; author: string }[];
  signedIn: boolean;
  isOwner: boolean;
}) {
  const router = useRouter();
  const [liked, setLiked] = useState(initialLiked);
  const [likes, setLikes] = useState(movie.likes);
  const [comments, setComments] = useState(initialComments);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState<number | null>(null);

  // Count a view once per mount.
  useEffect(() => {
    if (!signedIn) return;
    void fetch("/api/social", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "view", movieId: movie.id }),
    });
  }, [movie.id, signedIn]);

  function requireAuth() {
    if (!signedIn) { router.push(`/login?next=/m/${movie.storyId}`); return true; }
    return false;
  }

  async function like() {
    if (requireAuth()) return;
    tap();
    setLiked((v) => !v);
    setLikes((n) => n + (liked ? -1 : 1));
    await fetch("/api/social", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "like", movieId: movie.id }),
    });
  }

  async function remix() {
    if (requireAuth()) return;
    setBusy(true);
    const res = await fetch("/api/story", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ remixedFrom: movie.storyId }),
    });
    const json = await res.json();
    if (res.status === 409) return router.push("/create");
    if (json.ok) router.push(`/play/${json.storyId}`);
    else setBusy(false);
  }

  async function comment(e: React.FormEvent) {
    e.preventDefault();
    if (requireAuth() || !draft.trim()) return;
    setBusy(true);
    const body = draft.trim();
    const res = await fetch("/api/social", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "comment", movieId: movie.id, body }),
    });
    const json = await res.json();
    if (json.ok) {
      setComments((c) => [{ id: json.comment.id, body, author: "you" }, ...c]);
      setDraft("");
    }
    setBusy(false);
  }

  async function share() {
    const url = window.location.href;
    const text = `${movie.creator.toUpperCase()}'S MOVIE — ENDING: ${movie.endingTitle} · ${movie.decisions} choices. What would you have done?`;
    try {
      if (navigator.share) await navigator.share({ title: movie.title, text, url });
      else {
        await navigator.clipboard.writeText(`${text} ${url}`);
        setCopied(true);
        setTimeout(() => setCopied(false), 2200);
      }
    } catch { /* dismissed */ }
  }

  return (
    <main className="relative min-h-dvh bg-black pb-20">
      <div className="pointer-events-none fixed inset-0" style={{ background: "radial-gradient(100% 55% at 50% 0%, rgba(216,176,114,0.13), transparent 60%)" }} />

      <div className="relative z-10 mx-auto w-full max-w-2xl px-5 pt-[max(1.5rem,env(safe-area-inset-top))]">
        <a href="/feed" className="kicker">← Feed</a>

        <div className="glass mt-5 overflow-hidden">
          <div className="relative aspect-[4/5] w-full bg-black">
            {movie.poster ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={movie.poster} alt="" className="h-full w-full object-cover" />
            ) : (
              <div className="flex h-full w-full items-center justify-center" style={{ background: "radial-gradient(70% 55% at 50% 25%, rgba(216,176,114,.2), transparent 70%)" }}>
                <span className="display px-8 text-center text-[2rem]">{movie.title}</span>
              </div>
            )}
            <div className="pointer-events-none absolute inset-0" style={{ background: "linear-gradient(180deg,transparent 42%,rgba(0,0,0,.9))" }} />
            <div className="absolute inset-x-5 bottom-5">
              <p className="kicker text-[color:var(--color-gold)]">{movie.endingTitle}</p>
              <h1 className="display mt-1.5 text-[2rem]">{movie.title}</h1>
              <p className="mt-1 text-[0.78rem] text-[color:var(--color-muted)]">
                @{movie.creator} · {movie.genre} · {movie.decisions} choices
              </p>
            </div>
          </div>

          <div className="px-5 py-4">
            <p className="text-[0.9rem] leading-relaxed text-[color:var(--color-paper)]/85">{movie.logline}</p>

            <div className="mt-4 flex flex-wrap gap-2">
              <button onClick={like} className="choice-card glass-quiet px-4 py-2.5 text-[0.7rem] tracking-[0.14em]" style={{ color: liked ? "var(--color-gold)" : undefined }}>
                ♥ {likes}
              </button>
              <button onClick={remix} disabled={busy} className="choice-card glass-quiet px-4 py-2.5 text-[0.7rem] tracking-[0.14em]">
                REMIX
              </button>
              <button onClick={share} className="choice-card glass-quiet px-4 py-2.5 text-[0.7rem] tracking-[0.14em]">
                {copied ? "COPIED" : "SEND"}
              </button>
              {isOwner && (
                <a href={`/play/${movie.storyId}`} className="choice-card glass-quiet px-4 py-2.5 text-[0.7rem] tracking-[0.14em]">
                  REWATCH
                </a>
              )}
            </div>
          </div>
        </div>

        {ending && (
          <div className="glass mt-5 px-6 py-6">
            <p className="kicker">How it ended</p>
            <h2 className="display mt-2 text-[1.6rem] text-[color:var(--color-gold)]">{ending.title}</h2>
            <p className="mt-3 text-[0.9rem] leading-relaxed text-[color:var(--color-paper)]/85">{ending.summary}</p>
            {ending.final_line && (
              <p className="mt-4 whitespace-pre-line border-l-2 border-[color:var(--color-gold)]/50 pl-4 text-[0.98rem] font-medium leading-snug">
                {ending.final_line}
              </p>
            )}
          </div>
        )}

        {/* The path they took — every decision is public record. */}
        <section className="mt-8">
          <p className="kicker">The choices they made</p>
          <div className="mt-3 flex flex-col gap-2">
            {scenes.map((s, i) => (
              <div key={s.id} className="glass-quiet overflow-hidden">
                <button
                  onClick={() => setOpen(open === i ? null : i)}
                  className="flex w-full items-center justify-between px-5 py-3.5 text-left"
                >
                  <span className="min-w-0">
                    <span className="script-slug block truncate">{s.script?.slug}</span>
                    <span className="mt-0.5 block truncate text-[0.86rem] font-semibold">
                      {s.selected_choice?.label ?? (i === scenes.length - 1 ? "— final scene —" : "—")}
                    </span>
                  </span>
                  <span className="kicker shrink-0">{open === i ? "−" : "+"}</span>
                </button>
                {open === i && (
                  <div className="border-t border-white/8 px-5 py-4">
                    {s.generated_assets?.still && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={s.generated_assets.still} alt="" className="mb-4 w-full rounded-xl" loading="lazy" />
                    )}
                    <div className="flex flex-col gap-2.5">
                      {s.script?.lines?.map((line, li) => (
                        <LineView key={li} line={line} />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>

        <section className="mt-8">
          <p className="kicker">Comments</p>
          <form onSubmit={comment} className="mt-3 flex gap-2">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              maxLength={500}
              placeholder={signedIn ? "say something" : "sign in to comment"}
              className="flex-1 rounded-2xl border border-white/12 bg-white/[0.045] px-4 py-3 text-[0.88rem] placeholder:text-white/30 focus:border-white/28 focus:outline-none"
            />
            <GlassButton type="submit" disabled={busy || !draft.trim()}>Post</GlassButton>
          </form>
          <div className="mt-4 flex flex-col gap-2.5">
            {comments.map((c) => (
              <div key={c.id} className="glass-quiet px-4 py-3">
                <p className="kicker" style={{ fontSize: "0.52rem" }}>@{c.author}</p>
                <p className="mt-1 text-[0.88rem]">{c.body}</p>
              </div>
            ))}
            {comments.length === 0 && (
              <p className="text-[0.84rem] text-[color:var(--color-muted)]">No comments yet.</p>
            )}
          </div>
        </section>

        <div className="mt-10 flex justify-center pb-6">
          <GlassButton onClick={remix} tone="gold">Play this story yourself</GlassButton>
        </div>
      </div>
    </main>
  );
}

function LineView({ line }: { line: ScriptLine }) {
  if (line.type === "slug") return <p className="script-slug">{line.text}</p>;
  if (line.type === "action") return <p className="text-[0.88rem] leading-relaxed opacity-90">{line.text}</p>;
  if (line.type === "voiceover") return <p className="text-[0.86rem] italic leading-relaxed text-[color:var(--color-muted)]">{line.text}</p>;
  if (line.type === "title") return <p className="display py-1 text-center text-[1.1rem]">{line.text}</p>;
  if (line.type === "beat") return <div className="h-2" />;
  if (line.type === "message") {
    return (
      <div className="glass-quiet max-w-[80%] px-3.5 py-2.5">
        <p className="kicker" style={{ fontSize: "0.48rem" }}>{line.from}</p>
        <p className="mt-0.5 text-[0.85rem] font-semibold">{line.text}</p>
      </div>
    );
  }
  return (
    <div>
      <p className="kicker" style={{ fontSize: "0.5rem" }}>{line.who}</p>
      <p className="mt-0.5 text-[0.92rem] font-medium leading-snug">{line.text}</p>
    </div>
  );
}
