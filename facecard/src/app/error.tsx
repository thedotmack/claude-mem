"use client";

export default function Error({ reset }: { error: Error; reset: () => void }) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-black px-6">
      <div className="glass max-w-sm px-7 py-8 text-center">
        <p className="kicker">Something broke</p>
        <p className="mt-3 text-[0.9rem] text-[color:var(--color-muted)]">
          Your progress is saved. Nothing was lost.
        </p>
        <button onClick={reset} className="choice-card glass mt-6 w-full px-6 py-3.5 text-[0.78rem] uppercase tracking-[0.16em]">
          Try again
        </button>
        <a href="/feed" className="kicker mt-4 inline-block opacity-70">Back to feed</a>
      </div>
    </main>
  );
}
