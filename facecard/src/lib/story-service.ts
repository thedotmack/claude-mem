import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

import { buildCharacterBible } from "@/lib/engine/bible";
import { resolveEnding } from "@/lib/engine/endings";
import { normalize } from "@/lib/engine/emotions";
import { applyChoice, composeScene, initialStoryState, mergeCallbackFlags, type StoryTemplate } from "@/lib/engine/story";
import { getTemplate, pickTemplateFor } from "@/lib/engine/templates";
import type { CharacterBible, ComposedScene, FaceCard, StoryState } from "@/lib/engine/types";

/* --------------------------------------------------------------- mapping */

type Row = Record<string, unknown>;

export function rowToState(row: Row): StoryState {
  return {
    beatIndex: Number(row.beat_index ?? 0),
    branch: (row.available_branches as string[]) ?? [],
    emotions: normalize(row.emotions as never),
    openingEmotions: normalize(row.opening_emotions as never),
    relationships: (row.relationships as StoryState["relationships"]) ?? {},
    flags: (row.flags as StoryState["flags"]) ?? {},
    inventory: (row.inventory as string[]) ?? [],
    memory: (row.memory as StoryState["memory"]) ?? [],
    previousChoices: (row.previous_choices as StoryState["previousChoices"]) ?? [],
    completedBranches: (row.completed_branches as string[]) ?? [],
    availableBranches: (row.available_branches as string[]) ?? [],
    characterTraits: (row.character_traits as Record<string, number>) ?? {},
  };
}

export function stateToRow(s: StoryState) {
  return {
    beat_index: s.beatIndex,
    choice_count: s.previousChoices.length,
    emotions: s.emotions,
    opening_emotions: s.openingEmotions,
    relationships: s.relationships,
    flags: s.flags,
    inventory: s.inventory,
    memory: s.memory,
    previous_choices: s.previousChoices,
    completed_branches: s.completedBranches,
    available_branches: s.branch,
    character_traits: s.characterTraits,
  };
}

/* ------------------------------------------------------------- accessors */

export interface LoadedStory {
  story: Row;
  state: StoryState;
  bible: CharacterBible;
  template: StoryTemplate;
}

export async function loadStory(supabase: SupabaseClient, storyId: string): Promise<LoadedStory> {
  const { data: story, error } = await supabase.from("stories").select("*").eq("id", storyId).single();
  if (error || !story) throw new Error("STORY_NOT_FOUND");

  const { data: stateRow } = await supabase.from("story_states").select("*").eq("story_id", storyId).single();
  if (!stateRow) throw new Error("STATE_NOT_FOUND");

  const { data: charRow } = await supabase
    .from("character_profiles").select("bible").eq("face_card_id", story.face_card_id).maybeSingle();

  const template = getTemplate(story.template_key as string);
  if (!template) throw new Error("TEMPLATE_NOT_FOUND");

  return {
    story,
    state: rowToState(stateRow),
    bible: (charRow?.bible as CharacterBible) ?? fallbackBible(story.title as string),
    template,
  };
}

function fallbackBible(title: string): CharacterBible {
  return {
    name: "YOU", identity: title, appearance: "", wardrobe: "", personality: "",
    speechStyle: "direct", humor: "dry", strengths: [], weaknesses: [], motivations: [],
    fears: [], goals: [], contradictions: [], relationships: [], arc: "", visualSignature: "",
  };
}

/* --------------------------------------------------------------- create */

export async function createStory(
  supabase: SupabaseClient,
  userId: string,
  faceCard: { id: string; card: FaceCard; startingEmotions: Record<string, number> },
  opts: { templateKey?: string; remixedFrom?: string; challengeOf?: string },
) {
  const template =
    (opts.templateKey ? getTemplate(opts.templateKey) : null) ??
    pickTemplateFor(faceCard.card.eraKey, faceCard.card.stats.chaos);

  const title = personalizeTitle(template, faceCard.card);

  const { data: story, error } = await supabase
    .from("stories")
    .insert({
      user_id: userId,
      face_card_id: faceCard.id,
      template_key: template.key,
      title,
      genre: template.genre,
      logline: template.logline,
      poster_seed: `${template.key}-${faceCard.id}`,
      remixed_from: opts.remixedFrom ?? null,
      challenge_of: opts.challengeOf ?? null,
    })
    .select()
    .single();
  if (error || !story) throw new Error(error?.message ?? "STORY_CREATE_FAILED");

  const state = initialStoryState(normalize(faceCard.startingEmotions as never));
  const { error: stateErr } = await supabase
    .from("story_states")
    .insert({ story_id: story.id, user_id: userId, ...stateToRow(state) });
  if (stateErr) throw new Error(stateErr.message);

  // Seed the relationship table so the social graph inside the story is real.
  await supabase.from("relationships").insert(
    Object.entries(state.relationships).map(([key, r]) => ({
      story_id: story.id, character_key: key, name: r.name, role: r.role,
      affinity: r.affinity, trust: r.trust, status: r.status,
    })),
  );

  return { story, template, state };
}

function personalizeTitle(template: StoryTemplate, card: FaceCard): string {
  if (template.key === "one_night_left" && card.stats.chaos > 72) return "ONE NIGHT LEFT";
  return template.title;
}

/* ------------------------------------------------------------- composing */

