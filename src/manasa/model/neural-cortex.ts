// SPDX-License-Identifier: Apache-2.0

import {
  COGNITIVE_INTENTS,
  type AffectPrediction,
  type CognitiveIntent,
  type IntentScore,
  type NeuralForwardResult,
  type NeuralModelStats,
  type SupportedLanguage,
  type TrainingEpochMetric,
  type TrainingSample,
} from '../types.js';
import { analyzeLanguage, encodeTextFeatures, INPUT_FEATURE_DIM } from './tokenizer.js';
import { INITIAL_TRAINING_CORPUS, INTENT_LABELS } from './training-corpus.js';

export interface PersistenceAdapter {
  load: () => string | null;
  save: (json: string) => void;
}

const EMBED_DIM = 96;
const GATED_DIM = 96;
const BOTTLENECK_DIM = 64;
const NUM_INTENTS = COGNITIVE_INTENTS.length; // 14
const AFFECT_DIM = 4;

interface ParameterBuffer {
  w: Float64Array;
  m: Float64Array;
  v: Float64Array;
}

interface SerializedCheckpoint {
  version: number;
  trainedEpochs: number;
  onlineUpdates: number;
  adamStep: number;
  history: TrainingEpochMetric[];
  customSamples: TrainingSample[];
  weights: Record<string, number[]>;
}

/**
 * Deterministic Mulberry32 PRNG for reproducible Xavier/He neural initialization.
 */
