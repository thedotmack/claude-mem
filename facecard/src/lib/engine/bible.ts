import type { CharacterBible, FaceCard } from "./types";

/**
 * Builds the cinematic character bible from the Face Card (spec §4).
 * The builtin composer assembles it from the trait system; when an LLM
 * provider is configured the provider layer enriches this same structure.
 */

const APPEARANCE_BY_ERA: Record<string, { appearance: string; wardrobe: string }> = {
  main_character: { appearance: "carries themselves like the camera already found them — shoulders open, chin level", wardrobe: "clean fits, one statement layer, nothing accidental" },
  villain: { appearance: "unhurried, precise movements; holds eye contact half a second too long", wardrobe: "dark monochrome, tailored, zero logos" },
  healing: { appearance: "softer edges, guarded posture that loosens when they laugh", wardrobe: "comfortable neutrals, a hood ready to go up" },
  crashout: { appearance: "restless energy, hands always moving, laugh arrives a beat too loud", wardrobe: "whatever was closest — somehow still works" },
  ceo: { appearance: "checks the time like the time works for them", wardrobe: "pressed lines, muted palette, expensive watch" },
  heartbreaker: { appearance: "smiles with the eyes first; knows exactly what it does", wardrobe: "effortless pieces that read as accidental and aren't" },
  lowkey: { appearance: "occupies corners of rooms, notices everything, comments on nothing", wardrobe: "quiet layers, cap low, sneakers older than the friendship" },
  chaotic: { appearance: "moves like a plot twist, grins mid-thought", wardrobe: "clashing pieces worn with total conviction" },
  mysterious: { appearance: "still face, unreadable; leaves gaps in every story", wardrobe: "dark layers, collar up, nothing identifying" },
  npc_to_main: { appearance: "used to being background — the posture is changing scene by scene", wardrobe: "basics upgraded one piece at a time" },
};

const SPEECH_BY_HUMOR: Record<string, { speechStyle: string; humor: string }> = {
  deadpan: { speechStyle: "flat delivery, perfect timing, never explains the joke", humor: "deadpan — the funnier it is, the less the face moves" },
  chaotic_funny: { speechStyle: "starts sentences in the middle, finishes other people's", humor: "chaotic — escalates any situation purely to see what happens" },
  dry: { speechStyle: "short sentences with an edge; compliments that require a second listen", humor: "dry and a little mean — affection disguised as insult" },
  loud: { speechStyle: "volume as punctuation; narrates their own life in real time", humor: "loud — everything is either the best or worst thing that ever happened" },
  dark: { speechStyle: "measured, then a left turn nobody was braced for", humor: "dark — jokes at the exact wrong moment, lands anyway" },
  wholesome: { speechStyle: "teases hard but never where it hurts; remembers small details", humor: "secretly wholesome — the roast ends in a compliment" },
};

function pickMotivations(card: FaceCard): string[] {
  const m: string[] = [];
  const s = card.stats;
  if (s.ambition >= 62) m.push("to build something nobody can take back");
  if (s.loyalty >= 62) m.push("to protect the short list of people who showed up");
  if (s.risk >= 62) m.push("to feel the moment where everything could go either way");
  if (s.confidence >= 62) m.push("to be undeniable in the rooms that doubted them");
  if (s.chaos >= 62) m.push("to never, ever be bored again");
  if (m.length === 0) m.push("to figure out what they actually want before it's chosen for them");
  return m.slice(0, 3);
}

function pickFears(card: FaceCard): string[] {
  const f: string[] = [];
  const t = new Set(card.traits);
  if (t.has("needs to matter")) f.push("being forgotten");
  if (t.has("suspicious")) f.push("being used by someone they let in");
  if (t.has("refuses ordinary")) f.push("an average life");
  if (t.has("needs people")) f.push("ending up alone and pretending it was the plan");
  if (t.has("hiding something")) f.push("the day the truth surfaces on its own");
  if (t.has("overthinker")) f.push("making the wrong call with everyone watching");
  if (f.length === 0) f.push("wanting something openly and not getting it");
  return f.slice(0, 3);
}

