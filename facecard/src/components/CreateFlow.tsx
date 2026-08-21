"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { QUESTIONS } from "@/lib/engine/questions";
import { getBrowserSupabase } from "@/lib/supabase/client";
import { GlassButton } from "./Glass";
import FaceCardVisual from "./FaceCardVisual";
import type { FaceCard } from "@/lib/engine/types";
import { tap, tick } from "@/lib/haptics";

type Step = number | "portrait" | "reveal";

export default function CreateFlow({ userId, username }: { userId: string; username: string }) {
  const router = useRouter();
  const [step, setStep] = useState<Step>(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [picked, setPicked] = useState<string | null>(null);
  const [portraitUrl, setPortraitUrl] = useState<string | null>(null);
  const [card, setCard] = useState<(FaceCard & { id: string }) | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const index = typeof step === "number" ? step : QUESTIONS.length;
  const question = typeof step === "number" ? QUESTIONS[step] : null;
  const progress = Math.min(1, index / QUESTIONS.length);

  const choose = useCallback(
    (key: string) => {
      if (!question || picked) return;
      tap();
      setPicked(key);
      const next = { ...answers, [question.key]: key };
      setAnswers(next);
      // Let the card physically react before advancing.
      setTimeout(() => {
        setPicked(null);
        setStep(step === QUESTIONS.length - 1 ? "portrait" : (step as number) + 1);
      }, 420);
    },
    [answers, picked, question, step],
  );

  async function uploadPortrait(file: File) {
    setError(null);
    if (!file.type.startsWith("image/")) return setError("That's not an image.");
    if (file.size > 5 * 1024 * 1024) return setError("Image must be under 5MB.");

    setBusy(true);
    try {
      const supabase = getBrowserSupabase();
      const ext = file.name.split(".").pop()?.toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg";
      const path = `${userId}/portrait-${Date.now()}.${ext}`;
      const { error } = await supabase.storage.from("portraits").upload(path, file, { upsert: true });
      if (error) throw error;
      const { data } = supabase.storage.from("portraits").getPublicUrl(path);
      setPortraitUrl(data.publicUrl);
      tick();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setBusy(false);
    }
  }

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/face-card", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ answers, portraitUrl }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error ?? "Could not build your Face Card.");
      setCard(json.faceCard);
      setStep("reveal");
      tick();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  async function startMovie() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/story", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error ?? "Could not start your movie.");
      router.push(`/play/${json.storyId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setBusy(false);
    }
  }

  const backdrop = useMemo(
    () => ({
      background:
        "radial-gradient(115% 70% at 50% 0%, rgba(216,176,114,0.14), transparent 62%), radial-gradient(80% 55% at 12% 96%, rgba(70,100,140,0.16), transparent 66%)",
    }),
    [],
  );

  return (
    <main className="relative min-h-dvh overflow-hidden bg-black">
      <div className="pointer-events-none absolute inset-0" style={backdrop} />
      <div className="film-grain" />

      {/* progress */}
      <div className="fixed inset-x-0 top-0 z-40 h-[2px] bg-white/8">
        <div
          className="h-full transition-all duration-700"
          style={{ width: `${progress * 100}%`, background: "linear-gradient(90deg, rgba(216,176,114,.5), rgba(216,176,114,1))" }}
        />
      </div>

      <div className="relative z-10 mx-auto flex min-h-dvh w-full max-w-lg flex-col justify-center px-6 py-16">
        {/* ── questions ─────────────────────────────────────────────── */}
        {question && (
          <div key={question.key} className="rise">
            <p className="kicker">
              {index + 1} / {QUESTIONS.length}
            </p>
            <h1 className="display mt-4 text-[clamp(1.9rem,7vw,3.1rem)]">{question.prompt}</h1>
            <p className="mt-3 text-[0.9rem] text-[color:var(--color-muted)]">{question.kicker}</p>

            <div className="mt-8 flex flex-col gap-2.5">
              {question.options.map((opt, i) => (
                <button
                  key={opt.key}
                  onClick={() => choose(opt.key)}
                  data-picked={picked === opt.key}
                  data-dimmed={picked !== null && picked !== opt.key}
                  className="choice-card glass px-5 py-4 text-left text-[0.92rem] font-semibold tracking-[0.04em]"
                  style={{ animation: `riseIn .6s var(--ease-out) both`, animationDelay: `${i * 45}ms` }}
                >
                  {opt.label}
                </button>
              ))}
            </div>

            {index > 0 && (
              <button
                onClick={() => setStep((index - 1) as Step)}
                className="kicker mt-7 self-start opacity-60 hover:opacity-100"
              >
                ← back
              </button>
            )}
          </div>
        )}

        {/* ── portrait ──────────────────────────────────────────────── */}
        {step === "portrait" && (
          <div className="rise">
            <p className="kicker">Last thing</p>
            <h1 className="display mt-4 text-[clamp(1.9rem,7vw,3.1rem)]">ADD YOUR FACE.</h1>
            <p className="mt-3 text-[0.9rem] text-[color:var(--color-muted)]">
              Optional — your card works without it.
            </p>

            <div className="mt-8 flex flex-col items-center gap-5">
              <button
                onClick={() => fileRef.current?.click()}
                className="choice-card glass flex h-44 w-44 items-center justify-center overflow-hidden rounded-full"
              >
                {portraitUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={portraitUrl} alt="Your portrait" className="h-full w-full object-cover" />
                ) : (
                  <span className="kicker">{busy ? "uploading" : "tap to upload"}</span>
                )}
              </button>
              <input
                ref={fileRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void uploadPortrait(f);
                }}
              />

              {error && <p className="text-[0.82rem] text-[#E0836F]">{error}</p>}

              <GlassButton onClick={generate} tone="gold" disabled={busy} className="w-full">
                {busy ? "Building your card…" : "Generate my Face Card"}
              </GlassButton>
              {portraitUrl && (
                <button onClick={() => setPortraitUrl(null)} className="kicker opacity-60 hover:opacity-100">
                  remove photo
                </button>
              )}
            </div>
          </div>
        )}

        {/* ── reveal ────────────────────────────────────────────────── */}
        {step === "reveal" && card && (
          <div className="materialize flex flex-col items-center">
            <p className="kicker">Your cinematic identity</p>
            <div className="mt-6">
              <FaceCardVisual card={card} />
            </div>

            {error && <p className="mt-4 text-[0.82rem] text-[#E0836F]">{error}</p>}

            <div className="mt-8 flex w-full max-w-[380px] flex-col gap-3">
              <GlassButton onClick={startMovie} tone="gold" disabled={busy} className="w-full">
                {busy ? "Rolling…" : "Start my movie"}
              </GlassButton>
              <GlassButton href="/feed" className="w-full">See what others made</GlassButton>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
