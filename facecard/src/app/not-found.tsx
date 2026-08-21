export default function NotFound() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-black px-6">
      <div className="glass max-w-sm px-7 py-8 text-center">
        <p className="kicker">Cut from the film</p>
        <h1 className="display mt-3 text-[2rem]">404</h1>
        <p className="mt-3 text-[0.9rem] text-[color:var(--color-muted)]">
          This scene doesn&apos;t exist.
        </p>
        <a href="/feed" className="kicker mt-6 inline-block text-[color:var(--color-gold)]">Back to the feed →</a>
      </div>
    </main>
  );
}
