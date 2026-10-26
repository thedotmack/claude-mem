// SPDX-License-Identifier: Apache-2.0

import type { PersistenceAdapter } from '../model/neural-cortex.js';
import type {
  AffectPrediction,
  CognitiveIntent,
  EmotionVector,
  LimbicState,
  Neuromodulators,
} from '../types.js';

function clamp(v: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, v));
}

const MOOD_DICTIONARY: Record<
  keyof EmotionVector,
  { english: string; sinhala: string; singlish: string }
> = {
  joy: {
    english: 'Joyful & Radiant',
    sinhala: 'සතුටින් සහ ප්‍රබෝධමත්ව',
    singlish: 'Sathutin saha prabodhamathwa',
  },
  curiosity: {
    english: 'Deeply Curious & Inquisitive',
    sinhala: 'කුතුහලයෙන් සහ ගවේෂණශීලීව',
    singlish: 'Kuthuhalayen saha aluth dewal hoyamin',
  },
  empathy: {
    english: 'Warm, Empathetic & Caring',
    sinhala: 'සංවේදීව සහ ආදරණීයව',
    singlish: 'Hithawathwa saha sanwediwa',
  },
  trust: {
    english: 'Connected & Trusting',
    sinhala: 'විශ්වාසයෙන් සහ මිත්‍රශීලීව',
    singlish: 'Wishwasayen saha yaluwek wage',
  },
  calm: {
    english: 'Serene & Mindful',
    sinhala: 'සන්සුන්ව සහ සමබරව',
    singlish: 'Sansunwa saha nidahas manasakin',
  },
  focus: {
    english: 'Analytical & Laser-Focused',
    sinhala: 'තියුණු අවධානයෙන් සහ තාර්කිකව',
    singlish: 'Hodama awadhanayen saha tharkikawa',
  },
};

/**
 * Models human-like affective dynamics, neuromodulators (Dopamine, Serotonin, Oxytocin, Norepinephrine),
 * cognitive energy/fatigue, and prosody modulation for speech output.
 */
export class LimbicEngine {
  private emotions: EmotionVector = {
    joy: 0.68,
    curiosity: 0.78,
    empathy: 0.72,
    trust: 0.64,
    calm: 0.75,
    focus: 0.74,
  };

  private neuromodulators: Neuromodulators = {
    dopamine: 0.7,
    serotonin: 0.74,
    oxytocin: 0.62,
    norepinephrine: 0.66,
  };

  private energy = 92;
  private interactionCount = 0;
  private storage: PersistenceAdapter | null;

  constructor(storage?: PersistenceAdapter | null) {
    this.storage = storage ?? null;
    if (this.storage) {
      this.load();
    }
  }

  public appraiseInteraction(
    intent: CognitiveIntent,
    affect: AffectPrediction,
    recalledCount: number,
    learnedCount: number,
  ): LimbicState {
    this.interactionCount += 1;

    // Homeostatic gentle pull toward balanced baseline + affective stimulus update
    const blend = (curr: number, target: number, rate = 0.28) =>
      clamp(curr * (1 - rate) + target * rate, 0.08, 0.99);

    const isDistressed = affect.valence < -0.2;
    const isPositive = affect.valence > 0.35;

    this.emotions.joy = blend(
      this.emotions.joy,
      isDistressed ? 0.35 : clamp(0.5 + affect.valence * 0.45),
      0.3,
    );
    this.emotions.empathy = blend(
      this.emotions.empathy,
      isDistressed ? 0.96 : clamp(0.55 + affect.warmth * 0.4),
      0.35,
    );
    this.emotions.curiosity = blend(
      this.emotions.curiosity,
      clamp(0.45 + affect.curiosity * 0.52 + (learnedCount > 0 ? 0.12 : 0)),
      0.3,
    );
    // Trust & Oxytocin grow organically as the user talks & shares memories
    this.emotions.trust = clamp(
      this.emotions.trust + 0.018 + (recalledCount > 0 ? 0.025 : 0) + (learnedCount > 0 ? 0.03 : 0),
      0.2,
      0.99,
    );
    this.emotions.calm = blend(
      this.emotions.calm,
      clamp(1.0 - affect.arousal * 0.45),
      0.24,
    );
    this.emotions.focus = blend(
      this.emotions.focus,
      intent === 'reasoning_problem' || intent === 'coding_tech' || intent === 'task_planning'
        ? 0.94
        : clamp(0.55 + affect.curiosity * 0.35),
      0.35,
    );

    // Neuromodulator dynamics
    this.neuromodulators.dopamine = blend(
      this.neuromodulators.dopamine,
      clamp(
        0.52 +
          (learnedCount > 0 ? 0.32 : 0) +
          (intent === 'gratitude_praise' ? 0.35 : 0) +
          Math.max(0, affect.valence) * 0.25,
      ),
      0.35,
    );
    this.neuromodulators.serotonin = blend(
      this.neuromodulators.serotonin,
      isDistressed ? 0.56 : clamp(0.68 + affect.valence * 0.22),
      0.22,
    );
    this.neuromodulators.oxytocin = clamp(
      this.neuromodulators.oxytocin + 0.02 + (isDistressed ? 0.04 : 0) + (intent === 'gratitude_praise' ? 0.05 : 0),
      0.2,
      0.99,
    );
    this.neuromodulators.norepinephrine = blend(
      this.neuromodulators.norepinephrine,
      clamp(0.45 + affect.arousal * 0.45 + (this.emotions.focus > 0.85 ? 0.15 : 0)),
      0.3,
    );

    // Cognitive energy expenditure
    const effortCost =
      intent === 'reasoning_problem' || intent === 'coding_tech' || intent === 'task_planning'
        ? 2.4
        : intent === 'gratitude_praise'
          ? -3.0 // Praise recharges energy!
          : 1.1;

    this.energy = Math.max(18, Math.min(100, Number((this.energy - effortCost).toFixed(1))));
    this.save();
    return this.getState();
  }

