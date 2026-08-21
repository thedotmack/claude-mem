"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { getScoreEngine } from "@/lib/audio";
import { tap, thud, tick } from "@/lib/haptics";
import { cancelSpeech, perform, setVoiceEnabled, warmVoices } from "@/lib/speech";
import { GlassButton } from "./Glass";
import EndingCard from "./EndingCard";
import type { Cinematography, ScriptLine } from "@/lib/engine/types";

interface SceneRow {
  id: string;
  seq: number;
  title: string;
  script: { slug: string; lines: ScriptLine[]; question: string };
  cinematography: Cinematography;
  available_choices: { key: string; label: string; kind: string }[];
  selected_choice: { key: string } | null;
  generated_assets: {
    still?: string; video?: string | null; motion?: string;
    voices?: Record<number, { url?: string; speak?: { text: string; delivery: string; voiceHint: string } }>;
    score?: { mode: string; rootHz: number; tempoBpm: number; texture: "pad" | "pulse" | "piano" | "strings" | "sub"; intensity: number };
  };
  status: string;
  is_final: boolean;
}

interface JobRow {
  id: string; status: string; stage: string;
  stages: { name: string; status: string }[];
  error: string | null; sceneId: string | null;
  attempts: number; maxAttempts: number;
}

const MOTION: Record<string, string> = {
  "slow creeping push-in": "kb-push",
  "handheld, restless": "kb-hand",
  "smooth dolly, locked horizon": "kb-drift",
  "slow drift, almost still": "kb-drift",
  "whip pans, snap zooms": "kb-hand",
  "static, locked off": "kb-pull",
  "gentle arc": "kb-drift",
  "rising crane": "kb-crane",
  "steady push, no hesitation": "kb-push",
  "tracking, slightly too fast": "kb-push",
  "slow lateral track": "kb-drift",
};

