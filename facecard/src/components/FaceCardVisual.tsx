import type { FaceCard } from "@/lib/engine/types";

const STAT_ORDER: (keyof FaceCard["stats"])[] = ["confidence", "ambition", "loyalty", "risk", "chaos"];

/**
 * The Face Card — a premium digital collectible (spec §3).
 * Layered glass, refraction, blurred environment behind, luxury restraint.
 */
export default function FaceCardVisual({ card, compact = false }: { card: FaceCard; compact?: boolean }) {
  const initial = card.username.slice(0, 1).toUpperCase();

  return (
    <div className={`relative ${compact ? "w-full max-w-[240px]" : "w-full max-w-[380px]"}`}>
      {/* Blurred environment the card floats in front of. */}
      <div
        className="pointer-events-none absolute -inset-8 blur-3xl"
        style={{
          background:
            "radial-gradient(60% 50% at 30% 18%, rgba(216,176,114,0.32), transparent 70%), radial-gradient(55% 45% at 78% 82%, rgba(70,100,140,0.3), transparent 72%)",
        }}
      />

      <article
        className="glass relative overflow-hidden"
        style={{ borderRadius: compact ? 22 : 30, aspectRatio: "3 / 4.15" }}
      >
        {/* Refraction sweep across the slab. */}
        <div
          className="pointer-events-none absolute inset-0 opacity-60"
          style={{
            background:
              "linear-gradient(118deg, transparent 26%, rgba(255,255,255,0.16) 41%, transparent 54%)",
          }}
        />

        <div className={`relative flex h-full flex-col ${compact ? "p-4" : "p-6"}`}>
          {/* header */}
          <header className="flex items-start justify-between">
            <div>
              <p className="kicker">{card.era}</p>
              <h3 className={`display mt-1 ${compact ? "text-[1.35rem]" : "text-[2.1rem]"}`}>
                {card.username.toUpperCase()}
              </h3>
            </div>
            <div className="text-right">
              <div
                className={`display leading-none text-[color:var(--color-gold)] ${compact ? "text-[2rem]" : "text-[3.1rem]"}`}
              >
                {card.score}
              </div>
              <p className="kicker mt-1" style={{ fontSize: "0.5rem" }}>
                Style rating
              </p>
            </div>
          </header>

          {/* portrait */}
          <div className="relative mt-4 flex-1 overflow-hidden rounded-2xl border border-white/10">
            {card.portraitUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={card.portraitUrl} alt="" className="h-full w-full object-cover" />
            ) : (
              <div
                className="flex h-full w-full items-center justify-center"
                style={{
                  background:
                    "radial-gradient(75% 60% at 50% 22%, rgba(216,176,114,0.24), transparent 68%), linear-gradient(180deg, #14100B, #000)",
                }}
              >
                <span className="display text-[4.5rem] opacity-30">{initial}</span>
              </div>
            )}
            <div
              className="pointer-events-none absolute inset-0"
              style={{ background: "linear-gradient(180deg, transparent 52%, rgba(0,0,0,0.86))" }}
            />
            <p
              className={`absolute inset-x-3 bottom-3 whitespace-pre-line font-semibold leading-tight ${compact ? "text-[0.6rem]" : "text-[0.78rem]"}`}
              style={{ letterSpacing: "-0.01em" }}
            >
              {card.signatureLine}
            </p>
          </div>

          {/* archetype */}
          <div className="mt-4 flex items-baseline justify-between">
            <p className="kicker">Character</p>
            <p className={`display ${compact ? "text-[0.9rem]" : "text-[1.15rem]"}`}>{card.archetype}</p>
          </div>

          {/* stats */}
          {!compact && (
            <div className="mt-4 space-y-2">
              {STAT_ORDER.map((key) => (
                <div key={key} className="flex items-center gap-3">
                  <span className="kicker w-[5.5rem] shrink-0" style={{ fontSize: "0.52rem" }}>
                    {key}
                  </span>
                  <span className="relative h-[3px] flex-1 overflow-hidden rounded-full bg-white/10">
                    <span
                      className="absolute inset-y-0 left-0 rounded-full"
                      style={{
                        width: `${card.stats[key]}%`,
                        background: "linear-gradient(90deg, rgba(216,176,114,0.5), rgba(216,176,114,0.95))",
                      }}
                    />
                  </span>
                  <span className="w-7 text-right text-[0.72rem] tabular-nums text-[color:var(--color-muted)]">
                    {card.stats[key]}
                  </span>
                </div>
              ))}
            </div>
          )}

          <footer className="mt-4 flex items-center justify-between border-t border-white/8 pt-3">
            <span className="kicker" style={{ fontSize: "0.5rem" }}>
              Face Card Certified
            </span>
            <span className="kicker" style={{ fontSize: "0.5rem" }}>
              FC
            </span>
          </footer>
        </div>
      </article>
    </div>
  );
}