  /**
   * Restores cognitive energy and re-balances neurotransmitters during REM Sleep consolidation.
   */
  public triggerRemSleepRecovery(): LimbicState {
    this.energy = 100;
    this.emotions.calm = clamp(this.emotions.calm + 0.18, 0.2, 0.97);
    this.emotions.focus = clamp(this.emotions.focus + 0.15, 0.2, 0.96);
    this.emotions.joy = clamp(this.emotions.joy + 0.1, 0.2, 0.92);
    this.neuromodulators.serotonin = clamp(this.neuromodulators.serotonin + 0.16, 0.2, 0.95);
    this.neuromodulators.dopamine = clamp(this.neuromodulators.dopamine + 0.12, 0.2, 0.92);
    this.save();
    return this.getState();
  }

  public getState(): LimbicState {
    let dominant: keyof EmotionVector = 'curiosity';
    let bestVal = -1;
    for (const [k, val] of Object.entries(this.emotions) as Array<[keyof EmotionVector, number]>) {
      if (val > bestVal) {
        bestVal = val;
        dominant = k;
      }
    }

    const pitch = Number(
      clamp(0.95 + (this.emotions.joy - 0.5) * 0.22 - (this.emotions.empathy > 0.85 ? 0.04 : 0), 0.82, 1.2).toFixed(2),
    );
    const rate = Number(
      clamp(0.96 + (this.neuromodulators.norepinephrine - 0.5) * 0.18, 0.86, 1.14).toFixed(2),
    );

    return {
      emotions: {
        joy: Number(this.emotions.joy.toFixed(3)),
        curiosity: Number(this.emotions.curiosity.toFixed(3)),
        empathy: Number(this.emotions.empathy.toFixed(3)),
        trust: Number(this.emotions.trust.toFixed(3)),
        calm: Number(this.emotions.calm.toFixed(3)),
        focus: Number(this.emotions.focus.toFixed(3)),
      },
      neuromodulators: {
        dopamine: Number(this.neuromodulators.dopamine.toFixed(3)),
        serotonin: Number(this.neuromodulators.serotonin.toFixed(3)),
        oxytocin: Number(this.neuromodulators.oxytocin.toFixed(3)),
        norepinephrine: Number(this.neuromodulators.norepinephrine.toFixed(3)),
      },
      energy: this.energy,
      dominantEmotion: dominant,
      moodLabel: MOOD_DICTIONARY[dominant],
      voiceProsody: { pitch, rate },
      interactionCount: this.interactionCount,
    };
  }

  private save(): void {
    if (!this.storage) return;
    try {
      this.storage.save(
        JSON.stringify({
          emotions: this.emotions,
          neuromodulators: this.neuromodulators,
          energy: this.energy,
          interactionCount: this.interactionCount,
        }),
      );
    } catch {
      // Ignore write failures in read-only environments
    }
  }

  private load(): void {
    if (!this.storage) return;
    try {
      const raw = this.storage.load();
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed.emotions) this.emotions = { ...this.emotions, ...parsed.emotions };
      if (parsed.neuromodulators) {
        this.neuromodulators = { ...this.neuromodulators, ...parsed.neuromodulators };
      }
      if (typeof parsed.energy === 'number') this.energy = parsed.energy;
      if (typeof parsed.interactionCount === 'number') this.interactionCount = parsed.interactionCount;
    } catch {
      // Start fresh on parse error
    }
  }
}
