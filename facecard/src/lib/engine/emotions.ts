import { EMOTION_KEYS, type Cinematography, type EmotionDelta, type EmotionKey, type Emotions } from "./types";

export const NEUTRAL = 50;

export function baseEmotions(): Emotions {
  return EMOTION_KEYS.reduce((acc, k) => ({ ...acc, [k]: NEUTRAL }), {} as Emotions);
}

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

export function applyDelta(current: Emotions, delta: EmotionDelta): Emotions {
  const next = { ...current };
  for (const key of EMOTION_KEYS) {
    const d = delta[key];
    if (typeof d === "number") next[key] = clamp(next[key] + d);
  }
  return next;
}

export function normalize(partial: Partial<Emotions> | null | undefined): Emotions {
  const out = baseEmotions();
  if (!partial) return out;
  for (const key of EMOTION_KEYS) {
    const v = partial[key];
    if (typeof v === "number" && Number.isFinite(v)) out[key] = clamp(v);
  }
  return out;
}

/**
 * The single emotion currently steering the direction of the movie. We look at
 * deviation from neutral so a character who is merely "average scared" does not
 * hijack the whole scene.
 */
export function dominantEmotion(e: Emotions): EmotionKey {
  let best: EmotionKey = "confidence";
  let bestScore = -Infinity;
  for (const key of EMOTION_KEYS) {
    // Regret and fear read strongly on screen even at lower absolute values.
    const weight = key === "fear" || key === "anger" || key === "chaos" || key === "regret" ? 1.15 : 1;
    const score = (e[key] - NEUTRAL) * weight;
    if (score > bestScore) {
      bestScore = score;
      best = key;
    }
  }
  return best;
}

/** How far the character has travelled — used for the ending arc card. */
export function emotionShift(from: Emotions, to: Emotions) {
  return EMOTION_KEYS.map((key) => ({ key, from: from[key], to: to[key], delta: to[key] - from[key] }))
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
}

interface Look {
  framing: string; cameraMove: string; lighting: string; pacing: string;
  editing: string; sound: string; music: string;
  palette: Cinematography["palette"];
  grain: number; vignette: number; shake: number; tempo: number;
}

/**
 * Spec §9 — emotion drives cinematography. Palettes stay filmic and desaturated
 * on purpose: deep blacks with one warm or cold accent, never RGB gaming colour.
 */