function pickContradictions(card: FaceCard): string[] {
  const s = card.stats;
  const out: string[] = [];
  if (s.loyalty >= 58 && s.chaos >= 58) out.push("would burn a bridge for fun but never one with a friend on it");
  if (s.confidence >= 58 && new Set(card.traits).has("overthinker")) out.push("projects total certainty while running every scenario twice");
  if (s.ambition >= 58 && s.loyalty >= 58) out.push("wants the crown and wants everyone to keep liking them — picks daily");
  if (s.risk >= 58 && new Set(card.traits).has("careful")) out.push("triple-checks the plan, then abandons it mid-execution");
  if (out.length === 0) out.push("talks like nothing matters; keeps everything");
  return out.slice(0, 2);
}

export function buildCharacterBible(card: FaceCard): CharacterBible {
  const era = APPEARANCE_BY_ERA[card.eraKey] ?? APPEARANCE_BY_ERA.main_character;
  const humorKey = card.traits.includes("deadpan") ? "deadpan"
    : card.traits.includes("chaotic-funny") ? "chaotic_funny"
    : card.traits.includes("dry") ? "dry"
    : card.traits.includes("loud") ? "loud"
    : card.traits.includes("dark") ? "dark"
    : "wholesome";
  const speech = SPEECH_BY_HUMOR[humorKey];

  const strengths: string[] = [];
  if (card.stats.confidence >= 60) strengths.push("holds a room without raising their voice");
  if (card.stats.ambition >= 60) strengths.push("out-works everyone quietly");
  if (card.stats.loyalty >= 60) strengths.push("keeps their word even when it costs");
  if (card.stats.risk >= 60) strengths.push("decisive when everyone else freezes");
  if (card.stats.chaos >= 60) strengths.push("thrives when the plan collapses");
  if (strengths.length === 0) strengths.push("reads people faster than they'd ever admit");

  const weaknesses: string[] = [];
  if (card.traits.includes("ego")) weaknesses.push("cannot lose gracefully, even small things");
  if (card.traits.includes("open")) weaknesses.push("trusts first, checks later");
  if (card.traits.includes("impulsive")) weaknesses.push("acts on the feeling, invoices the consequences");
  if (card.traits.includes("overthinker")) weaknesses.push("misses windows while checking them twice");
  if (card.traits.includes("proud")) weaknesses.push("would rather sink than wave for help");
  if (card.traits.includes("devoted")) weaknesses.push("loves past the point of self-preservation");
  if (card.traits.includes("bought")) weaknesses.push("has a price and knows it");
  if (card.traits.includes("bored")) weaknesses.push("detonates stable situations out of restlessness");
  if (weaknesses.length === 0) weaknesses.push("keeps score silently until the ledger explodes");

  return {
    name: card.username.toUpperCase(),
    identity: `${card.archetype} in their ${card.era} era — score ${card.score}, certified.`,
    appearance: era.appearance,
    wardrobe: era.wardrobe,
    personality: `${card.archetype.replace("THE ", "").toLowerCase()} energy: ${card.traits.slice(0, 4).join(", ")}.`,
    speechStyle: speech.speechStyle,
    humor: speech.humor,
    strengths: strengths.slice(0, 3),
    weaknesses: weaknesses.slice(0, 3),
    motivations: pickMotivations(card),
    fears: pickFears(card),
    goals: [`survive the next 24 hours with the ${card.era.toLowerCase()} era intact`],
    contradictions: pickContradictions(card),
    relationships: [
      { name: "DANI", role: "best friend", note: "knows where the bodies aren't buried — yet" },
      { name: "MARA", role: "the one who knows too much", note: "history with the protagonist nobody talks about" },
      { name: "EZRA", role: "the wildcard contact", note: "useful, expensive, never fully on anyone's side" },
    ],
    arc: "starts protecting an image; ends deciding whether the image was ever worth it",
    visualSignature: `${era.appearance}; ${era.wardrobe}; lit like a late-night city scene`,
  };
}
