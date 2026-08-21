/** Core narrative types shared by the engine, the API layer and the player. */

export const EMOTION_KEYS = [
  "confidence", "fear", "trust", "anger", "love",
  "loyalty", "ambition", "courage", "risk", "chaos", "regret",
] as const;

export type EmotionKey = (typeof EMOTION_KEYS)[number];
export type Emotions = Record<EmotionKey, number>;
export type EmotionDelta = Partial<Emotions>;

export type StatKey = "confidence" | "ambition" | "loyalty" | "risk" | "chaos";
export type FaceCardStats = Record<StatKey, number>;

/** A single remembered fact the story can call back to later. */
export interface MemoryEntry {
  sceneSeq: number;
  tag: string;
  text: string;
  /** Higher weight surfaces sooner in later scenes. */
  weight: number;
  /** Who, if anyone, remembers this. */
  who?: string;
}

export interface RelationshipState {
  name: string;
  role: string;
  affinity: number;
  trust: number;
  status: "ally" | "neutral" | "strained" | "hostile" | "romantic";
}

export interface StoryState {
  beatIndex: number;
  branch: string[];
  emotions: Emotions;
  openingEmotions: Emotions;
  relationships: Record<string, RelationshipState>;
  flags: Record<string, boolean | number | string>;
  inventory: string[];
  memory: MemoryEntry[];
  previousChoices: PriorChoice[];
  completedBranches: string[];
  availableBranches: string[];
  characterTraits: Record<string, number>;
}

export interface PriorChoice {
  sceneSeq: number;
  beatKey: string;
  key: string;
  label: string;
  kind: ChoiceKind;
}

export type ChoiceKind =
  | "aggressive" | "cautious" | "honest" | "deceptive"
  | "romantic" | "chaotic" | "selfless" | "selfish" | "bold";

/** Per-relationship adjustment applied when a choice is taken. */
export interface RelationshipDelta {
  affinity?: number;
  trust?: number;
  status?: RelationshipState["status"];
}

export interface ChoiceEffects {
  emotions?: EmotionDelta;
  // `undefined` is permitted so a set of sibling choices, each setting a
  // different flag, still unifies to one type.
  flags?: Record<string, boolean | number | string | undefined>;
  relationships?: Record<string, RelationshipDelta | undefined>;
  inventory?: string[];
  memory?: { tag: string; text: string; weight: number; who?: string };
  /** Branch token appended to the lineage — this is what makes paths diverge. */
  branch?: string;
  /** Unlocks an optional beat that only some players will ever see. */
  unlock?: string;
}

export interface Choice {
  key: string;
  label: string;
  kind: ChoiceKind;
  effects: ChoiceEffects;
}

export type ScriptLine =
  | { type: "slug"; text: string }
  | { type: "action"; text: string }
  | { type: "dialogue"; who: string; text: string; delivery?: string }
  | { type: "message"; from: string; text: string }
  | { type: "voiceover"; text: string }
  | { type: "title"; text: string }
  | { type: "beat" };

export interface SceneScript {
  slug: string;
  lines: ScriptLine[];
  question: string;
}

export interface Palette {
  base: string;
  accent: string;
  glow: string;
  fog: string;
}

export interface Cinematography {
  dominant: EmotionKey;
  framing: string;
  cameraMove: string;
  lighting: string;
  pacing: string;
  editing: string;
  sound: string;
  music: string;
  palette: Palette;
  /** 0..1 render controls consumed by the scene renderer and the player. */
  grain: number;
  vignette: number;
  shake: number;
  /** Line reveal speed multiplier — fear slows down, anger speeds up. */
  tempo: number;
}

export interface ComposedScene {
  beatKey: string;
  branchKey: string;
  title: string;
  script: SceneScript;
  cinematography: Cinematography;
  choices: Choice[];
  isFinal: boolean;
  /** Seconds this scene is expected to run — used for movie duration. */
  estimatedSeconds: number;
}

export interface CharacterBible {
  name: string;
  identity: string;
  appearance: string;
  wardrobe: string;
  personality: string;
  speechStyle: string;
  humor: string;
  strengths: string[];
  weaknesses: string[];
  motivations: string[];
  fears: string[];
  goals: string[];
  contradictions: string[];
  relationships: { name: string; role: string; note: string }[];
  arc: string;
  /** Stable visual descriptor reused for every scene so the look stays consistent. */
  visualSignature: string;
}

export interface FaceCard {
  username: string;
  score: number;
  archetype: string;
  archetypeKey: string;
  era: string;
  eraKey: string;
  signatureLine: string;
  stats: FaceCardStats;
  traits: string[];
  portraitUrl?: string | null;
}

export interface EndingDefinition {
  key: string;
  title: string;
  rarity: "common" | "uncommon" | "rare" | "secret";
  /** Evaluated against final state; first match (rarest first) wins. */
  when: (s: StoryState) => boolean;
  summary: (s: StoryState) => string;
  finalLine: (s: StoryState) => string;
}
