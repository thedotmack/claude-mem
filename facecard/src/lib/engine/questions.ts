import type { EmotionDelta, FaceCardStats } from "./types";

export interface QuestionOption {
  key: string;
  label: string;
  emotions: EmotionDelta;
  stats: Partial<FaceCardStats>;
  traits: string[];
}

export interface Question {
  key: string;
  prompt: string;
  kicker: string;
  options: QuestionOption[];
}

/**
 * Character creation. Every answer is a narrative variable — it moves starting
 * emotions, biases Face Card stats, and tags traits the story reads later.
 */
export const QUESTIONS: Question[] = [
  {
    key: "era",
    prompt: "WHAT'S YOUR CURRENT ERA?",
    kicker: "no wrong answers. only consequences.",
    options: [
      { key: "main_character", label: "MAIN CHARACTER", emotions: { confidence: 14, ambition: 8 }, stats: { confidence: 16 }, traits: ["spotlight", "self-assured"] },
      { key: "villain", label: "VILLAIN", emotions: { confidence: 10, trust: -14, anger: 10 }, stats: { chaos: 12, loyalty: -10 }, traits: ["unbothered", "sharp"] },
      { key: "healing", label: "HEALING", emotions: { regret: 10, trust: 8, anger: -10 }, stats: { loyalty: 10, chaos: -8 }, traits: ["reflective", "guarded"] },
      { key: "crashout", label: "CRASHOUT", emotions: { chaos: 18, anger: 12, confidence: -6 }, stats: { chaos: 18, risk: 10 }, traits: ["volatile", "honest to a fault"] },
      { key: "ceo", label: "CEO", emotions: { ambition: 18, confidence: 10, love: -6 }, stats: { ambition: 18 }, traits: ["calculated", "busy"] },
      { key: "heartbreaker", label: "HEARTBREAKER", emotions: { love: 12, trust: -10, confidence: 8 }, stats: { risk: 10, loyalty: -8 }, traits: ["magnetic", "detached"] },
      { key: "lowkey", label: "LOWKEY", emotions: { fear: 6, confidence: -4, trust: 6 }, stats: { chaos: -12, risk: -8 }, traits: ["private", "observant"] },
      { key: "chaotic", label: "CHAOTIC", emotions: { chaos: 20, risk: 12 }, stats: { chaos: 20, risk: 12 }, traits: ["unpredictable", "funny"] },
      { key: "mysterious", label: "MYSTERIOUS", emotions: { trust: -8, fear: 4 }, stats: { chaos: -6, risk: 8 }, traits: ["withholding", "watchful"] },
      { key: "npc_to_main", label: "NPC → MAIN CHARACTER", emotions: { ambition: 16, confidence: -8, courage: 12 }, stats: { ambition: 14, confidence: -8 }, traits: ["underestimated", "hungry"] },
    ],
  },
  {
    key: "chasing",
    prompt: "WHAT ARE YOU ACTUALLY CHASING?",
    kicker: "be honest. nobody's watching.",
    options: [
      { key: "money", label: "MONEY", emotions: { ambition: 16, love: -6 }, stats: { ambition: 16 }, traits: ["material"] },
      { key: "love", label: "LOVE", emotions: { love: 20, trust: 8 }, stats: { loyalty: 12 }, traits: ["romantic"] },
      { key: "freedom", label: "FREEDOM", emotions: { risk: 14, chaos: 8 }, stats: { risk: 14 }, traits: ["restless"] },
      { key: "respect", label: "RESPECT", emotions: { confidence: 10, anger: 8 }, stats: { confidence: 12 }, traits: ["proud"] },
      { key: "fame", label: "FAME", emotions: { ambition: 14, chaos: 8 }, stats: { ambition: 12, chaos: 8 }, traits: ["seen"] },
      { key: "revenge", label: "REVENGE", emotions: { anger: 22, trust: -12 }, stats: { chaos: 12, loyalty: -8 }, traits: ["scorekeeper"] },
      { key: "peace", label: "PEACE", emotions: { fear: -10, chaos: -14, trust: 8 }, stats: { chaos: -14 }, traits: ["tired"] },
      { key: "proving", label: "PROVING EVERYONE WRONG", emotions: { ambition: 18, anger: 10, courage: 10 }, stats: { ambition: 16, risk: 8 }, traits: ["chip on shoulder"] },
    ],
  },
  {
    key: "betrayal",
    prompt: "SOMEONE YOU TRUST BETRAYS YOU.",
    kicker: "first instinct. don't think.",
    options: [
      { key: "forgive", label: "FORGIVE THEM", emotions: { trust: 14, loyalty: 16, anger: -12 }, stats: { loyalty: 18 }, traits: ["forgiving"] },
      { key: "get_even", label: "GET EVEN", emotions: { anger: 20, chaos: 12, trust: -10 }, stats: { chaos: 14, risk: 10 }, traits: ["vengeful"] },
      { key: "block", label: "BLOCK THEM", emotions: { trust: -14, regret: 6 }, stats: { loyalty: -10, chaos: -6 }, traits: ["final"] },
      { key: "confront", label: "CONFRONT THEM", emotions: { courage: 18, anger: 10 }, stats: { confidence: 14 }, traits: ["direct"] },
      { key: "pretend", label: "PRETEND YOU DON'T CARE", emotions: { regret: 14, fear: 8, trust: -8 }, stats: { chaos: -8 }, traits: ["repressed"] },
    ],
  },
  {
    key: "million",
    prompt: "YOU SUDDENLY RECEIVE $1,000,000.",
    kicker: "the money already cleared.",
    options: [
      { key: "disappear", label: "DISAPPEAR", emotions: { fear: 12, trust: -10, risk: 10 }, stats: { risk: 12, loyalty: -10 }, traits: ["flight risk"] },
      { key: "invest", label: "INVEST IT", emotions: { ambition: 14, chaos: -10 }, stats: { ambition: 14, chaos: -10 }, traits: ["patient"] },
      { key: "flex", label: "FLEX", emotions: { confidence: 14, chaos: 10 }, stats: { confidence: 12, chaos: 10 }, traits: ["loud"] },
      { key: "family", label: "HELP YOUR FAMILY", emotions: { loyalty: 20, love: 12 }, stats: { loyalty: 20 }, traits: ["rooted"] },
      { key: "build", label: "BUILD SOMETHING", emotions: { ambition: 18, courage: 10 }, stats: { ambition: 16 }, traits: ["builder"] },
      { key: "stupid", label: "DO SOMETHING COMPLETELY STUPID", emotions: { chaos: 24, risk: 18 }, stats: { chaos: 22, risk: 16 }, traits: ["menace"] },
    ],
  },
  {
    key: "weakness",
    prompt: "WHAT'S YOUR BIGGEST WEAKNESS?",
    kicker: "this one shows up in act three.",
    options: [
      { key: "ego", label: "EGO", emotions: { confidence: 12, trust: -8 }, stats: { confidence: 10, loyalty: -8 }, traits: ["ego"] },
      { key: "trusting", label: "TRUSTING PEOPLE", emotions: { trust: 18, fear: 6 }, stats: { loyalty: 12, risk: 8 }, traits: ["open"] },
      { key: "impulsive", label: "IMPULSIVE DECISIONS", emotions: { chaos: 18, risk: 16 }, stats: { chaos: 16, risk: 16 }, traits: ["impulsive"] },
      { key: "overthinking", label: "OVERTHINKING", emotions: { fear: 16, confidence: -10 }, stats: { risk: -12 }, traits: ["overthinker"] },
      { key: "pride", label: "PRIDE", emotions: { anger: 12, regret: 8 }, stats: { confidence: 10, loyalty: -6 }, traits: ["proud"] },
      { key: "love_weak", label: "LOVE", emotions: { love: 20, fear: 8 }, stats: { loyalty: 14 }, traits: ["devoted"] },
      { key: "money_weak", label: "MONEY", emotions: { ambition: 16, loyalty: -10 }, stats: { ambition: 14, loyalty: -10 }, traits: ["bought"] },
      { key: "boredom", label: "BOREDOM", emotions: { chaos: 20, risk: 14 }, stats: { chaos: 18, risk: 12 }, traits: ["bored"] },
    ],
  },
  {
    key: "humor",
    prompt: "HOW DO YOU ACTUALLY TALK?",
    kicker: "this becomes your dialogue.",
    options: [
      { key: "deadpan", label: "DEADPAN", emotions: { confidence: 8 }, stats: {}, traits: ["deadpan"] },
      { key: "chaotic_funny", label: "CHAOTICALLY FUNNY", emotions: { chaos: 14 }, stats: { chaos: 10 }, traits: ["chaotic-funny"] },
      { key: "dry", label: "DRY AND MEAN", emotions: { anger: 8, trust: -6 }, stats: {}, traits: ["dry"] },
      { key: "loud", label: "LOUD ABOUT EVERYTHING", emotions: { confidence: 10, chaos: 8 }, stats: { confidence: 8 }, traits: ["loud"] },
      { key: "dark", label: "DARK HUMOR ONLY", emotions: { regret: 8, chaos: 8 }, stats: {}, traits: ["dark"] },
      { key: "wholesome", label: "SECRETLY WHOLESOME", emotions: { love: 12, trust: 10 }, stats: { loyalty: 10 }, traits: ["wholesome"] },
    ],
  },
  {
    key: "alibi",
    prompt: "YOUR FRIEND NEEDS AN ALIBI.",
    kicker: "they won't say what for.",
    options: [
      { key: "lie", label: "LIE FOR THEM", emotions: { loyalty: 20, risk: 12, trust: 6 }, stats: { loyalty: 18, risk: 10 }, traits: ["ride-or-die"] },
      { key: "truth", label: "TELL THE TRUTH", emotions: { courage: 14, loyalty: -12 }, stats: { loyalty: -12 }, traits: ["principled"] },
      { key: "vanish", label: "DISAPPEAR", emotions: { fear: 14, loyalty: -10 }, stats: { risk: -8, loyalty: -8 }, traits: ["avoidant"] },
      { key: "questions", label: "ASK QUESTIONS FIRST", emotions: { trust: -6, confidence: 8 }, stats: { chaos: -8 }, traits: ["careful"] },
    ],
  },
  {
    key: "pressure",
    prompt: "UNDER REAL PRESSURE, YOU GO —",
    kicker: "everyone breaks differently.",
    options: [
      { key: "quiet", label: "QUIET", emotions: { fear: 12, confidence: -6 }, stats: { chaos: -10 }, traits: ["withdraws"] },
      { key: "loud_p", label: "LOUD", emotions: { anger: 16, chaos: 10 }, stats: { chaos: 12 }, traits: ["explodes"] },
      { key: "cold", label: "COLD", emotions: { trust: -10, confidence: 12 }, stats: { confidence: 10, loyalty: -6 }, traits: ["cold"] },
      { key: "funny", label: "FUNNY", emotions: { chaos: 12, fear: 6 }, stats: { chaos: 8 }, traits: ["deflects"] },
    ],
  },
  {
    key: "ending_fear",
    prompt: "WHAT WOULD ACTUALLY END YOU?",
    kicker: "last one. then we build your card.",
    options: [
      { key: "forgotten", label: "BEING FORGOTTEN", emotions: { ambition: 18, fear: 10 }, stats: { ambition: 16 }, traits: ["needs to matter"] },
      { key: "used", label: "BEING USED", emotions: { trust: -16, anger: 10 }, stats: { loyalty: -8 }, traits: ["suspicious"] },
      { key: "average", label: "BEING AVERAGE", emotions: { ambition: 16, chaos: 10 }, stats: { ambition: 14, risk: 10 }, traits: ["refuses ordinary"] },
      { key: "alone", label: "BEING ALONE", emotions: { love: 16, fear: 12 }, stats: { loyalty: 14 }, traits: ["needs people"] },
      { key: "exposed", label: "BEING EXPOSED", emotions: { fear: 18, trust: -10 }, stats: { risk: -8 }, traits: ["hiding something"] },
    ],
  },
];

export const QUESTION_KEYS = QUESTIONS.map((q) => q.key);

export function findOption(questionKey: string, optionKey: string): QuestionOption | null {
  const q = QUESTIONS.find((x) => x.key === questionKey);
  return q?.options.find((o) => o.key === optionKey) ?? null;
}

/** Validates a full answer set came from our own question bank. */
export function validateAnswers(answers: Record<string, string>): { ok: boolean; missing: string[] } {
  const missing = QUESTION_KEYS.filter((k) => !answers[k] || !findOption(k, answers[k]));
  return { ok: missing.length === 0, missing };
}
