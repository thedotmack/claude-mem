"use client";

import { useEffect, useState } from "react";
import { GlassButton } from "./Glass";

const TAGLINES = [
  "YOUR FACE. YOUR CHOICES. YOUR MOVIE.",
  "EVERY CHOICE BECOMES A SCENE.",
  "YOU'RE NOT WATCHING THE MOVIE.",
  "YOU ARE THE MOVIE.",
];

/**
 * The first impression (spec §1): black screen, one line of text, then the
 * interface materialises as floating glass. No dashboard, no menus, no
 * explanation — it should read as entertainment immediately.
 */
export default function Opening() {
  const [phase, setPhase] = useState<0 | 1 | 2>(0);
  const [tagline, setTagline] = useState(0);

  useEffect(() => {
    const a = setTimeout(() => setPhase(1), 2600);
    const b = setTimeout(() => setPhase(2), 4300);
    return () => { clearTimeout(a); clearTimeout(b); };
  }, []);

  useEffect(() => {
    if (phase < 2) return;
    const i = setInterval(() => setTagline((t) => (t + 1) % TAGLINES.length), 3400);
    return () => clearInterval(i);
  }, [phase]);

  return (
    <main className="relative min-h-dvh overflow-hidden bg-black">
      {/* Ambient light that only resolves once the interface arrives. */}
      <div
        className="pointer-events-none absolute inset-0 transition-opacity duration-[2400ms]"
        style={{
          opacity: phase === 0 ? 0 : 1,
          background:
            "radial-gradient(120% 80% at 50% 8%, rgba(216,176,114,0.16), transparent 58%), radial-gradient(90% 60% at 15% 92%, rgba(80,110,150,0.14), transparent 62%)",
        }}
      />
      <div className="film-grain" style={{ opacity: phase === 0 ? 0.22 : 0.4 }} />

      <div className="relative z-10 flex min-h-dvh flex-col items-center justify-center px-6 py-16">
        {/* Phase 0 — the question, alone on black. */}
        <h1
          className="display max-w-[15ch] text-center text-[clamp(2rem,7.6vw,4.4rem)] transition-all duration-1000"
          style={{
            opacity: phase === 0 ? 1 : phase === 1 ? 0.9 : 1,
            transform: phase === 0 ? "none" : "translateY(-6px)",
          }}
        >
          {phase === 0 ? (
            <span className="fade">WHAT KIND OF STORY ARE YOU ABOUT TO CREATE?</span>
          ) : (
            <span className="materialize">FACE CARD</span>
          )}
        </h1>

        {phase >= 1 && (
          <p
            className="kicker mt-7 h-4 text-center transition-opacity duration-700"
            key={tagline}
          >
            <span className="fade">{TAGLINES[tagline]}</span>
          </p>
        )}

        {/* Phase 2 — the interface materialises as floating glass. */}
        {phase === 2 && (
          <div className="materialize mt-14 w-full max-w-md" style={{ animationDelay: "120ms" }}>
            <div className="glass px-7 py-8">
              <p className="text-center text-[0.95rem] leading-relaxed text-[color:var(--color-muted)]">
                An AI film where you&apos;re the main character.
                <br />
                Answer nine questions. Get your Face Card.
                <br />
                Then decide what happens next.
              </p>

              <div className="mt-7 flex flex-col gap-3">
                <GlassButton href="/signup" tone="gold" className="w-full">
                  Create your Face Card
                </GlassButton>
                <GlassButton href="/login" className="w-full">
                  I already have one
                </GlassButton>
              </div>
            </div>

            <div className="mt-5 flex items-center justify-center gap-6">
              <a href="/feed" className="kicker transition-opacity hover:opacity-100" style={{ opacity: 0.7 }}>
                Watch first
              </a>
              <span className="text-[color:var(--color-faint)]">·</span>
              <span className="kicker">3–7 min movies</span>
            </div>
          </div>
        )}
      </div>

      {phase === 0 && (
        <div className="absolute inset-x-0 bottom-10 flex justify-center">
          <span className="kicker breathe">loading your story</span>
        </div>
      )}
    </main>
  );
}
