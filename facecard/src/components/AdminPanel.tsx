"use client";

import { useMemo, useState } from "react";
import { GlassButton } from "./Glass";

interface Setting { key: string; value: Record<string, unknown> }
interface Usage { provider: string; kind: string; est_cost_usd: number; created_at: string }
interface Job { id: string; status: string; stage: string; error: string | null; created_at: string }

export default function AdminPanel({
  settings, usage, jobs, providers, totals,
}: {
  settings: Setting[];
  usage: Usage[];
  jobs: Job[];
  providers: Record<string, { provider: string; live: boolean }>;
  totals: { users: number; movies: number };
}) {
  const [draft, setDraft] = useState(() =>
    Object.fromEntries(settings.map((s) => [s.key, JSON.stringify(s.value, null, 2)])),
  );
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const spend = useMemo(() => usage.reduce((a, u) => a + Number(u.est_cost_usd ?? 0), 0), [usage]);
  const failed = jobs.filter((j) => j.status === "failed").length;

  async function save(key: string) {
    setBusy(true);
    setStatus(null);
    try {
      const value = JSON.parse(draft[key]);
      const res = await fetch("/api/admin", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key, value }),
      });
      const json = await res.json();
      setStatus(json.ok ? `Saved ${key}.` : json.error ?? "Save failed.");
    } catch {
      setStatus("That isn't valid JSON.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="relative min-h-dvh bg-black pb-20">
      <div className="relative z-10 mx-auto w-full max-w-3xl px-5 pt-[max(1.5rem,env(safe-area-inset-top))]">
        <header className="flex items-center justify-between">
          <h1 className="display text-[1.6rem]">OPERATIONS</h1>
          <a href="/feed" className="kicker">← Feed</a>
        </header>

        <section className="mt-7 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Users" value={totals.users} />
          <Stat label="Movies" value={totals.movies} />
          <Stat label="Est. spend" value={`$${spend.toFixed(3)}`} />
          <Stat label="Failed jobs" value={failed} tone={failed > 0 ? "warn" : undefined} />
        </section>

        <section className="mt-9">
          <p className="kicker">Provider wiring</p>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {Object.entries(providers).map(([cap, p]) => (
              <div key={cap} className="glass-quiet flex items-center justify-between px-4 py-3">
                <span className="text-[0.82rem] font-semibold uppercase tracking-[0.1em]">{cap}</span>
                <span className="text-[0.72rem]" style={{ color: p.live ? "var(--color-gold)" : "var(--color-muted)" }}>
                  {p.provider}{p.live ? " · live" : " · built-in"}
                </span>
              </div>
            ))}
          </div>
        </section>

        <section className="mt-9">
          <p className="kicker">Controls</p>
          {settings.map((s) => (
            <div key={s.key} className="glass mt-3 px-5 py-4">
              <div className="flex items-center justify-between">
                <span className="text-[0.85rem] font-semibold uppercase tracking-[0.12em]">{s.key}</span>
                <GlassButton onClick={() => save(s.key)} disabled={busy}>Save</GlassButton>
              </div>
              <textarea
                value={draft[s.key] ?? ""}
                onChange={(e) => setDraft((d) => ({ ...d, [s.key]: e.target.value }))}
                rows={s.key === "limits" ? 7 : 6}
                spellCheck={false}
                className="mt-3 w-full rounded-xl border border-white/12 bg-black/40 p-3 font-mono text-[0.76rem] focus:border-white/28 focus:outline-none"
              />
            </div>
          ))}
          {status && <p className="mt-3 text-[0.82rem] text-[color:var(--color-gold)]">{status}</p>}
        </section>

        <section className="mt-9">
          <p className="kicker">Recent jobs</p>
          <div className="mt-3 flex flex-col gap-1.5">
            {jobs.map((j) => (
              <div key={j.id} className="glass-quiet flex items-center justify-between px-4 py-2.5 text-[0.74rem]">
                <span className="font-mono opacity-60">{j.id.slice(0, 8)}</span>
                <span>{j.stage}</span>
                <span style={{ color: j.status === "failed" ? "#E0836F" : j.status === "succeeded" ? "var(--color-gold)" : undefined }}>
                  {j.status}
                </span>
              </div>
            ))}
            {jobs.length === 0 && <p className="text-[0.84rem] text-[color:var(--color-muted)]">No jobs yet.</p>}
          </div>
        </section>
      </div>
    </main>
  );
}

function Stat({ label, value, tone }: { label: string; value: string | number; tone?: "warn" }) {
  return (
    <div className="glass px-4 py-4">
      <p className="display text-[1.5rem]" style={{ color: tone === "warn" ? "#E0836F" : undefined }}>{value}</p>
      <p className="kicker mt-1" style={{ fontSize: "0.5rem" }}>{label}</p>
    </div>
  );
}
