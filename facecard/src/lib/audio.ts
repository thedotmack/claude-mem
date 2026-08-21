"use client";

/**
 * Procedural score engine. Performs the ScoreDirective the server produced from
 * the scene's dominant emotion — real generative audio via WebAudio, so the
 * music genuinely changes with the character's emotional state.
 */

export interface ScoreDirective {
  mode: string;
  rootHz: number;
  tempoBpm: number;
  texture: "pad" | "pulse" | "piano" | "strings" | "sub";
  intensity: number;
}

const SCALES: Record<string, number[]> = {
  ionian: [0, 2, 4, 5, 7, 9, 11],
  aeolian: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  locrian: [0, 1, 3, 5, 6, 8, 10],
  harmonic: [0, 2, 3, 5, 7, 8, 11],
  whole: [0, 2, 4, 6, 8, 10],
};

const semis = (root: number, n: number) => root * Math.pow(2, n / 12);

export class ScoreEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private drones: OscillatorNode[] = [];
  private step = 0;
  private directive: ScoreDirective | null = null;
  private muted = false;

  get running() { return this.timer !== null; }

  /** Must be called from a user gesture — browsers block autoplay otherwise. */
  async start(directive: ScoreDirective) {
    this.directive = directive;
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") await this.ctx.resume();

    this.stopVoices();
    this.buildDrone();
    this.fadeTo(this.muted ? 0 : 0.16 + directive.intensity * 0.1, 2.4);

    if (this.timer) clearInterval(this.timer);
    const beatMs = (60_000 / directive.tempoBpm) * 2;
    this.timer = setInterval(() => this.tick(), beatMs);
  }

  /** Cross-fades to a new emotional state without restarting the context. */
  async transition(directive: ScoreDirective) {
    if (!this.ctx) return this.start(directive);
    this.fadeTo(0.02, 0.9);
    setTimeout(() => void this.start(directive), 950);
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    const target = muted ? 0 : 0.16 + (this.directive?.intensity ?? 0.5) * 0.1;
    this.fadeTo(target, 0.4);
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.fadeTo(0, 1.2);
    setTimeout(() => this.stopVoices(), 1300);
  }

  async dispose() {
    this.stop();
    setTimeout(() => { void this.ctx?.close(); this.ctx = null; this.master = null; }, 1400);
  }

  private fadeTo(value: number, seconds: number) {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setValueAtTime(Math.max(0.0001, this.master.gain.value), t);
    this.master.gain.exponentialRampToValueAtTime(Math.max(0.0001, value), t + seconds);
  }

  private stopVoices() {
    this.drones.forEach((o) => { try { o.stop(); } catch { /* already stopped */ } });
    this.drones = [];
  }

  /** Sustained bed — the emotional floor of the scene. */
  private buildDrone() {
    if (!this.ctx || !this.master || !this.directive) return;
    const { rootHz, texture, intensity } = this.directive;

    const filter = this.ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = texture === "sub" ? 320 : 900 + intensity * 1400;
    filter.Q.value = texture === "pulse" ? 6 : 1.2;
    filter.connect(this.master);

    const partials = texture === "strings" ? [1, 1.5, 2, 3] : texture === "sub" ? [0.5, 1] : [1, 2];
    partials.forEach((mult, i) => {
      const osc = this.ctx!.createOscillator();
      osc.type = texture === "piano" ? "triangle" : texture === "sub" ? "sine" : "sawtooth";
      osc.frequency.value = rootHz * mult;
      osc.detune.value = (i - 1) * 6;

      const g = this.ctx!.createGain();
      g.gain.value = (texture === "sub" ? 0.3 : 0.11) / (i + 1);

      // Slow LFO keeps the bed alive rather than static.
      const lfo = this.ctx!.createOscillator();
      const lfoGain = this.ctx!.createGain();
      lfo.frequency.value = 0.05 + i * 0.03;
      lfoGain.gain.value = g.gain.value * 0.4;
      lfo.connect(lfoGain).connect(g.gain);
      lfo.start();

      osc.connect(g).connect(filter);
      osc.start();
      this.drones.push(osc, lfo);
    });
  }

  /** Melodic/rhythmic events on top of the bed. */
  private tick() {
    if (!this.ctx || !this.master || !this.directive) return;
    const { mode, rootHz, texture, intensity } = this.directive;
    const scale = SCALES[mode] ?? SCALES.aeolian;

    // Deterministic-ish wandering melody so it feels composed, not random.
    this.step += 1;
    const degree = scale[(this.step * 3) % scale.length];
    const octave = texture === "sub" ? 1 : this.step % 7 === 0 ? 3 : 2;
    const freq = semis(rootHz * octave, degree);

    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = texture === "piano" ? "triangle" : texture === "pulse" ? "square" : "sine";
    osc.frequency.value = freq;

    const g = this.ctx.createGain();
    const peak = (texture === "pulse" ? 0.09 : 0.055) * (0.5 + intensity);
    const dur = texture === "pulse" ? 0.22 : 2.6;

    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(peak, now + (texture === "piano" ? 0.01 : 0.35));
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);

    osc.connect(g).connect(this.master);
    osc.start(now);
    osc.stop(now + dur + 0.1);
  }
}

let shared: ScoreEngine | null = null;
export function getScoreEngine() {
  if (!shared) shared = new ScoreEngine();
  return shared;
}