export function nextComposedScene(loaded: LoadedStory): { scene: ComposedScene; state: StoryState } {
  const working = structuredClone(loaded.state);
  const scene = composeScene(loaded.template, working, loaded.bible);
  // composeScene marks consumed memory callbacks on its own clone; carry them back.
  return { scene, state: mergeCallbackFlags(working, loaded.state) };
}

export async function persistScene(
  supabase: SupabaseClient,
  args: {
    storyId: string; userId: string; seq: number; previousSceneId: string | null;
    scene: ComposedScene; state: StoryState;
  },
) {
  const { scene } = args;
  const { data, error } = await supabase
    .from("scenes")
    .insert({
      story_id: args.storyId,
      user_id: args.userId,
      seq: args.seq,
      previous_scene: args.previousSceneId,
      beat_key: scene.beatKey,
      branch_key: scene.branchKey,
      title: scene.title,
      script: scene.script,
      cinematography: scene.cinematography,
      available_choices: scene.choices,
      emotional_state: args.state.emotions,
      character_state: { traits: args.state.characterTraits, relationships: args.state.relationships },
      status: "generating",
      is_final: scene.isFinal,
    })
    .select()
    .single();
  if (error || !data) throw new Error(error?.message ?? "SCENE_INSERT_FAILED");

  await supabase.from("emotional_states").insert({
    story_id: args.storyId, scene_id: data.id,
    emotions: args.state.emotions, dominant: scene.cinematography.dominant,
  });

  return data;
}

/* ---------------------------------------------------------------- choose */

export async function applyPlayerChoice(
  supabase: SupabaseClient,
  args: { storyId: string; userId: string; sceneId: string; choiceKey: string },
) {
  const loaded = await loadStory(supabase, args.storyId);

  const { data: sceneRow } = await supabase
    .from("scenes").select("*").eq("id", args.sceneId).eq("story_id", args.storyId).single();
  if (!sceneRow) throw new Error("SCENE_NOT_FOUND");
  if (sceneRow.selected_choice) throw new Error("CHOICE_ALREADY_MADE");

  const choices = (sceneRow.available_choices as { key: string; label: string; kind: string; effects: unknown }[]) ?? [];
  const choice = choices.find((c) => c.key === args.choiceKey);
  if (!choice) throw new Error("INVALID_CHOICE");

  const nextState = applyChoice(loaded.state, sceneRow.beat_key as string, choice as never, sceneRow.seq as number);

  await supabase.from("scenes").update({ selected_choice: choice }).eq("id", args.sceneId);
  await supabase.from("choices").insert({
    story_id: args.storyId, scene_id: args.sceneId, user_id: args.userId,
    choice_key: choice.key, label: choice.label, effects: choice.effects, seq: sceneRow.seq as number,
  });
  await supabase.from("story_states").update(stateToRow(nextState)).eq("story_id", args.storyId);

  // Mirror relationship changes into the relational table.
  for (const [key, rel] of Object.entries(nextState.relationships)) {
    await supabase.from("relationships")
      .update({ affinity: rel.affinity, trust: rel.trust, status: rel.status })
      .eq("story_id", args.storyId).eq("character_key", key);
  }

  return { state: nextState, seq: sceneRow.seq as number };
}

/* -------------------------------------------------------------- complete */

export async function completeStory(
  supabase: SupabaseClient,
  args: { storyId: string; userId: string },
) {
  const loaded = await loadStory(supabase, args.storyId);
  const ending = resolveEnding(loaded.state);

  const { count } = await supabase
    .from("scenes").select("id", { count: "exact", head: true }).eq("story_id", args.storyId);

  const slug = `${(loaded.story.title as string).toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 28)}-${args.storyId.slice(0, 8)}`;

  const { data: movie, error: movieErr } = await supabase
    .from("movies")
    .upsert({
      story_id: args.storyId,
      user_id: args.userId,
      face_card_id: loaded.story.face_card_id,
      title: loaded.story.title,
      genre: loaded.story.genre,
      logline: loaded.story.logline,
      ending_key: ending.key,
      ending_title: ending.title,
      ending_rarity: ending.rarity,
      decision_count: ending.decisionCount,
      scene_count: count ?? 0,
      duration_seconds: (count ?? 0) * 28,
      poster_seed: loaded.story.poster_seed,
      share_slug: slug,
    }, { onConflict: "story_id" })
    .select()
    .single();
  if (movieErr) throw new Error(movieErr.message);

  await supabase.from("endings").upsert({
    story_id: args.storyId, movie_id: movie.id, user_id: args.userId,
    ending_key: ending.key, title: ending.title, rarity: ending.rarity,
    summary: ending.summary, final_line: ending.finalLine, arc: ending.arc,
  }, { onConflict: "story_id" });

  await supabase.from("stories")
    .update({ status: "completed", completed_at: new Date().toISOString() })
    .eq("id", args.storyId);

  const xp = ending.rarity === "secret" ? 250 : ending.rarity === "rare" ? 150 : ending.rarity === "uncommon" ? 100 : 60;
  await supabase.rpc("award_xp", {
    p_kind: `ending:${ending.key}`, p_xp: xp,
    p_meta: { story_id: args.storyId, rarity: ending.rarity },
  });

  return { ending, movie };
}