function createSeededRng(seed = 421337): () => number {
  let state = seed >>> 0;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sigmoid(x: number): number {
  if (x >= 0) {
    const z = Math.exp(-x);
    return 1 / (1 + z);
  }
  const z = Math.exp(x);
  return z / (1 + z);
}

function l2Norm(arr: Float64Array): number {
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += arr[i] * arr[i];
  return Math.sqrt(s);
}

/**
 * MANASA-1 Neural Cortex:
 * From-scratch Multi-Layer Gated Residual Neural Network with Dual Heads:
 *   Input(384) -> Dense+LeakyReLU(96) -> GatedContextResidual(96) -> TanhBottleneck(64)
 *     ├── Softmax Intent Classifier (14 cognitive intents)
 *     └── Affective Appraisal Head (4 continuous affective dimensions)
 * Trained via exact analytical backpropagation + AdamW optimizer.
 */
export class ManasaNeuralCortex {
  private params: Record<string, ParameterBuffer>;
  private adamStep = 0;
  private trainedEpochs = 0;
  private onlineUpdates = 0;
  private history: TrainingEpochMetric[] = [];
  private customSamples: TrainingSample[] = [];
  private storage: PersistenceAdapter | null;

  constructor(storage?: PersistenceAdapter | null, initialEpochs = 38) {
    this.storage = storage ?? null;
    const rng = createSeededRng(20261026);

    const initMatrix = (rows: number, cols: number, scale: number): ParameterBuffer => {
      const size = rows * cols;
      const w = new Float64Array(size);
      for (let i = 0; i < size; i++) {
        // Box-Muller Gaussian * Xavier/He scale
        const u1 = Math.max(1e-9, rng());
        const u2 = rng();
        const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
        w[i] = z * scale;
      }
      return { w, m: new Float64Array(size), v: new Float64Array(size) };
    };

    const initBias = (size: number, fill = 0): ParameterBuffer => {
      const w = new Float64Array(size);
      if (fill !== 0) w.fill(fill);
      return { w, m: new Float64Array(size), v: new Float64Array(size) };
    };

    this.params = {
      W1: initMatrix(EMBED_DIM, INPUT_FEATURE_DIM, Math.sqrt(2 / (INPUT_FEATURE_DIM + EMBED_DIM))),
      b1: initBias(EMBED_DIM),
      Wc: initMatrix(GATED_DIM, EMBED_DIM, Math.sqrt(1 / EMBED_DIM)),
      bc: initBias(GATED_DIM),
      Wg: initMatrix(GATED_DIM, EMBED_DIM, Math.sqrt(1 / EMBED_DIM)),
      bg: initBias(GATED_DIM, -0.2),
      W3: initMatrix(BOTTLENECK_DIM, GATED_DIM, Math.sqrt(2 / (GATED_DIM + BOTTLENECK_DIM))),
      b3: initBias(BOTTLENECK_DIM),
      W_intent: initMatrix(NUM_INTENTS, BOTTLENECK_DIM, Math.sqrt(2 / (BOTTLENECK_DIM + NUM_INTENTS))),
      b_intent: initBias(NUM_INTENTS),
      W_affect: initMatrix(AFFECT_DIM, BOTTLENECK_DIM, Math.sqrt(1 / BOTTLENECK_DIM)),
      b_affect: initBias(AFFECT_DIM),
    };

    if (this.storage) {
      const raw = this.storage.load();
      if (raw && this.loadFromJson(raw)) return;
    }

    // Cold boot: train over the trilingual corpus
    this.trainEpochs(initialEpochs, 0.014, false);
    this.saveCheckpoint();
  }

  public getTotalParameters(): number {
    let total = 0;
    for (const buf of Object.values(this.params)) {
      total += buf.w.length;
    }
    return total;
  }

  private forwardInternal(x: Float64Array) {
    const { W1, b1, Wc, bc, Wg, bg, W3, b3, W_intent, b_intent, W_affect, b_affect } = this.params;

    // Layer 1: z1 = W1 * x + b1, h1 = LeakyReLU(z1)
    const z1 = new Float64Array(EMBED_DIM);
    const h1 = new Float64Array(EMBED_DIM);
    for (let i = 0; i < EMBED_DIM; i++) {
      let sum = b1.w[i];
      const rowOffset = i * INPUT_FEATURE_DIM;
      for (let j = 0; j < INPUT_FEATURE_DIM; j++) {
        const xj = x[j];
        if (xj !== 0) sum += W1.w[rowOffset + j] * xj;
      }
      z1[i] = sum;
      h1[i] = sum > 0 ? sum : 0.1 * sum;
    }

    // Layer 2: Gated Prefrontal Residual h2 = h1 + sigmoid(Wg*h1 + bg) * tanh(Wc*h1 + bc)
    const c = new Float64Array(GATED_DIM);
    const g = new Float64Array(GATED_DIM);
    const h2 = new Float64Array(GATED_DIM);
    for (let i = 0; i < GATED_DIM; i++) {
      let sumC = bc.w[i];
      let sumG = bg.w[i];
      const rowOffset = i * EMBED_DIM;
      for (let j = 0; j < EMBED_DIM; j++) {
        const hj = h1[j];
        sumC += Wc.w[rowOffset + j] * hj;
        sumG += Wg.w[rowOffset + j] * hj;
      }
      const ci = Math.tanh(sumC);
      const gi = sigmoid(sumG);
      c[i] = ci;
      g[i] = gi;
      h2[i] = h1[i] + gi * ci;
    }

    // Layer 3: Cortical Bottleneck h3 = tanh(W3 * h2 + b3)
    const h3 = new Float64Array(BOTTLENECK_DIM);
    for (let i = 0; i < BOTTLENECK_DIM; i++) {
      let sum = b3.w[i];
      const rowOffset = i * GATED_DIM;
      for (let j = 0; j < GATED_DIM; j++) {
        sum += W3.w[rowOffset + j] * h2[j];
      }
      h3[i] = Math.tanh(sum);
    }

    // Head A: Softmax Intent Logits
    const logits = new Float64Array(NUM_INTENTS);
    let maxLogit = -Infinity;
    for (let k = 0; k < NUM_INTENTS; k++) {
      let sum = b_intent.w[k];
      const rowOffset = k * BOTTLENECK_DIM;
      for (let j = 0; j < BOTTLENECK_DIM; j++) {
        sum += W_intent.w[rowOffset + j] * h3[j];
      }
      logits[k] = sum;
      if (sum > maxLogit) maxLogit = sum;
    }

    const probs = new Float64Array(NUM_INTENTS);
    let expSum = 0;
    const TEMPERATURE = 1.35;
    for (let k = 0; k < NUM_INTENTS; k++) {
      const e = Math.exp((logits[k] - maxLogit) / TEMPERATURE);
      probs[k] = e;
      expSum += e;
    }
    for (let k = 0; k < NUM_INTENTS; k++) {
      probs[k] /= expSum;
    }

    // Head B: Affective Appraisal [valence(-1..1), arousal(0..1), warmth(0..1), curiosity(0..1)]
    const affectOut = new Float64Array(AFFECT_DIM);
    for (let a = 0; a < AFFECT_DIM; a++) {
      let sum = b_affect.w[a];
      const rowOffset = a * BOTTLENECK_DIM;
      for (let j = 0; j < BOTTLENECK_DIM; j++) {
        sum += W_affect.w[rowOffset + j] * h3[j];
      }
      affectOut[a] = a === 0 ? Math.tanh(sum) : sigmoid(sum);
    }

    return { z1, h1, c, g, h2, h3, probs, affectOut };
  }

  public predict(text: string): NeuralForwardResult {
    const langInfo = analyzeLanguage(text);
    const x = encodeTextFeatures(text, langInfo.normalizedTokens, langInfo.detected);
    const { h1, h2, h3, probs, affectOut } = this.forwardInternal(x);

    const intentRanking: IntentScore[] = COGNITIVE_INTENTS.map((intent, idx) => ({
      intent,
      probability: Number(probs[idx].toFixed(4)),
      labelEn: INTENT_LABELS[intent].en,
      labelSi: INTENT_LABELS[intent].si,
    })).sort((a, b) => b.probability - a.probability);

    let entropy = 0;
    for (let k = 0; k < NUM_INTENTS; k++) {
      if (probs[k] > 1e-12) entropy -= probs[k] * Math.log2(probs[k]);
    }

    const affect: AffectPrediction = {
      valence: Number(affectOut[0].toFixed(3)),
      arousal: Number(affectOut[1].toFixed(3)),
      warmth: Number(affectOut[2].toFixed(3)),
      curiosity: Number(affectOut[3].toFixed(3)),
    };

    return {
      topIntent: intentRanking[0].intent,
      confidence: intentRanking[0].probability,
      entropy: Number(entropy.toFixed(3)),
      intentRanking,
      affect,
      cortex64: Array.from(h3, v => Number(v.toFixed(3))),
      layerNorms: {
        inputActiveFeatures: langInfo.activeFeatureCount,
        embedding96Norm: Number(l2Norm(h1).toFixed(3)),
        gated96Norm: Number(l2Norm(h2).toFixed(3)),
        cortex64Norm: Number(l2Norm(h3).toFixed(3)),
      },
    };
  }

  private backwardAndStep(
    x: Float64Array,
    targetIntentIdx: number,
    targetAffect: [number, number, number, number],
    lr: number,
  ): { intentLoss: number; affectLoss: number; correct: boolean } {
    const { z1, h1, c, g, h2, h3, probs, affectOut } = this.forwardInternal(x);
    const { W1, b1, Wc, bc, Wg, bg, W3, b3, W_intent, b_intent, W_affect, b_affect } = this.params;

    let predIdx = 0;
    for (let k = 1; k < NUM_INTENTS; k++) {
      if (probs[k] > probs[predIdx]) predIdx = k;
    }
    const correct = predIdx === targetIntentIdx;

    const SMOOTH = 0.04;
    const smoothTarget = (k: number) => (k === targetIntentIdx ? 1 - SMOOTH + SMOOTH / NUM_INTENTS : SMOOTH / NUM_INTENTS);
    const intentLoss = -Math.log(Math.max(1e-12, probs[targetIntentIdx]));
    const AFFECT_WEIGHT = 0.65;
    let affectLoss = 0;
    const dAffectRaw = new Float64Array(AFFECT_DIM);

    for (let a = 0; a < AFFECT_DIM; a++) {
      const diff = affectOut[a] - targetAffect[a];
      affectLoss += 0.5 * AFFECT_WEIGHT * diff * diff;
      const deriv = a === 0 ? 1 - affectOut[a] * affectOut[a] : affectOut[a] * (1 - affectOut[a]);
      dAffectRaw[a] = AFFECT_WEIGHT * diff * deriv;
    }

    const dLogits = new Float64Array(NUM_INTENTS);
    for (let k = 0; k < NUM_INTENTS; k++) {
      dLogits[k] = (probs[k] - smoothTarget(k)) / 1.35;
    }

    // Gradients into h3 (64)
    const dh3 = new Float64Array(BOTTLENECK_DIM);
    for (let k = 0; k < NUM_INTENTS; k++) {
      const dl = dLogits[k];
      const rowOffset = k * BOTTLENECK_DIM;
      for (let j = 0; j < BOTTLENECK_DIM; j++) {
        dh3[j] += W_intent.w[rowOffset + j] * dl;
      }
    }
    for (let a = 0; a < AFFECT_DIM; a++) {
      const da = dAffectRaw[a];
      const rowOffset = a * BOTTLENECK_DIM;
      for (let j = 0; j < BOTTLENECK_DIM; j++) {
        dh3[j] += W_affect.w[rowOffset + j] * da;
      }
    }

    const dz3 = new Float64Array(BOTTLENECK_DIM);
    for (let j = 0; j < BOTTLENECK_DIM; j++) {
      dz3[j] = dh3[j] * (1 - h3[j] * h3[j]);
    }

    // Gradients into h2 (96)
    const dh2 = new Float64Array(GATED_DIM);
    for (let i = 0; i < BOTTLENECK_DIM; i++) {
      const dz = dz3[i];
      const rowOffset = i * GATED_DIM;
      for (let j = 0; j < GATED_DIM; j++) {
        dh2[j] += W3.w[rowOffset + j] * dz;
      }
    }

    // Gated residual block: h2 = h1 + g * c
    const dq = new Float64Array(GATED_DIM);
    const du = new Float64Array(GATED_DIM);
    const dh1 = new Float64Array(EMBED_DIM);
    for (let i = 0; i < GATED_DIM; i++) {
      dh1[i] = dh2[i]; // Skip connection gradient!
      dq[i] = dh2[i] * c[i] * g[i] * (1 - g[i]);
      du[i] = dh2[i] * g[i] * (1 - c[i] * c[i]);
    }

    for (let i = 0; i < GATED_DIM; i++) {
      const dqi = dq[i];
      const dui = du[i];
      const rowOffset = i * EMBED_DIM;
      for (let j = 0; j < EMBED_DIM; j++) {
        dh1[j] += Wg.w[rowOffset + j] * dqi + Wc.w[rowOffset + j] * dui;
      }
    }

    const dz1 = new Float64Array(EMBED_DIM);
    for (let i = 0; i < EMBED_DIM; i++) {
      dz1[i] = dh1[i] * (z1[i] > 0 ? 1 : 0.1);
    }

    // AdamW parameter update
    this.adamStep += 1;
    const beta1 = 0.9;
    const beta2 = 0.999;
    const eps = 1e-8;
    const wd = 1e-5;
    const bc1 = 1 - Math.pow(beta1, this.adamStep);
    const bc2 = 1 - Math.pow(beta2, this.adamStep);
    const stepScale = lr / bc1;

    const adamUpdate1D = (buf: ParameterBuffer, grad: Float64Array) => {
      for (let i = 0; i < buf.w.length; i++) {
        const gVal = Math.max(-5, Math.min(5, grad[i]));
        const m = beta1 * buf.m[i] + (1 - beta1) * gVal;
        const v = beta2 * buf.v[i] + (1 - beta2) * gVal * gVal;
        buf.m[i] = m;
        buf.v[i] = v;
        buf.w[i] -= stepScale * (m / (Math.sqrt(v / bc2) + eps));
      }
    };

    const adamUpdateOuter = (
      buf: ParameterBuffer,
      outGrad: Float64Array,
      inAct: Float64Array,
      rows: number,
      cols: number,
      sparseInput = false,
    ) => {
      for (let r = 0; r < rows; r++) {
        const gr = outGrad[r];
        if (sparseInput && Math.abs(gr) < 1e-14) continue;
        const rowOffset = r * cols;
        for (let col = 0; col < cols; col++) {
          const inp = inAct[col];
          if (sparseInput && inp === 0) continue;
          const idx = rowOffset + col;
          const gVal = Math.max(-5, Math.min(5, gr * inp + wd * buf.w[idx]));
          const m = beta1 * buf.m[idx] + (1 - beta1) * gVal;
          const v = beta2 * buf.v[idx] + (1 - beta2) * gVal * gVal;
          buf.m[idx] = m;
          buf.v[idx] = v;
          buf.w[idx] -= stepScale * (m / (Math.sqrt(v / bc2) + eps));
        }
      }
    };

    adamUpdateOuter(W_intent, dLogits, h3, NUM_INTENTS, BOTTLENECK_DIM);
    adamUpdate1D(b_intent, dLogits);

    adamUpdateOuter(W_affect, dAffectRaw, h3, AFFECT_DIM, BOTTLENECK_DIM);
    adamUpdate1D(b_affect, dAffectRaw);

    adamUpdateOuter(W3, dz3, h2, BOTTLENECK_DIM, GATED_DIM);
    adamUpdate1D(b3, dz3);

    adamUpdateOuter(Wg, dq, h1, GATED_DIM, EMBED_DIM);
    adamUpdate1D(bg, dq);

    adamUpdateOuter(Wc, du, h1, GATED_DIM, EMBED_DIM);
    adamUpdate1D(bc, du);

    adamUpdateOuter(W1, dz1, x, EMBED_DIM, INPUT_FEATURE_DIM, true);
    adamUpdate1D(b1, dz1);

    return { intentLoss, affectLoss, correct };
  }

  /**
   * Trains the Neural Cortex over the base + user-taught trilingual dataset for `epochs`.
   */
  public trainEpochs(epochs = 15, learningRate = 0.008, persist = true): TrainingEpochMetric[] {
    const allSamples = [...INITIAL_TRAINING_CORPUS, ...this.customSamples];
    const encoded = allSamples.map(sample => ({
      x: encodeTextFeatures(sample.text, undefined, sample.language),
      intentIdx: COGNITIVE_INTENTS.indexOf(sample.intent),
      affect: sample.affect,
    }));

    const rng = createSeededRng(1000 + this.trainedEpochs * 37);
    const runMetrics: TrainingEpochMetric[] = [];

    for (let ep = 0; ep < epochs; ep++) {
      // Deterministic Fisher-Yates shuffle per epoch
      const indices = encoded.map((_, idx) => idx);
      for (let i = indices.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        const tmp = indices[i];
        indices[i] = indices[j];
        indices[j] = tmp;
      }

      let sumIntentLoss = 0;
      let sumAffectLoss = 0;
      let correctCount = 0;
      const lr = learningRate * Math.pow(0.985, ep);

      for (const idx of indices) {
        const item = encoded[idx];
        const res = this.backwardAndStep(item.x, item.intentIdx, item.affect, lr);
        sumIntentLoss += res.intentLoss;
        sumAffectLoss += res.affectLoss;
        if (res.correct) correctCount += 1;
      }

      this.trainedEpochs += 1;
      const n = Math.max(1, indices.length);
      const metric: TrainingEpochMetric = {
        epoch: this.trainedEpochs,
        totalLoss: Number(((sumIntentLoss + sumAffectLoss) / n).toFixed(4)),
        intentLoss: Number((sumIntentLoss / n).toFixed(4)),
        affectLoss: Number((sumAffectLoss / n).toFixed(4)),
        accuracy: Number((correctCount / n).toFixed(4)),
        timestamp: Date.now(),
      };
      this.history.push(metric);
      if (this.history.length > 120) {
        this.history = this.history.slice(this.history.length - 120);
      }
      runMetrics.push(metric);
    }

    if (persist) this.saveCheckpoint();
    return runMetrics;
  }

  /**
   * Online neuroplasticity: teaches a new example immediately via multi-step local replay + weight update.
   */
  public learnOnlineSample(
    text: string,
    intent: CognitiveIntent,
    affect?: [number, number, number, number],
    language?: SupportedLanguage,
  ): NeuralForwardResult {
    const langInfo = analyzeLanguage(text);
    const sampleLang = language ?? langInfo.detected;
    const defaultAffect: [number, number, number, number] = affect ?? [0.6, 0.58, 0.85, 0.8];

    const sample: TrainingSample = {
      text,
      language: sampleLang,
      intent,
      affect: defaultAffect,
    };
    this.customSamples.push(sample);

    const x = encodeTextFeatures(text, langInfo.normalizedTokens, sampleLang);
    const intentIdx = COGNITIVE_INTENTS.indexOf(intent);

    // Synaptic consolidation burst (8 gradient steps on new example + 6 anchor replay steps)
    for (let step = 0; step < 8; step++) {
      this.backwardAndStep(x, intentIdx, defaultAffect, 0.012);
    }
    for (let r = 0; r < 6; r++) {
      const anchor = INITIAL_TRAINING_CORPUS[(this.onlineUpdates * 7 + r * 13) % INITIAL_TRAINING_CORPUS.length];
      const ax = encodeTextFeatures(anchor.text, undefined, anchor.language);
      this.backwardAndStep(ax, COGNITIVE_INTENTS.indexOf(anchor.intent), anchor.affect, 0.004);
    }

    this.onlineUpdates += 1;
    this.saveCheckpoint();
    return this.predict(text);
  }

  public getStats(): NeuralModelStats {
    const latest = this.history[this.history.length - 1];
    return {
      architecture: '384 → Dense(96, LeakyReLU) → GatedContextResidual(96) → TanhCortex(64) → DualHead(14 Intents + 4 Affect)',
      inputDim: INPUT_FEATURE_DIM,
      embeddingDim: EMBED_DIM,
      gatedDim: GATED_DIM,
      bottleneckDim: BOTTLENECK_DIM,
      numIntents: NUM_INTENTS,
      totalParameters: this.getTotalParameters(),
      trainedEpochs: this.trainedEpochs,
      onlineUpdates: this.onlineUpdates,
      corpusSize: INITIAL_TRAINING_CORPUS.length + this.customSamples.length,
      lastLoss: latest?.totalLoss ?? 0,
      lastAccuracy: latest?.accuracy ?? 1,
      history: this.history,
    };
  }

  public saveCheckpoint(): void {
    if (!this.storage) return;
    try {
      const weights: Record<string, number[]> = {};
      for (const [key, buf] of Object.entries(this.params)) {
        weights[key] = Array.from(buf.w, v => Number(v.toFixed(6)));
      }
      const data: SerializedCheckpoint = {
        version: 1,
        trainedEpochs: this.trainedEpochs,
        onlineUpdates: this.onlineUpdates,
        adamStep: this.adamStep,
        history: this.history,
        customSamples: this.customSamples,
        weights,
      };
      this.storage.save(JSON.stringify(data));
    } catch {
      // Non-fatal in quota/read-only environments
    }
  }

  private loadFromJson(jsonStr: string): boolean {
    try {
      const raw = JSON.parse(jsonStr) as SerializedCheckpoint;
      if (raw.version !== 1 || !raw.weights) return false;
      for (const [key, arr] of Object.entries(raw.weights)) {
        const target = this.params[key];
        if (!target || target.w.length !== arr.length) return false;
        target.w.set(arr);
      }
      this.trainedEpochs = raw.trainedEpochs ?? 0;
      this.onlineUpdates = raw.onlineUpdates ?? 0;
      this.adamStep = raw.adamStep ?? 0;
      this.history = Array.isArray(raw.history) ? raw.history : [];
      this.customSamples = Array.isArray(raw.customSamples) ? raw.customSamples : [];
      return true;
    } catch {
      return false;
    }
  }
}