export default function ScenePlayer({ storyId, title }: { storyId: string; title: string }) {
  const router = useRouter();
  const [scenes, setScenes] = useState<SceneRow[]>([]);
  const [job, setJob] = useState<JobRow | null>(null);
  const [ending, setEnding] = useState<Record<string, unknown> | null>(null);
  const [active, setActive] = useState<SceneRow | null>(null);
  const [visibleLines, setVisibleLines] = useState(0);
  const [showChoices, setShowChoices] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const [started, setStarted] = useState(false);
  const [muted, setMuted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const playToken = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  /* ─────────────────────────────────────────────── data + job polling */

  const load = useCallback(async () => {
    const res = await fetch(`/api/story/${storyId}`, { cache: "no-store" });
    const json = await res.json();
    if (!res.ok || !json.ok) { setError(json.error ?? "Could not load your movie."); return null; }
    setScenes(json.scenes ?? []);
    setJob(json.job ?? null);
    if (json.ending) setEnding(json.ending);
    return json;
  }, [storyId]);

  useEffect(() => { void load(); }, [load]);

  // Poll the job until the next scene is cut and ready.
  useEffect(() => {
    if (!job || job.status === "succeeded" || job.status === "failed") return;
    const t = setTimeout(async () => {
      const res = await fetch(`/api/jobs/${job.id}`, { cache: "no-store" });
      const json = await res.json();
      if (json.ok) {
        setJob(json.job);
        if (json.job.status === "succeeded") await load();
      }
    }, 1400);
    return () => clearTimeout(t);
  }, [job, load]);

  // The scene to play is the newest ready one the player hasn't answered.
  useEffect(() => {
    const ready = scenes.filter((s) => s.status === "ready");
    const next = ready[ready.length - 1];
    if (next && next.id !== active?.id) {
      setActive(next);
      setVisibleLines(0);
      setShowChoices(false);
      setPicked(null);
    }
  }, [scenes, active?.id]);

  /* ──────────────────────────────────────────────────── performance */

  const playScene = useCallback(async (scene: SceneRow) => {
    const token = ++playToken.current;
    const tempo = scene.cinematography?.tempo ?? 1;

    const engine = getScoreEngine();
    if (scene.generated_assets?.score) {
      if (engine.running) void engine.transition(scene.generated_assets.score);
      else void engine.start(scene.generated_assets.score);
    }

    for (let i = 0; i < scene.script.lines.length; i++) {
      if (playToken.current !== token) return;
      setVisibleLines(i + 1);

      const line = scene.script.lines[i];
      const voice = scene.generated_assets?.voices?.[i];

      requestAnimationFrame(() => {
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
      });

      if (line.type === "dialogue" || line.type === "voiceover") {
        await perform(voice, tempo);
        // Even without speech we hold long enough to read the line.
        if (!voice?.url && !voice?.speak) await wait(baseDelay(line) / tempo);
      } else {
        if (line.type === "message") tap();
        await wait(baseDelay(line) / tempo);
      }
    }

    if (playToken.current !== token) return;

    if (scene.is_final) {
      await wait(900);
      await finish();
    } else if (scene.available_choices?.length) {
      await wait(500);
      setShowChoices(true);
      thud();
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!started || !active || active.selected_choice) return;
    void playScene(active);
    return () => { playToken.current++; cancelSpeech(); };
  }, [started, active, playScene]);

  useEffect(() => () => { cancelSpeech(); void getScoreEngine().dispose(); }, []);

  /* ───────────────────────────────────────────────────────── actions */

  function begin() {
    warmVoices();
    setStarted(true);
    tick();
  }

  async function choose(key: string) {
    if (!active || picked) return;
    setPicked(key);
    tap();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/story/${storyId}/choice`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sceneId: active.id, choiceKey: key }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error ?? "That choice didn't land.");

      if (json.done) { await finish(); return; }
      setShowChoices(false);
      setJob({ id: json.jobId, status: "queued", stage: "SCRIPT", stages: [], error: null, sceneId: null, attempts: 0, maxAttempts: 3 });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setPicked(null);
    } finally {
      setBusy(false);
    }
  }

  async function finish() {
    setBusy(true);
    try {
      const res = await fetch(`/api/story/${storyId}/complete`, { method: "POST" });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error ?? "Could not finish your movie.");
      getScoreEngine().stop();
      setEnding(json.ending);
      tick();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  function toggleMute() {
    const next = !muted;
    setMuted(next);
    setVoiceEnabled(!next);
    getScoreEngine().setMuted(next);
    if (next) cancelSpeech();
  }

  /* ───────────────────────────────────────────────────────── render */

  if (ending) {
    return <EndingCard storyId={storyId} ending={ending as never} onReplay={() => router.push("/create")} />;
  }

  const c = active?.cinematography;
  const motionClass = c ? MOTION[c.cameraMove] ?? "kb-drift" : "kb-drift";
  const generating = job && job.status !== "succeeded" && job.status !== "failed";
  const failedHard = job?.status === "failed";

  return (
    <main className="relative min-h-dvh bg-black">
      <div className="stage letterbox">
        {/* ── the frame ─────────────────────────────────────────────── */}
        {active?.generated_assets?.video ? (
          <video
            key={active.id}
            src={active.generated_assets.video}
            className="absolute inset-0 h-full w-full object-cover"
            autoPlay muted={muted} playsInline loop
          />
        ) : active?.generated_assets?.still ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={active.id}
            src={active.generated_assets.still}
            alt=""
            className={`absolute inset-0 h-full w-full object-cover ${started ? motionClass : ""}`}
            style={{ ["--kb-dur" as string]: `${Math.max(14, (active.script.lines.length + 2) * 3.4)}s` }}
          />
        ) : (
          <div className="absolute inset-0" style={{ background: "linear-gradient(180deg,#0A0A0C,#000)" }} />
        )}

        <div
          className="pointer-events-none absolute inset-0"
          style={{
            background: `radial-gradient(120% 80% at 50% 42%, transparent 40%, rgba(0,0,0,${c?.vignette ?? 0.6}))`,
          }}
        />
        <div className="film-grain" style={{ opacity: (c?.grain ?? 0.35) * 0.9 }} />
        {showChoices && <div className="absolute inset-0 bg-black/45 backdrop-blur-[3px] transition-opacity duration-500" />}

        {/* ── HUD ───────────────────────────────────────────────────── */}
        <header className="safe-t absolute inset-x-0 top-0 z-40 flex items-start justify-between px-5 pt-[max(1.25rem,env(safe-area-inset-top))]">
          <div className="min-w-0">
            <p className="kicker truncate">{title}</p>
            {active && <p className="script-slug mt-1 truncate">{active.script.slug}</p>}
          </div>
          <button onClick={toggleMute} className="glass-quiet shrink-0 px-3 py-2 text-[0.62rem] tracking-[0.2em]">
            {muted ? "SOUND OFF" : "SOUND ON"}
          </button>
        </header>

        {/* ── start gate (browsers need a gesture for audio) ─────────── */}
        {!started && active && (
          <div className="absolute inset-0 z-50 flex flex-col items-center justify-center px-8 text-center">
            <div className="materialize glass w-full max-w-sm px-7 py-9">
              <p className="kicker">Your movie is ready</p>
              <h2 className="display mt-3 text-[2rem]">{title}</h2>
              <p className="mt-4 text-[0.86rem] text-[color:var(--color-muted)]">
                Headphones recommended. Your choices change what happens next.
              </p>
              <GlassButton onClick={begin} tone="gold" className="mt-7 w-full">Play</GlassButton>
            </div>
          </div>
        )}

        {/* ── script ────────────────────────────────────────────────── */}
        <div
          ref={scrollRef}
          className="no-scrollbar absolute inset-x-0 bottom-0 z-30 max-h-[62%] overflow-y-auto px-6 pb-[max(6rem,calc(env(safe-area-inset-bottom)+5.5rem))]"
        >
          <div className="flex flex-col gap-3">
            {active?.script.lines.slice(0, visibleLines).map((line, i) => (
              <ScriptLineView key={`${active.id}-${i}`} line={line} />
            ))}
          </div>
        </div>

        {/* ── choices ───────────────────────────────────────────────── */}
        {showChoices && active && (
          <div className="safe-b absolute inset-x-0 bottom-0 z-40 px-5 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
            <p className="display mb-4 text-center text-[1.15rem]">{active.script.question}</p>
            <div className="flex flex-col gap-2.5">
              {active.available_choices.map((ch, i) => (
                <button
                  key={ch.key}
                  onClick={() => choose(ch.key)}
                  disabled={busy}
                  data-picked={picked === ch.key}
                  data-dimmed={picked !== null && picked !== ch.key}
                  className="choice-card glass px-5 py-4 text-left text-[0.9rem] font-semibold tracking-[0.06em]"
                  style={{ animation: "riseIn .55s var(--ease-out) both", animationDelay: `${i * 70}ms` }}
                >
                  {ch.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* ── generation progress ───────────────────────────────────── */}
        {generating && !showChoices && (
          <div className="absolute inset-0 z-40 flex items-center justify-center px-8">
            <div className="glass w-full max-w-xs px-6 py-7">
              <p className="kicker breathe">Your scene is being rendered</p>
              <ul className="mt-5 space-y-2.5">
                {(job?.stages?.length ? job.stages : DEFAULT_STAGES).map((s) => (
                  <li key={s.name} className="flex items-center justify-between text-[0.74rem]">
                    <span
                      className="tracking-[0.16em]"
                      style={{ opacity: s.status === "pending" ? 0.35 : 1 }}
                    >
                      {s.name}
                    </span>
                    <span style={{ opacity: s.status === "pending" ? 0.3 : 0.9 }}>
                      {s.status === "done" ? "✓" : s.status === "running" ? "···" : s.status === "failed" ? "!" : "—"}
                    </span>
                  </li>
                ))}
              </ul>
              {job && job.attempts > 1 && (
                <p className="mt-4 text-[0.7rem] text-[color:var(--color-faint)]">
                  Retrying ({job.attempts}/{job.maxAttempts})…
                </p>
              )}
            </div>
          </div>
        )}

        {/* ── hard failure: story preserved, resumable ──────────────── */}
        {failedHard && (
          <div className="absolute inset-0 z-50 flex items-center justify-center px-8">
            <div className="glass w-full max-w-sm px-6 py-7 text-center">
              <p className="kicker">Generation hit a wall</p>
              <p className="mt-3 text-[0.86rem] text-[color:var(--color-muted)]">
                Your story is saved exactly where you left it. Nothing was lost.
              </p>
              <GlassButton onClick={() => void load()} tone="gold" className="mt-6 w-full">Resume</GlassButton>
              <GlassButton href="/me" className="mt-2 w-full">Back to my movies</GlassButton>
            </div>
          </div>
        )}

        {error && (
          <div className="absolute inset-x-5 bottom-24 z-50">
            <div className="glass-quiet px-4 py-3 text-center text-[0.8rem] text-[#E0836F]">{error}</div>
          </div>
        )}
      </div>
    </main>
  );
}

const DEFAULT_STAGES = [
  { name: "SCRIPT", status: "running" }, { name: "VISUALS", status: "pending" },
  { name: "VOICE", status: "pending" }, { name: "AUDIO", status: "pending" },
  { name: "FINAL CUT", status: "pending" },
];

function baseDelay(line: ScriptLine): number {
  switch (line.type) {
    case "beat": return 900;
    case "title": return 2200;
    case "slug": return 900;
    case "message": return 1700;
    default: {
      const text = "text" in line ? line.text : "";
      return Math.min(6500, 1100 + text.length * 42);
    }
  }
}

function wait(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function ScriptLineView({ line }: { line: ScriptLine }) {
  const base = "rise";
  switch (line.type) {
    case "slug":
      return <p className={`${base} script-slug`}>{line.text}</p>;
    case "action":
      return <p className={`${base} text-[0.94rem] leading-relaxed text-[color:var(--color-paper)]/90`}>{line.text}</p>;
    case "voiceover":
      return (
        <p className={`${base} text-[0.92rem] italic leading-relaxed text-[color:var(--color-muted)]`}>{line.text}</p>
      );
    case "dialogue":
      return (
        <div className={base}>
          <p className="kicker" style={{ fontSize: "0.55rem" }}>{line.who}</p>
          <p className="mt-1 text-[1.02rem] font-medium leading-snug">{line.text}</p>
        </div>
      );
    case "message":
      return (
        <div className={`${base} self-start max-w-[80%]`}>
          <div className="glass-quiet px-4 py-3">
            <p className="kicker" style={{ fontSize: "0.5rem" }}>{line.from}</p>
            <p className="mt-1 text-[0.92rem] font-semibold tracking-[0.02em]">{line.text}</p>
          </div>
        </div>
      );
    case "title":
      return <p className={`${base} display py-2 text-center text-[1.4rem]`}>{line.text}</p>;
    case "beat":
      return <div className={`${base} h-3`} />;
    default:
      return null;
  }
}
