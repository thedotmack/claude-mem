import { applyDelta, cinematographyFor, dominantEmotion } from "./emotions";
import type {
  CharacterBible, Choice, ChoiceEffects, ComposedScene, Emotions,
  MemoryEntry, PriorChoice, ScriptLine, StoryState,
} from "./types";

/* ------------------------------------------------------------------ beats */

export interface BeatChoice extends Choice {
  /** Only offered when this predicate passes — choices depend on the path taken. */
  when?: (s: StoryState) => boolean;
}

export interface Beat {
  key: string;
  title: (s: StoryState) => string;
  slug: (s: StoryState) => string;
  /** Base script for the beat; receives full state so lines can react to it. */
  lines: (s: StoryState, b: CharacterBible) => ScriptLine[];
  question: (s: StoryState) => string;
  choices: (s: StoryState) => BeatChoice[];
  /** Beats can be skipped for some branches entirely. */
  when?: (s: StoryState) => boolean;
  isFinal?: boolean;
  seconds?: number;
}

export interface StoryTemplate {
  key: string;
  title: string;
  genre: string;
  logline: string;
  trending: boolean;
  world: string;
  beats: Beat[];
}

/* -------------------------------------------------------- state utilities */

export function initialStoryState(openingEmotions: Emotions): StoryState {
  return {
    beatIndex: 0,
    branch: [],
    emotions: { ...openingEmotions },
    openingEmotions: { ...openingEmotions },
    relationships: {
      dani: { name: "DANI", role: "best friend", affinity: 62, trust: 66, status: "ally" },
      mara: { name: "MARA", role: "the one who knows too much", affinity: 44, trust: 38, status: "neutral" },
      ezra: { name: "EZRA", role: "wildcard contact", affinity: 50, trust: 42, status: "neutral" },
    },
    flags: {},
    inventory: [],
    memory: [],
    previousChoices: [],
    completedBranches: [],
    availableBranches: [],
    characterTraits: {},
  };
}

const clampStat = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

export function applyChoice(state: StoryState, beatKey: string, choice: Choice, sceneSeq: number): StoryState {
  const s: StoryState = structuredClone(state);
  const fx: ChoiceEffects = choice.effects ?? {};

  if (fx.emotions) s.emotions = applyDelta(s.emotions, fx.emotions);
  if (fx.flags) {
    for (const [key, value] of Object.entries(fx.flags)) {
      if (value !== undefined) s.flags[key] = value;
    }
  }
  if (fx.inventory) s.inventory.push(...fx.inventory.filter((i) => !s.inventory.includes(i)));
  if (fx.branch) s.branch.push(fx.branch);
  if (fx.unlock && !s.availableBranches.includes(fx.unlock)) s.availableBranches.push(fx.unlock);
  if (fx.memory) s.memory.push({ sceneSeq, ...fx.memory });

  if (fx.relationships) {
    for (const [key, change] of Object.entries(fx.relationships)) {
      const rel = s.relationships[key];
      if (!rel || !change) continue;
      if (typeof change.affinity === "number") rel.affinity = clampStat(rel.affinity + change.affinity);
      if (typeof change.trust === "number") rel.trust = clampStat(rel.trust + change.trust);
      if (change.status) rel.status = change.status;
    }
  }

  s.previousChoices.push({ sceneSeq, beatKey, key: choice.key, label: choice.label, kind: choice.kind });
  s.characterTraits[choice.kind] = (s.characterTraits[choice.kind] ?? 0) + 1;
  s.completedBranches.push(`${beatKey}:${choice.key}`);
  s.beatIndex += 1;
  return s;
}

export const has = (s: StoryState, flag: string) => Boolean(s.flags[flag]);
export const chose = (s: StoryState, beat: string, key: string) =>
  s.completedBranches.includes(`${beat}:${key}`);
export const onBranch = (s: StoryState, token: string) => s.branch.includes(token);
export const kindCount = (s: StoryState, kind: PriorChoice["kind"]) => s.characterTraits[kind] ?? 0;

/* ------------------------------------------------------- memory callbacks */

