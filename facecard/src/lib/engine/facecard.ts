import { findOption, QUESTIONS } from "./questions";
import { applyDelta, baseEmotions } from "./emotions";
import type { EmotionDelta, EmotionKey, Emotions, FaceCard, FaceCardStats, StatKey } from "./types";

const STAT_KEYS: StatKey[] = ["confidence", "ambition", "loyalty", "risk", "chaos"];

/** Deterministic hash so a given answer set always yields the same card. */
function hash(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

const clamp = (n: number, lo = 5, hi = 99) => Math.max(lo, Math.min(hi, Math.round(n)));

export function computeStats(answers: Record<string, string>): FaceCardStats {
  const stats: FaceCardStats = { confidence: 50, ambition: 50, loyalty: 50, risk: 50, chaos: 50 };
  for (const q of QUESTIONS) {
    const opt = findOption(q.key, answers[q.key] ?? "");
    if (!opt) continue;
    for (const k of STAT_KEYS) {
      const d = opt.stats[k];
      if (typeof d === "number") stats[k] += d;
    }
  }
  for (const k of STAT_KEYS) stats[k] = clamp(stats[k]);
  return stats;
}

/**
 * How much of the questionnaire's emotional weight carries into scene one.
 * Character creation sets a starting *lean*, not an extreme: applied raw, a
 * strongly-themed card saturates at 0/100 before the story begins, which would
 * pin every scene to one cinematographic look and force the same ending down
 * every branch. Damping keeps headroom so the player's choices still move the
 * needle — the choices have to matter more than the quiz did.
 */
const START_LEAN = 0.4;

export function computeStartingEmotions(answers: Record<string, string>): Emotions {
  const totals = new Map<EmotionKey, number>();
  for (const q of QUESTIONS) {
    const opt = findOption(q.key, answers[q.key] ?? "");
    if (!opt) continue;
    for (const [key, value] of Object.entries(opt.emotions)) {
      if (typeof value !== "number") continue;
      const k = key as EmotionKey;
      totals.set(k, (totals.get(k) ?? 0) + value);
    }
  }

  const damped: EmotionDelta = {};
  for (const [key, total] of totals) {
    damped[key] = Math.round(total * START_LEAN);
  }
  return applyDelta(baseEmotions(), damped);
}

export function collectTraits(answers: Record<string, string>): string[] {
  const traits: string[] = [];
  for (const q of QUESTIONS) {
    const opt = findOption(q.key, answers[q.key] ?? "");
    if (opt) traits.push(...opt.traits);
  }
  return Array.from(new Set(traits));
}

/**
 * The Face Card score rates PRESENTATION — how distinct and committed the
 * character reads on screen. It is a style/game rating, deliberately not a
 * judgement of the person: a decisive, sharply-defined character scores high
 * whether they are heroic or awful.
 */
export function computeScore(stats: FaceCardStats): number {
  const values = STAT_KEYS.map((k) => stats[k]);
  const peak = Math.max(...values);
  const spread = peak - Math.min(...values);
  const commitment = values.reduce((a, v) => a + Math.abs(v - 50), 0) / values.length;
  const raw = 58 + peak * 0.16 + spread * 0.14 + commitment * 0.5;
  return Math.max(64, Math.min(99, Math.round(raw)));
}

interface ArchetypeDef {
  key: string;
  name: string;
  score: (s: FaceCardStats, t: Set<string>) => number;
  lines: string[];
}

const ARCHETYPES: ArchetypeDef[] = [
  {
    key: "wildcard", name: "THE WILDCARD",
    score: (s) => s.chaos * 1.2 + s.risk * 0.9 - s.loyalty * 0.2,
    lines: [
      "THE PROBLEM ISN'T THE PLAN.\nIT'S THAT THERE IS ONE.",
      "PREDICTABLE PEOPLE ARE EASY TO PLAN AROUND.\nGOOD THING THAT'S NOT AN ISSUE.",
      "EVERY ROOM CHANGES TEMPERATURE.\nNOBODY AGREES ON WHY.",
      "NOT LOOKING FOR TROUBLE.\nJUST NEVER OUTRUNS IT EITHER.",
    ],
  },
  {
    key: "strategist", name: "THE STRATEGIST",
    score: (s) => s.ambition * 1.2 + (100 - s.chaos) * 0.6 + s.confidence * 0.3,
    lines: [
      "THREE MOVES AHEAD.\nSTILL ANNOYED IT TAKES THREE.",
      "NEVER RAISES A VOICE.\nNEVER HAS TO.",
      "THE FAVOUR WASN'T FREE.\nIT WAS JUST QUIET.",
      "PATIENCE ISN'T A VIRTUE HERE.\nIT'S A WEAPON.",
    ],
  },
  {
    key: "loyalist", name: "THE LOYALIST",
    score: (s, t) => s.loyalty * 1.4 + (t.has("ride-or-die") ? 20 : 0) - s.chaos * 0.2,
    lines: [
      "WOULD TAKE THE BLAME.\nWOULD NOT TAKE THE APOLOGY.",
      "SHOWS UP.\nTHAT'S THE WHOLE PERSONALITY.",
      "THE LIST IS SHORT.\nBEING ON IT IS PERMANENT.",
      "NEVER ASKS WHAT HAPPENED.\nJUST ASKS WHERE TO BE.",
    ],
  },
  {
    key: "phantom", name: "THE PHANTOM",
    score: (s, t) => (100 - s.chaos) * 0.7 + s.risk * 0.6 + (t.has("private") || t.has("withholding") ? 28 : 0),
    lines: [
      "LEAVES BEFORE THE STORY ENDS.\nSTILL SOMEHOW IN IT.",
      "SAYS ALMOST NOTHING.\nREMEMBERS ABSOLUTELY EVERYTHING.",
      "HARD TO FIND.\nHARDER TO FORGET.",
      "NO RECEIPTS. NO WITNESSES.\nNO PROBLEM.",
    ],
  },
  {
    key: "firestarter", name: "THE FIRESTARTER",
    score: (s) => s.chaos * 1.1 + s.confidence * 0.8 - s.loyalty * 0.1,
    lines: [
      "DIDN'T START THE FIRE.\nDEFINITELY BROUGHT THE GASOLINE.",
      "ONE SENTENCE. WHOLE GROUP CHAT DOWN.",
      "BOREDOM IS THE REAL VILLAIN.\nTHIS IS SELF-DEFENCE.",
      "SOMEBODY WAS GOING TO SAY IT.\nMIGHT AS WELL BE FIRST.",
    ],
  },
  {
    key: "romantic", name: "THE ROMANTIC",
    score: (s, t) => s.loyalty * 0.7 + (t.has("romantic") || t.has("devoted") ? 42 : 0) + (t.has("needs people") ? 16 : 0),
    lines: [
      "FALLS FIRST. FALLS HARDER.\nWOULD DO IT AGAIN TOMORROW.",
      "KEEPS THE TEXT DRAFTED.\nNEVER SENDS IT.",
      "ROMANTICISES EVERYTHING.\nINCLUDING THE PARTS THAT HURT.",
      "LOVES LOUD.\nLEAVES QUIET.",
    ],
  },
  {
    key: "opportunist", name: "THE OPPORTUNIST",
    score: (s) => s.ambition * 1.1 + (100 - s.loyalty) * 0.7,
    lines: [
      "EVERY DOOR IS A DOOR.\nLOCKED IS A DETAIL.",
      "NOT RUTHLESS.\nJUST NEVER SENTIMENTAL ON A DEADLINE.",
      "THE ROOM PICKED SIDES.\nSO DID EVERYONE, QUIETLY.",
      "LOYALTY IS EXPENSIVE.\nTHIS IS A BUDGET YEAR.",
    ],
  },
  {
    key: "survivor", name: "THE SURVIVOR",
    score: (s, t) => (t.has("reflective") || t.has("tired") ? 34 : 0) + s.loyalty * 0.5 + (100 - s.chaos) * 0.4,
    lines: [
      "ALREADY SURVIVED WORSE.\nDIDN'T MAKE A POST ABOUT IT.",
      "STILL HERE.\nTHAT WAS THE HARD PART.",
      "NOT FEARLESS.\nJUST DONE NEGOTIATING WITH IT.",
      "THE STORY GOT UGLY.\nTHE ENDING IS STILL OPEN.",
    ],
  },
  {
    key: "menace", name: "THE MENACE",
    score: (s, t) => s.chaos * 0.9 + (t.has("unbothered") || t.has("menace") ? 34 : 0) + (100 - s.loyalty) * 0.3,
    lines: [
      "NOT THE VILLAIN.\nJUST NEVER THE ONE APOLOGISING.",
      "CAUSES PROBLEMS ON PURPOSE.\nSOLVES THEM ON PURPOSE TOO.",
      "THE WARNING WAS THE WHOLE CONVERSATION.",
      "BEHAVES PERFECTLY.\nWHEN OBSERVED.",
    ],
  },
  {
    key: "underdog", name: "THE UNDERDOG",
    score: (s, t) => (t.has("underestimated") || t.has("chip on shoulder") ? 40 : 0) + s.ambition * 0.8 - s.confidence * 0.2,
    lines: [
      "COUNTED OUT EARLY.\nSTILL COUNTING.",
      "NOBODY SAW IT COMING.\nTHAT WAS THE ADVANTAGE.",
      "STARTED AS BACKGROUND.\nRENEGOTIATED THE CREDITS.",
      "THE DOUBT WASN'T DISCOURAGING.\nIT WAS FUEL.",
    ],
  },
];

export function pickArchetype(stats: FaceCardStats, traits: string[]) {
  const set = new Set(traits);
  let best = ARCHETYPES[0];
  let bestScore = -Infinity;
  for (const a of ARCHETYPES) {
    const s = a.score(stats, set);
    if (s > bestScore) { bestScore = s; best = a; }
  }
  return best;
}

const ERA_LABELS: Record<string, string> = {
  main_character: "MAIN CHARACTER", villain: "VILLAIN", healing: "HEALING",
  crashout: "CRASHOUT", ceo: "CEO", heartbreaker: "HEARTBREAKER",
  lowkey: "LOWKEY", chaotic: "CHAOTIC", mysterious: "MYSTERIOUS",
  npc_to_main: "NPC → MAIN CHARACTER",
};

export function buildFaceCard(
  username: string,
  answers: Record<string, string>,
  portraitUrl?: string | null,
): FaceCard {
  const stats = computeStats(answers);
  const traits = collectTraits(answers);
  const archetype = pickArchetype(stats, traits);
  const seed = hash(username + JSON.stringify(answers));
  const eraKey = answers.era ?? "main_character";

  return {
    username,
    score: computeScore(stats),
    archetype: archetype.name,
    archetypeKey: archetype.key,
    era: ERA_LABELS[eraKey] ?? "MAIN CHARACTER",
    eraKey,
    signatureLine: archetype.lines[seed % archetype.lines.length],
    stats,
    traits,
    portraitUrl: portraitUrl ?? null,
  };
}
