import { emotionShift } from "./emotions";
import { has, kindCount } from "./story";
import type { EmotionKey, EndingDefinition, StoryState } from "./types";

const count = (s: StoryState) => s.previousChoices.length;
const rel = (s: StoryState, k: string) => s.relationships[k];

/**
 * Endings read the JOURNEY, not the character sheet.
 *
 * Every predicate requires evidence from choices the player actually made
 * (choice kinds or story flags); emotional state only ever qualifies that
 * evidence, and where it signals change it is measured against the opening
 * state rather than in absolute terms. Judging on absolute emotion let a
 * strongly-themed Face Card decide the ending before scene one, which would
 * make the choices decorative — the exact failure the product must not have.
 */
const rose = (s: StoryState, k: EmotionKey, by: number) => s.emotions[k] - s.openingEmotions[k] >= by;
const fell = (s: StoryState, k: EmotionKey, by: number) => s.openingEmotions[k] - s.emotions[k] >= by;

export const ENDINGS: EndingDefinition[] = [
  {
    key: "secret_ghost",
    title: "THE GHOST",
    rarity: "secret",
    // Went dark, refused every ally, and never once lied.
    when: (s) =>
      (has(s, "went_dark") || has(s, "killed_phone") || has(s, "deleted_post")) &&
      (has(s, "no_ezra") || has(s, "going_alone") || has(s, "walked_out")) &&
      kindCount(s, "deceptive") === 0 &&
      fell(s, "trust", 8),
    summary: () => "You solved it and then removed yourself from the record entirely.",
    finalLine: () => "You didn't disappear because you lost.\nYou disappeared because you finally could.",
  },
  {
    key: "secret_architect",
    title: "THE ARCHITECT",
    rarity: "secret",
    // Lied through the whole night and still ended up trusted by everyone.
    when: (s) =>
      kindCount(s, "deceptive") >= 3 &&
      rel(s, "mara")?.trust >= 55 &&
      rel(s, "dani")?.trust >= 55 &&
      rose(s, "confidence", 8),
    summary: () => "Everyone walked away believing you were on their side. Everyone was half right.",
    finalLine: () => "The best lie isn't the one nobody catches.\nIt's the one everybody needs.",
  },
  {
    key: "sacrifice",
    title: "THE SACRIFICE",
    rarity: "rare",
    when: (s) =>
      kindCount(s, "selfless") >= 3 &&
      (has(s, "all_in_dani") || has(s, "protected_group") || has(s, "blessed_leaving")) &&
      rose(s, "loyalty", 6),
    summary: () => "You took the hit so somebody else didn't have to. Nobody filmed it.",
    finalLine: () => "You gave up the ending you wanted.\nSomebody else got to keep theirs.",
  },
  {
    key: "empire",
    title: "THE EMPIRE",
    rarity: "rare",
    when: (s) =>
      kindCount(s, "selfish") + kindCount(s, "bold") >= 2 &&
      (has(s, "took_deal") || has(s, "chasing_money") || has(s, "sold_calls") || has(s, "traced_list")) &&
      rose(s, "ambition", 5),
    summary: () => "You didn't survive the night. You monetised it.",
    finalLine: () => "Everyone else was trying to get out.\nYou were pricing the exit.",
  },
  {
    key: "chaos",
    title: "THE CHAOS ENDING",
    rarity: "rare",
    when: (s) => kindCount(s, "chaotic") >= 3 || (kindCount(s, "chaotic") >= 2 && rose(s, "chaos", 10)),
    summary: () => "No plan survived. Neither did the plot. It somehow worked.",
    finalLine: () => "You didn't beat the game.\nYou made it stop asking questions.",
  },
  {
    key: "romance",
    title: "THE ROMANCE",
    rarity: "uncommon",
    when: (s) =>
      has(s, "asked_stay") || has(s, "offered_to_come") ||
      (kindCount(s, "romantic") >= 2 && rose(s, "love", 8)),
    summary: () => "Against the odds and most of the evidence, you chose the person.",
    finalLine: () => "It was never the smart call.\nIt was just the one you'd make again.",
  },
  {
    key: "betrayal",
    title: "THE BETRAYAL",
    rarity: "uncommon",
    when: (s) =>
      has(s, "accused_dani") || has(s, "confronted_dani") ||
      rel(s, "dani")?.trust < 35 ||
      (has(s, "gave_forgery") && rose(s, "regret", 8)),
    summary: () => "Somebody broke first. The argument about who is still running.",
    finalLine: () => "You keep replaying the moment it turned.\nYou keep landing on your own face.",
  },
  {
    key: "redemption",
    title: "THE REDEMPTION",
    rarity: "uncommon",
    when: (s) =>
      kindCount(s, "honest") >= 3 &&
      !has(s, "half_truth") &&
      (has(s, "told_mara") || has(s, "told_truth") || has(s, "chose_truth")),
    summary: () => "You told the truth before it was taken from you. That's the whole trick.",
    finalLine: () => "You didn't get away with it.\nYou got out from under it.",
  },
  {
    key: "escape",
    title: "THE ESCAPE",
    rarity: "common",
    when: (s) =>
      (has(s, "ran_first") || has(s, "going_alone") || has(s, "no_show") || has(s, "walked_out")) &&
      rose(s, "fear", 5),
    summary: () => "You got out clean. Clean is not the same as free.",
    finalLine: () => "You made it to morning.\nYou just didn't bring everyone with you.",
  },
  {
    key: "villain",
    title: "THE VILLAIN",
    rarity: "common",
    when: (s) => kindCount(s, "selfish") + kindCount(s, "aggressive") >= 3,
    summary: (s) => `${count(s)} decisions. You stopped flinching around the fourth one.`,
    finalLine: () => "Maybe you weren't the villain.\nMaybe you just stopped apologising.",
  },
  {
    key: "fall",
    title: "THE FALL",
    rarity: "common",
    when: (s) => rose(s, "regret", 14) || (fell(s, "confidence", 12) && rose(s, "fear", 12)),
    summary: () => "It got away from you one reasonable decision at a time.",
    finalLine: () => "Nothing collapsed all at once.\nThat's what made it hard to notice.",
  },
  {
    key: "hero",
    title: "THE HERO",
    rarity: "common",
    when: (s) => kindCount(s, "selfless") + kindCount(s, "honest") >= 3 && rose(s, "courage", 4),
    summary: () => "You kept showing up for people who couldn't pay you back.",
    finalLine: () => "Nobody's going to make a film about this part.\nYou did it anyway.",
  },
];

