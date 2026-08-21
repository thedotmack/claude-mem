"use client";

import { useState } from "react";
import { GlassButton } from "./Glass";
import { EMOTION_LABEL } from "@/lib/engine/emotions";
import type { EmotionKey, Emotions } from "@/lib/engine/types";

interface Ending {
  key: string;
  title: string;
  rarity: "common" | "uncommon" | "rare" | "secret";
  summary: string;
  final_line?: string;
  finalLine?: string;
  decisionCount?: number;
  decision_count?: number;
  arc: {
    started: Emotions;
    ended: Emotions;
    biggestShifts: { key: EmotionKey; from: number; to: number; delta: number }[];
    walkAwayChances: number;
  };
}

const RARITY_LABEL: Record<string, string> = {
  secret: "SECRET ENDING", rare: "RARE ENDING",
  uncommon: "UNCOMMON ENDING", common: "ENDING",
};

/** The ending reveal (spec §17): freeze frame, glass card, character arc. */
export default function EndingCard({
  storyId, ending, onReplay,
}: { storyId: string; ending: Ending; onReplay: () => void }) {
  const [copied, setCopied] = useState(false);
  const [challengeCode, setChallengeCode] = useState<string | null>(null);
  const finalLine = ending.finalLine ?? ending.final_line ?? "";
  const decisions = ending.decisionCount ?? ending.decision_count ?? 0;
  const shifts = ending.arc?.biggestShifts ?? [];

  async function share() {
    const url = `${window.location.origin}/m/${storyId}`;
    const text = `MY ENDING: ${ending.title} — ${decisions} choices. What would you have done?`;
    try {
      if (navigator.share) await navigator.share({ title: "FACE CARD", text, url });
      else {
        await navigator.clipboard.writeText(`${text} ${url}`);
        setCopied(true);
        setTimeout(() => setCopied(false), 2200);
      }
    } catch { /* dismissed */ }
  }

  async function challenge() {
    const res = await fetch("/api/social", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "challenge", movieId: storyId }),
    });
    const json = await res.json().catch(() => ({}));
    if (json?.ok && json.code) setChallengeCode(json.code);
  }

  return (
    <main className="relative min-h-dvh overflow-hidden bg-black">
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(110% 65% at 50% 0%, rgba(216,176,114,0.2), transparent 60%), radial-gradient(80% 50% at 20% 100%, rgba(70,100,140,0.16), transparent 66%)",
        }}
      />
      <div className="film-grain" />

      <div className="relative z-10 mx-auto flex min-h-dvh w-full max-w-lg flex-col justify-center px-6 py-16">
        <div className="materialize glass px-7 py-9">
          <p className="kicker">{RARITY_LABEL[ending.rarity] ?? "ENDING"}</p>
          <p className="mt-5 text-[0.78rem] tracking-[0.2em] text-[color:var(--color-muted)]">YOUR STORY ENDED:</p>
          <h1 className="display mt-2 text-[clamp(2.4rem,10vw,3.8rem)] text-[color:var(--color-gold)]">
            {ending.title}
          </h1>

          <p className="mt-5 text-[0.95rem] leading-relaxed text-[color:var(--color-paper)]/85">{ending.summary}</p>

          <div className="mt-6 flex items-center gap-5 border-y border-white/8 py-4">
            <div>
              <p className="display text-[1.7rem]">{decisions}</p>
              <p className="kicker" style={{ fontSize: "0.5rem" }}>Decisions</p>
            </div>
            <div className="h-8 w-px bg-white/10" />
            <div>
              <p className="display text-[1.7rem]">{ending.arc?.walkAwayChances ?? 0}</p>
              <p className="kicker" style={{ fontSize: "0.5rem" }}>Chances to walk away</p>
            </div>
          </div>

          {shifts.length > 0 && (
            <div className="mt-6">
              <p className="kicker">Your character arc</p>
              <div className="mt-3 space-y-2.5">
                {shifts.map((s) => (
                  <div key={s.key} className="flex items-center gap-3 text-[0.8rem]">
                    <span className="w-[5.5rem] shrink-0 text-[color:var(--color-muted)]">
                      {EMOTION_LABEL[s.key] ?? s.key}
                    </span>
                    <span className="tabular-nums text-[color:var(--color-faint)]">{s.from}</span>
                    <span className="relative h-[3px] flex-1 overflow-hidden rounded-full bg-white/10">
                      <span
                        className="absolute inset-y-0 rounded-full"
                        style={{
                          left: `${Math.min(s.from, s.to)}%`,
                          width: `${Math.max(2, Math.abs(s.delta))}%`,
                          background: s.delta >= 0 ? "rgba(216,176,114,.95)" : "rgba(224,131,111,.9)",
                        }}
                      />
                    </span>
                    <span className="w-7 text-right tabular-nums">{s.to}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {finalLine && (
            <p className="mt-7 whitespace-pre-line border-l-2 border-[color:var(--color-gold)]/50 pl-4 text-[1.05rem] font-medium leading-snug">
              {finalLine}
            </p>
          )}
        </div>

        <div className="rise mt-6 flex flex-col gap-3" style={{ animationDelay: "260ms" }}>
          <GlassButton onClick={share} tone="gold" className="w-full">
            {copied ? "Link copied" : "Share my movie"}
          </GlassButton>
          <div className="flex gap-3">
            <GlassButton onClick={challenge} className="flex-1">
              {challengeCode ? `Code ${challengeCode}` : "Challenge a friend"}
            </GlassButton>
            <GlassButton href="/feed" className="flex-1">Feed</GlassButton>
          </div>
          <GlassButton onClick={onReplay} className="w-full">Play again — different choices</GlassButton>
          <a href="/me" className="kicker mt-2 text-center opacity-70 hover:opacity-100">My movies</a>
        </div>
      </div>
    </main>
  );
}