/**
 * Story memory (spec §11): pull the strongest unused memory and weave it back
 * into the scene as a callback line. Consumed memories are flagged so the same
 * lie doesn't echo twice.
 */
export function takeCallback(s: StoryState, minAge = 2): MemoryEntry | null {
  const candidates = s.memory
    .filter((m) => !s.flags[`cb_${m.tag}`] && s.beatIndex - m.sceneSeq >= minAge)
    .sort((a, b) => b.weight - a.weight);
  const pick = candidates[0];
  if (!pick) return null;
  s.flags[`cb_${pick.tag}`] = true;
  return pick;
}

/* ----------------------------------------------------- dialogue flavoring */

/** Gen-Z reactive lines, keyed by the character's humor trait — used sparingly. */
const REACTIONS: Record<string, string[]> = {
  deadpan: ["Cool. Love that for us.", "Great. Anyway.", "This is fine. Statistically."],
  "chaotic-funny": ["Bro really chose violence.", "Chat is going to cook you for this.", "Oh we're SO cooked."],
  dry: ["Respectfully... what are you doing?", "Incredible. Do it again but worse.", "You're seriously doing this?"],
  loud: ["THAT'S ACTUALLY INSANE.", "NO BECAUSE WHO DOES THAT?", "I'M NOT EVEN SURPRISED ANYMORE."],
  dark: ["Yeah. This is about to get messy.", "At least the funeral playlist is ready.", "We died doing what we loved. Lying."],
  wholesome: ["Okay but we're getting food after this.", "I've got you. Obviously.", "You're an idiot. Don't change."],
};

export function reactionFor(bible: CharacterBible, s: StoryState): string {
  const key = ["deadpan", "chaotic-funny", "dry", "loud", "dark"].find((k) => bible.humor.includes(k.split("-")[0])) ?? "wholesome";
  const pool = REACTIONS[key] ?? REACTIONS.wholesome;
  return pool[(s.beatIndex + s.previousChoices.length) % pool.length];
}

/* ------------------------------------------------------------- composing */

export function composeScene(template: StoryTemplate, state: StoryState, bible: CharacterBible): ComposedScene {
  // Walk the beat list respecting `when` guards so branches can skip beats.
  const eligible = template.beats.filter((b) => !b.when || b.when(state));
  const beat = eligible[Math.min(state.beatIndex, eligible.length - 1)];
  const isFinal = beat.isFinal === true || state.beatIndex >= eligible.length - 1;

  const s = structuredClone(state);
  const lines = beat.lines(s, bible);

  // Weave a memory callback into non-final scenes past the midpoint.
  if (!isFinal && state.beatIndex >= 3) {
    const cb = takeCallback(s);
    if (cb) {
      lines.push({ type: "beat" });
      lines.push({ type: "action", text: cb.who ? `${cb.who} hasn't forgotten.` : "It resurfaces at the worst possible time." });
      lines.push({ type: "voiceover", text: cb.text });
    }
  }

  const cinematography = cinematographyFor(state.emotions);
  const choices = isFinal ? [] : beat.choices(state).filter((c) => !c.when || c.when(state));

  // Never present a fake fork: if guards filtered us down to one option the
  // scene plays straight through instead of pretending there's a decision.
  const finalChoices = choices.length >= 2 ? choices : [];

  return {
    beatKey: beat.key,
    branchKey: state.branch.join(".") || "root",
    title: beat.title(state),
    script: { slug: beat.slug(state), lines, question: finalChoices.length ? beat.question(state) : "" },
    cinematography,
    choices: finalChoices.map(({ when: _when, ...c }) => c),
    isFinal,
    estimatedSeconds: beat.seconds ?? (isFinal ? 40 : 25),
  };
}

/** Flags whose consumed-callback bookkeeping mutated during compose. */
export function mergeCallbackFlags(from: StoryState, into: StoryState): StoryState {
  const out = structuredClone(into);
  for (const [k, v] of Object.entries(from.flags)) {
    if (k.startsWith("cb_")) out.flags[k] = v;
  }
  return out;
}

export function describeDominant(state: StoryState): string {
  return dominantEmotion(state.emotions);
}