const LOOKS: Record<EmotionKey, Look> = {
  fear: {
    framing: "tight close-up, headroom crushed", cameraMove: "slow creeping push-in",
    lighting: "single hard source, everything else falls into black",
    pacing: "long pauses between lines", editing: "hold the cut too long",
    sound: "room tone, a heartbeat under everything", music: "one sustained low string",
    palette: { base: "#070A0F", accent: "#4A5A6B", glow: "#7FA0B8", fog: "#0D1620" },
    grain: 0.55, vignette: 0.78, shake: 0.06, tempo: 0.72,
  },
  anger: {
    framing: "punched-in close, off-centre", cameraMove: "handheld, restless",
    lighting: "hot key from below, hard shadows", pacing: "overlapping, no air",
    editing: "rapid cuts on movement", sound: "low bass pressure, clipped room",
    music: "distorted sub-bass pulse",
    palette: { base: "#100604", accent: "#7A2A1E", glow: "#C4552F", fog: "#1C0A06" },
    grain: 0.45, vignette: 0.6, shake: 0.32, tempo: 1.28,
  },
  confidence: {
    framing: "wide, centred, room to move", cameraMove: "smooth dolly, locked horizon",
    lighting: "clean key with a warm rim", pacing: "unhurried, in control",
    editing: "let shots breathe", sound: "clear and present",
    music: "steady low brass with a rising figure",
    palette: { base: "#0A0908", accent: "#8A6A32", glow: "#D8B072", fog: "#16120C" },
    grain: 0.28, vignette: 0.42, shake: 0.02, tempo: 1.0,
  },
  love: {
    framing: "intimate two-shot, shallow focus", cameraMove: "slow drift, almost still",
    lighting: "warm practicals, soft falloff", pacing: "slower than comfortable",
    editing: "linger after the line lands", sound: "close and quiet, breath audible",
    music: "single piano, lots of space",
    palette: { base: "#0F0709", accent: "#7E3A45", glow: "#D9899A", fog: "#1A0C10" },
    grain: 0.3, vignette: 0.5, shake: 0.01, tempo: 0.82,
  },
  chaos: {
    framing: "dutch angle, subject crowded out", cameraMove: "whip pans, snap zooms",
    lighting: "clashing sources, nothing motivated", pacing: "comedic timing, wrong beats",
    editing: "cut where you should not", sound: "sudden silence, then everything",
    music: "the track switches mid-scene",
    palette: { base: "#0A0710", accent: "#6B3A78", glow: "#B07FD0", fog: "#140C1C" },
    grain: 0.5, vignette: 0.55, shake: 0.24, tempo: 1.18,
  },
  regret: {
    framing: "wide, subject small in frame", cameraMove: "static, locked off",
    lighting: "flat overcast, no highlights", pacing: "minimal dialogue, long takes",
    editing: "one shot, let it hurt", sound: "environmental only",
    music: "held pad, barely there",
    palette: { base: "#08090B", accent: "#47505C", glow: "#8892A0", fog: "#101318" },
    grain: 0.42, vignette: 0.62, shake: 0.0, tempo: 0.7,
  },
  trust: {
    framing: "level eyeline, balanced two-shot", cameraMove: "gentle arc",
    lighting: "soft even key", pacing: "conversational",
    editing: "clean shot-reverse", sound: "warm and open", music: "quiet guitar figure",
    palette: { base: "#080A0A", accent: "#3E5F58", glow: "#86B2A6", fog: "#0F1614" },
    grain: 0.3, vignette: 0.45, shake: 0.02, tempo: 0.95,
  },
  ambition: {
    framing: "low angle, subject owns the frame", cameraMove: "rising crane",
    lighting: "cold key, glass and steel", pacing: "forward, never idle",
    editing: "match cuts on motion", sound: "city hum, distant sirens",
    music: "arpeggiated synth building",
    palette: { base: "#06080C", accent: "#35506E", glow: "#7FA6D4", fog: "#0C1220" },
    grain: 0.32, vignette: 0.48, shake: 0.05, tempo: 1.08,
  },
  courage: {
    framing: "medium, shoulders squared", cameraMove: "steady push, no hesitation",
    lighting: "strong contrast, clean edges", pacing: "decisive",
    editing: "cut on the decision", sound: "everything drops out for one beat",
    music: "single drum entering",
    palette: { base: "#0A0806", accent: "#6E5228", glow: "#C8A05C", fog: "#141008" },
    grain: 0.3, vignette: 0.44, shake: 0.06, tempo: 1.05,
  },
  risk: {
    framing: "over-shoulder, something in the way", cameraMove: "tracking, slightly too fast",
    lighting: "hard side light, half the face gone", pacing: "clipped",
    editing: "cut early, withhold information", sound: "high tension bed",
    music: "ticking pulse under the scene",
    palette: { base: "#0B0709", accent: "#6E2F3E", glow: "#C06B80", fog: "#150A0F" },
    grain: 0.4, vignette: 0.58, shake: 0.16, tempo: 1.15,
  },
  loyalty: {
    framing: "shared frame, nobody isolated", cameraMove: "slow lateral track",
    lighting: "warm tungsten practicals", pacing: "patient",
    editing: "hold on the listener, not the speaker", sound: "close, domestic",
    music: "low strings, unresolved",
    palette: { base: "#0A0806", accent: "#5C4A2C", glow: "#B29A6A", fog: "#120E0A" },
    grain: 0.34, vignette: 0.5, shake: 0.02, tempo: 0.92,
  },
};

export function cinematographyFor(emotions: Emotions): Cinematography {
  const dominant = dominantEmotion(emotions);
  const look = LOOKS[dominant];
  // Intensity scales the render controls so a mildly angry scene is not a riot.
  const intensity = Math.max(0.35, Math.min(1, (emotions[dominant] - NEUTRAL) / 40 + 0.5));
  return {
    dominant,
    framing: look.framing,
    cameraMove: look.cameraMove,
    lighting: look.lighting,
    pacing: look.pacing,
    editing: look.editing,
    sound: look.sound,
    music: look.music,
    palette: look.palette,
    grain: Number((look.grain * intensity).toFixed(3)),
    vignette: Number((look.vignette * (0.6 + intensity * 0.4)).toFixed(3)),
    shake: Number((look.shake * intensity).toFixed(3)),
    tempo: Number((1 + (look.tempo - 1) * intensity).toFixed(3)),
  };
}

export const EMOTION_LABEL: Record<EmotionKey, string> = {
  confidence: "Confidence", fear: "Fear", trust: "Trust", anger: "Anger",
  love: "Love", loyalty: "Loyalty", ambition: "Ambition", courage: "Courage",
  risk: "Risk", chaos: "Chaos", regret: "Regret",
};
