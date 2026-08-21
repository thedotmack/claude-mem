import "server-only";

import { serverEnv } from "@/lib/env";
import { renderFrameSVG, renderPosterSVG, type FrameSpec } from "./render";
import type { CharacterBible, ComposedScene } from "@/lib/engine/types";

/**
 * Provider abstraction layer (spec: "Do not hard-code the application to one AI
 * provider"). Each capability resolves to an adapter at call time based on env.
 * Credentials are read ONLY here, on the server — never shipped to the client.
 *
 * Every adapter reports a `provider`/`model`/`costUsd` triple so the cost
 * control layer can meter usage uniformly.
 */

export interface GenResult<T> {
  data: T;
  provider: string;
  model: string;
  costUsd: number;
  durationMs: number;
  degraded?: boolean;
}

export type Capability = "llm" | "image" | "video" | "voice" | "music" | "moderation";

const now = () => Date.now();

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

/* ══════════════════════════════════════════════════════════════════ LLM */

export interface SceneRewriteInput {
  scene: ComposedScene;
  bible: CharacterBible;
  recentMemory: string[];
}

/**
 * Optional LLM pass that rewrites the composed scene's dialogue in the
 * character's voice. The structure (beats, choices, consequences) always comes
 * from the deterministic engine so the branching logic can never be hallucinated
 * away — the model only gets to change how lines *sound*.
 */
export async function polishScene(input: SceneRewriteInput): Promise<GenResult<ComposedScene>> {
  const cfg = serverEnv.llm;
  const started = now();

  if (cfg.provider === "anthropic" && cfg.anthropicKey) {
    try {
      const data = await withTimeout(anthropicPolish(input, cfg), 20_000, "anthropic");
      return { data, provider: "anthropic", model: cfg.anthropicModel, costUsd: 0.004, durationMs: now() - started };
    } catch {
      // fall through to builtin — a provider outage must never break a story
    }
  }
  if (cfg.provider === "openai" && cfg.openaiKey) {
    try {
      const data = await withTimeout(openaiPolish(input, cfg), 20_000, "openai");
      return { data, provider: "openai", model: cfg.openaiModel, costUsd: 0.002, durationMs: now() - started };
    } catch {
      /* fall through */
    }
  }

  return {
    data: input.scene,
    provider: "builtin",
    model: "narrative-engine",
    costUsd: 0,
    durationMs: now() - started,
    degraded: cfg.provider !== "builtin",
  };
}

function polishPrompt({ scene, bible, recentMemory }: SceneRewriteInput) {
  return `You are the dialogue director for an interactive film. Rewrite ONLY the dialogue and action wording of this scene so it sounds like the character below. Keep every line's type and order identical. Keep it Gen-Z natural but not a meme parade — humour comes from personality, not references.

CHARACTER
name: ${bible.name}
speech: ${bible.speechStyle}
humour: ${bible.humor}
contradictions: ${bible.contradictions.join("; ")}

THINGS THE STORY REMEMBERS
${recentMemory.map((m) => `- ${m}`).join("\n") || "- nothing yet"}

DIRECTION
${scene.cinematography.pacing}; ${scene.cinematography.editing}

SCENE JSON
${JSON.stringify(scene.script.lines)}

Return ONLY a JSON array of the same length, same "type" values, same order.`;
}

async function anthropicPolish(input: SceneRewriteInput, cfg: { anthropicKey: string; anthropicModel: string }) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": cfg.anthropicKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: cfg.anthropicModel,
      max_tokens: 2000,
      messages: [{ role: "user", content: polishPrompt(input) }],
    }),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}`);
  const json = (await res.json()) as { content: { text?: string }[] };
  return mergeLines(input.scene, json.content?.[0]?.text ?? "");
}

async function openaiPolish(input: SceneRewriteInput, cfg: { openaiKey: string; openaiModel: string }) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${cfg.openaiKey}` },
    body: JSON.stringify({
      model: cfg.openaiModel,
      messages: [{ role: "user", content: polishPrompt(input) }],
      max_tokens: 2000,
    }),
  });
  if (!res.ok) throw new Error(`openai ${res.status}`);
  const json = (await res.json()) as { choices: { message: { content: string } }[] };
  return mergeLines(input.scene, json.choices?.[0]?.message?.content ?? "");
}

/** Only accepts a rewrite that preserves the exact line structure. */
function mergeLines(scene: ComposedScene, raw: string): ComposedScene {
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) return scene;
  const parsed = JSON.parse(match[0]) as ComposedScene["script"]["lines"];
  if (!Array.isArray(parsed) || parsed.length !== scene.script.lines.length) return scene;
  for (let i = 0; i < parsed.length; i++) {
    if (parsed[i]?.type !== scene.script.lines[i].type) return scene;
  }
  return { ...scene, script: { ...scene.script, lines: parsed } };
}

/* ════════════════════════════════════════════════════════════════ IMAGE */

