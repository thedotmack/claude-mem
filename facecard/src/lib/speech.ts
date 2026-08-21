"use client";

/**
 * Voice performance. When the server returned synthesised audio we play that;
 * otherwise we perform the speech directive with the device's own TTS, which is
 * real spoken dialogue with no API key required.
 */

export interface VoiceAsset {
  url?: string;
  speak?: { text: string; delivery: string; voiceHint: string };
}

let enabled = true;
let currentAudio: HTMLAudioElement | null = null;

export function setVoiceEnabled(on: boolean) {
  enabled = on;
  if (!on) cancelSpeech();
}

export function cancelSpeech() {
  try { window.speechSynthesis?.cancel(); } catch { /* unsupported */ }
  if (currentAudio) { currentAudio.pause(); currentAudio = null; }
}

function pickVoice(hint: string): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis?.getVoices?.() ?? [];
  if (!voices.length) return null;
  const english = voices.filter((v) => v.lang?.startsWith("en"));
  const pool = english.length ? english : voices;
  // Stable per-character voice so the same person sounds the same all film.
  let h = 0;
  for (let i = 0; i < hint.length; i++) h = (h * 31 + hint.charCodeAt(i)) >>> 0;
  return pool[h % pool.length] ?? null;
}

/** Resolves when the line finishes (or immediately when voice is off). */
export function perform(asset: VoiceAsset | undefined, tempo: number): Promise<void> {
  if (!enabled || !asset) return Promise.resolve();

  if (asset.url) {
    return new Promise((resolve) => {
      const audio = new Audio(asset.url);
      currentAudio = audio;
      audio.onended = () => resolve();
      audio.onerror = () => resolve();
      audio.play().catch(() => resolve());
    });
  }

  if (!asset.speak || typeof window === "undefined" || !window.speechSynthesis) return Promise.resolve();

  return new Promise((resolve) => {
    try {
      const u = new SpeechSynthesisUtterance(asset.speak!.text);
      const voice = pickVoice(asset.speak!.voiceHint);
      if (voice) u.voice = voice;
      // Delivery follows the scene's pacing directive.
      u.rate = Math.max(0.6, Math.min(1.5, 0.94 * tempo));
      u.pitch = asset.speak!.voiceHint === "narrator" ? 0.85 : 1;
      u.volume = 0.95;
      u.onend = () => resolve();
      u.onerror = () => resolve();
      window.speechSynthesis.speak(u);
      // Safety net: never let a stuck utterance freeze the movie.
      setTimeout(resolve, Math.min(14_000, 1400 + asset.speak!.text.length * 75));
    } catch {
      resolve();
    }
  });
}

/** Chrome populates voices asynchronously. */
export function warmVoices() {
  try { window.speechSynthesis?.getVoices(); } catch { /* unsupported */ }
}