/** Fallback so a story ALWAYS resolves to something. */
const DEFAULT_ENDING: EndingDefinition = {
  key: "open_road",
  title: "THE OPEN ROAD",
  rarity: "common",
  when: () => true,
  summary: () => "You survived the night without becoming somebody you'd have to explain.",
  finalLine: () => "The story didn't end.\nIt just stopped needing you to prove anything.",
};

export function resolveEnding(state: StoryState) {
  const order = { secret: 0, rare: 1, uncommon: 2, common: 3 } as const;
  const match =
    [...ENDINGS].sort((a, b) => order[a.rarity] - order[b.rarity]).find((e) => {
      try { return e.when(state); } catch { return false; }
    }) ?? DEFAULT_ENDING;

  const shifts = emotionShift(state.openingEmotions, state.emotions);
  const walkAways = state.previousChoices.filter((c) => c.kind === "cautious" || c.kind === "selfless").length;

  return {
    key: match.key,
    title: match.title,
    rarity: match.rarity,
    summary: match.summary(state),
    finalLine: match.finalLine(state),
    decisionCount: state.previousChoices.length,
    arc: {
      started: state.openingEmotions,
      ended: state.emotions,
      biggestShifts: shifts.slice(0, 3),
      walkAwayChances: walkAways,
    },
  };
}

export type ResolvedEnding = ReturnType<typeof resolveEnding>;