export interface FrameRequest extends FrameSpec {
  prompt: string;
}

export async function generateFrame(req: FrameRequest): Promise<GenResult<{ svg?: string; url?: string }>> {
  const cfg = serverEnv.image;
  const started = now();

  if (cfg.provider === "fal" && cfg.falKey) {
    try {
      const url = await withTimeout(falImage(req.prompt, cfg), 45_000, "fal");
      return { data: { url }, provider: "fal", model: cfg.falModel, costUsd: 0.003, durationMs: now() - started };
    } catch { /* fall through to builtin */ }
  }
  if (cfg.provider === "replicate" && cfg.replicateKey) {
    try {
      const url = await withTimeout(replicateImage(req.prompt, cfg), 60_000, "replicate");
      return { data: { url }, provider: "replicate", model: cfg.replicateModel, costUsd: 0.004, durationMs: now() - started };
    } catch { /* fall through to builtin */ }
  }

  return {
    data: { svg: renderFrameSVG(req) },
    provider: "builtin",
    model: "cinematic-frame-renderer",
    costUsd: 0,
    durationMs: now() - started,
    degraded: cfg.provider !== "builtin",
  };
}

export function generatePoster(req: FrameSpec & { title: string; tagline: string }) {
  return renderPosterSVG(req);
}

async function falImage(prompt: string, cfg: { falKey: string; falModel: string }): Promise<string> {
  const res = await fetch(`https://fal.run/${cfg.falModel}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Key ${cfg.falKey}` },
    body: JSON.stringify({ prompt, image_size: "portrait_16_9", num_images: 1 }),
  });
  if (!res.ok) throw new Error(`fal ${res.status}`);
  const json = (await res.json()) as { images?: { url: string }[] };
  const url = json.images?.[0]?.url;
  if (!url) throw new Error("fal: no image");
  return url;
}

async function replicateImage(prompt: string, cfg: { replicateKey: string; replicateModel: string }): Promise<string> {
  const res = await fetch("https://api.replicate.com/v1/predictions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${cfg.replicateKey}`,
      prefer: "wait",
    },
    body: JSON.stringify({ model: cfg.replicateModel, input: { prompt, aspect_ratio: "9:16" } }),
  });
  if (!res.ok) throw new Error(`replicate ${res.status}`);
  const json = (await res.json()) as { output?: string | string[] };
  const out = Array.isArray(json.output) ? json.output[0] : json.output;
  if (!out) throw new Error("replicate: no image");
  return out;
}

/* ════════════════════════════════════════════════════════════════ VIDEO */

export interface ClipRequest { prompt: string; seed: string; durationSeconds: number }

/**
 * Video is the most expensive capability. With no provider configured we return
 * a motion *directive* instead — the player animates the generated still with
 * the camera move the emotion engine asked for (push-in, handheld, crane…),
 * which is real motion driven by real direction rather than a fake video frame.
 */
export async function generateClip(req: ClipRequest): Promise<GenResult<{ url?: string; motion?: string }>> {
  const cfg = serverEnv.video;
  const started = now();

  if (cfg.provider === "fal" && cfg.falKey) {
    try {
      const res = await fetch(`https://fal.run/${cfg.falModel}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Key ${cfg.falKey}` },
        body: JSON.stringify({ prompt: req.prompt, seed: req.seed }),
      });
      if (!res.ok) throw new Error(`fal video ${res.status}`);
      const json = (await res.json()) as { video?: { url: string } };
      if (json.video?.url) {
        return { data: { url: json.video.url }, provider: "fal", model: cfg.falModel, costUsd: 0.25, durationMs: now() - started };
      }
    } catch { /* fall through */ }
  }

  return {
    data: { motion: "directive" },
    provider: "builtin",
    model: "motion-director",
    costUsd: 0,
    durationMs: now() - started,
    degraded: cfg.provider !== "builtin",
  };
}

/* ════════════════════════════════════════════════════════════════ VOICE */

export interface VoiceRequest { text: string; delivery: string; voiceHint: string }

/**
 * With ElevenLabs configured we synthesise real audio. Without it we emit a
 * speech directive the client performs through the Web Speech API — genuine
 * text-to-speech on the device, no key required.
 */
export async function generateVoice(req: VoiceRequest): Promise<GenResult<{ url?: string; speak?: VoiceRequest }>> {
  const cfg = serverEnv.voice;
  const started = now();

  if (cfg.provider === "elevenlabs" && cfg.elevenKey && cfg.elevenVoice) {
    try {
      const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${cfg.elevenVoice}`, {
        method: "POST",
        headers: { "content-type": "application/json", "xi-api-key": cfg.elevenKey },
        body: JSON.stringify({ text: req.text, model_id: "eleven_turbo_v2_5" }),
      });
      if (!res.ok) throw new Error(`elevenlabs ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      return {
        data: { url: `data:audio/mpeg;base64,${buf.toString("base64")}` },
        provider: "elevenlabs", model: "eleven_turbo_v2_5", costUsd: 0.006, durationMs: now() - started,
      };
    } catch { /* fall through */ }
  }

  return {
    data: { speak: req },
    provider: "builtin", model: "web-speech", costUsd: 0, durationMs: now() - started,
    degraded: cfg.provider !== "builtin",
  };
}

/* ════════════════════════════════════════════════════════════════ MUSIC */

export interface ScoreDirective {
  mode: string; rootHz: number; tempoBpm: number;
  texture: "pad" | "pulse" | "piano" | "strings" | "sub";
  intensity: number;
}

/** Procedural score parameters — the client's WebAudio engine performs these. */
export async function generateScore(dominant: string, intensity: number): Promise<GenResult<ScoreDirective>> {
  const started = now();
  const table: Record<string, ScoreDirective> = {
    fear:       { mode: "phrygian", rootHz: 61.7,  tempoBpm: 52, texture: "sub",     intensity },
    anger:      { mode: "locrian",  rootHz: 73.4,  tempoBpm: 92, texture: "sub",     intensity },
    confidence: { mode: "mixolydian", rootHz: 98.0, tempoBpm: 76, texture: "strings", intensity },
    love:       { mode: "lydian",   rootHz: 110.0, tempoBpm: 60, texture: "piano",   intensity },
    chaos:      { mode: "whole",    rootHz: 87.3,  tempoBpm: 104, texture: "pulse",  intensity },
    regret:     { mode: "aeolian",  rootHz: 82.4,  tempoBpm: 48, texture: "pad",     intensity },
    trust:      { mode: "ionian",   rootHz: 98.0,  tempoBpm: 66, texture: "piano",   intensity },
    ambition:   { mode: "dorian",   rootHz: 92.5,  tempoBpm: 88, texture: "pulse",   intensity },
    courage:    { mode: "ionian",   rootHz: 110.0, tempoBpm: 80, texture: "strings", intensity },
    risk:       { mode: "harmonic", rootHz: 77.8,  tempoBpm: 98, texture: "pulse",   intensity },
    loyalty:    { mode: "aeolian",  rootHz: 87.3,  tempoBpm: 64, texture: "strings", intensity },
  };
  return {
    data: table[dominant] ?? table.confidence,
    provider: "builtin", model: "procedural-score", costUsd: 0, durationMs: now() - started,
  };
}

/* ═══════════════════════════════════════════════════════════ MODERATION */

const BLOCKED = [
  /\b(kill|hurt|harm)\s+(yourself|myself)\b/i,
  /\bsuicide\b/i,
  /\bchild\s*(porn|sexual)\b/i,
  /\b(rape|molest)\b/i,
];

export async function moderate(text: string): Promise<GenResult<{ allowed: boolean; reason?: string }>> {
  const cfg = serverEnv.moderation;
  const started = now();

  if (cfg.provider === "openai" && cfg.openaiKey) {
    try {
      const res = await fetch("https://api.openai.com/v1/moderations", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${cfg.openaiKey}` },
        body: JSON.stringify({ model: "omni-moderation-latest", input: text }),
      });
      if (res.ok) {
        const json = (await res.json()) as { results: { flagged: boolean }[] };
        const flagged = json.results?.[0]?.flagged ?? false;
        return {
          data: { allowed: !flagged, reason: flagged ? "flagged by moderation" : undefined },
          provider: "openai", model: "omni-moderation-latest", costUsd: 0, durationMs: now() - started,
        };
      }
    } catch { /* fall through to ruleset */ }
  }

  const hit = BLOCKED.find((re) => re.test(text));
  return {
    data: { allowed: !hit, reason: hit ? "blocked by content rules" : undefined },
    provider: "builtin", model: "ruleset", costUsd: 0, durationMs: now() - started,
  };
}

/** Reported on the admin screen so operators can see what's actually wired. */
export function providerStatus(): Record<Capability, { provider: string; live: boolean }> {
  const e = serverEnv;
  return {
    llm: { provider: e.llm.provider, live: Boolean((e.llm.provider === "anthropic" && e.llm.anthropicKey) || (e.llm.provider === "openai" && e.llm.openaiKey)) },
    image: { provider: e.image.provider, live: Boolean((e.image.provider === "fal" && e.image.falKey) || (e.image.provider === "replicate" && e.image.replicateKey)) },
    video: { provider: e.video.provider, live: Boolean(e.video.provider === "fal" && e.video.falKey) },
    voice: { provider: e.voice.provider, live: Boolean(e.voice.provider === "elevenlabs" && e.voice.elevenKey && e.voice.elevenVoice) },
    music: { provider: e.music.provider, live: false },
    moderation: { provider: e.moderation.provider, live: Boolean(e.moderation.provider === "openai" && e.moderation.openaiKey) },
  };
}
