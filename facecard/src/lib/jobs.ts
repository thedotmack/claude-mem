import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

import { generateClip, generateFrame, generateScore, generateVoice, polishScene } from "@/lib/ai/providers";
import { recordUsage } from "@/lib/limits";
import { loadStory, nextComposedScene, persistScene, stateToRow } from "@/lib/story-service";
import type { ComposedScene } from "@/lib/engine/types";

/**
 * Async generation pipeline (spec §13). Every expensive step is a stage with
 * its own status so the player can watch:
 *   SCRIPT → VISUALS → VOICE → AUDIO → FINAL CUT → PLAY
 * A failed stage retries; a permanently failed job never destroys the story —
 * the scene stays resumable.
 */

export const STAGES = ["SCRIPT", "VISUALS", "VOICE", "AUDIO", "FINAL CUT"] as const;
export type Stage = (typeof STAGES)[number];

export interface StageState { name: Stage; status: "pending" | "running" | "done" | "failed" }

const freshStages = (): StageState[] => STAGES.map((name) => ({ name, status: "pending" }));

export async function enqueueSceneJob(
  supabase: SupabaseClient,
  args: { storyId: string; userId: string; sceneId?: string | null },
) {
  const { data, error } = await supabase
    .from("generation_jobs")
    .insert({
      story_id: args.storyId,
      user_id: args.userId,
      scene_id: args.sceneId ?? null,
      kind: "scene",
      status: "queued",
      stage: "SCRIPT",
      stages: freshStages(),
    })
    .select()
    .single();
  if (error || !data) throw new Error(error?.message ?? "JOB_ENQUEUE_FAILED");
  return data;
}

async function setStage(
  supabase: SupabaseClient,
  jobId: string,
  stages: StageState[],
  name: Stage,
  status: StageState["status"],
) {
  const next = stages.map((s) => (s.name === name ? { ...s, status } : s));
  await supabase.from("generation_jobs").update({ stage: name, stages: next, status: "running" }).eq("id", jobId);
  return next;
}

/**
 * Runs a queued scene job to completion. Safe to call more than once: a job
 * already succeeded is a no-op, and a running-but-stale job is reclaimed.
 */
export async function runSceneJob(supabase: SupabaseClient, jobId: string) {
  const { data: job } = await supabase.from("generation_jobs").select("*").eq("id", jobId).single();
  if (!job) throw new Error("JOB_NOT_FOUND");
  if (job.status === "succeeded") return job;

  const staleMs = job.locked_at ? Date.now() - new Date(job.locked_at as string).getTime() : Infinity;
  if (job.status === "running" && staleMs < 60_000) return job; // another runner owns it

  const attempts = Number(job.attempts ?? 0);
  if (attempts >= Number(job.max_attempts ?? 3)) return job;

  await supabase
    .from("generation_jobs")
    .update({ status: "running", attempts: attempts + 1, locked_at: new Date().toISOString() })
    .eq("id", jobId);

  let stages: StageState[] = (job.stages as StageState[])?.length ? (job.stages as StageState[]) : freshStages();
  const storyId = job.story_id as string;
  const userId = job.user_id as string;

  try {
    /* ── SCRIPT ─────────────────────────────────────────────────────── */
    stages = await setStage(supabase, jobId, stages, "SCRIPT", "running");

    const loaded = await loadStory(supabase, storyId);
    const { scene, state } = nextComposedScene(loaded);

    const polished = await polishScene({
      scene,
      bible: loaded.bible,
      recentMemory: loaded.state.memory.slice(-4).map((m) => m.text),
    });
    await recordUsage(supabase, {
      storyId, provider: polished.provider, model: polished.model,
      kind: "script", costUsd: polished.costUsd, durationMs: polished.durationMs,
    });
    const finalScene: ComposedScene = polished.data;

    const { data: last } = await supabase
      .from("scenes").select("id, seq").eq("story_id", storyId)
      .order("seq", { ascending: false }).limit(1).maybeSingle();

    const seq = (last?.seq ?? -1) + 1;
    const sceneRow = await persistScene(supabase, {
      storyId, userId, seq, previousSceneId: (last?.id as string) ?? null,
      scene: finalScene, state,
    });
    await supabase.from("story_states").update(stateToRow(state)).eq("story_id", storyId);
    await supabase.from("generation_jobs").update({ scene_id: sceneRow.id }).eq("id", jobId);
    stages = await setStage(supabase, jobId, stages, "SCRIPT", "done");

    /* ── VISUALS ────────────────────────────────────────────────────── */
    stages = await setStage(supabase, jobId, stages, "VISUALS", "running");

    const c = finalScene.cinematography;
    const prompt = `cinematic film still, ${finalScene.script.slug}. ${c.framing}. ${c.lighting}. ${c.cameraMove}. ${loaded.bible.visualSignature}. anamorphic, 35mm grain, muted filmic colour, no text`;

    const frame = await generateFrame({
      seed: `${storyId}-${sceneRow.id}`,
      cinematography: c,
      slug: finalScene.script.slug,
      progress: Math.min(1, seq / 7),
      prompt,
    });
    await recordUsage(supabase, {
      storyId, provider: frame.provider, model: frame.model,
      kind: "image", costUsd: frame.costUsd, durationMs: frame.durationMs,
    });

    let stillUrl = frame.data.url ?? "";
    if (!stillUrl && frame.data.svg) {
      stillUrl = await uploadAsset(supabase, {
        userId, storyId,
        path: `${sceneRow.id}.svg`,
        body: frame.data.svg,
        contentType: "image/svg+xml",
      });
    }

    const clip = await generateClip({
      prompt, seed: `${storyId}-${sceneRow.id}`, durationSeconds: finalScene.estimatedSeconds,
    });
    await recordUsage(supabase, {
      storyId, provider: clip.provider, model: clip.model,
      kind: "video", costUsd: clip.costUsd, durationMs: clip.durationMs,
    });

    await supabase.from("movie_assets").insert({
      story_id: storyId, scene_id: sceneRow.id, kind: "still", url: stillUrl,
      meta: { provider: frame.provider, motion: clip.data.motion ?? null, video: clip.data.url ?? null },
    });
    stages = await setStage(supabase, jobId, stages, "VISUALS", "done");

    /* ── VOICE ──────────────────────────────────────────────────────── */
    stages = await setStage(supabase, jobId, stages, "VOICE", "running");

    const spoken = finalScene.script.lines
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => l.type === "dialogue" || l.type === "voiceover");

    const voices: Record<number, { url?: string; speak?: unknown }> = {};
    for (const { l, i } of spoken.slice(0, 12)) {
      const text = "text" in l ? l.text : "";
      const v = await generateVoice({
        text,
        delivery: l.type === "voiceover" ? "internal, low" : ("delivery" in l && l.delivery) || c.pacing,
        voiceHint: l.type === "dialogue" && "who" in l ? l.who : "narrator",
      });
      voices[i] = v.data;
      if (v.costUsd > 0) {
        await recordUsage(supabase, {
          storyId, provider: v.provider, model: v.model,
          kind: "voice", costUsd: v.costUsd, durationMs: v.durationMs,
        });
      }
    }
    stages = await setStage(supabase, jobId, stages, "VOICE", "done");

    /* ── AUDIO ──────────────────────────────────────────────────────── */
    stages = await setStage(supabase, jobId, stages, "AUDIO", "running");
    const intensity = Math.min(1, Math.abs(state.emotions[c.dominant] - 50) / 40 + 0.4);
    const score = await generateScore(c.dominant, intensity);
    stages = await setStage(supabase, jobId, stages, "AUDIO", "done");

    /* ── FINAL CUT ──────────────────────────────────────────────────── */
    stages = await setStage(supabase, jobId, stages, "FINAL CUT", "running");
    await supabase
      .from("scenes")
      .update({
        status: "ready",
        generated_assets: {
          still: stillUrl,
          video: clip.data.url ?? null,
          motion: clip.data.motion ?? "directive",
          voices,
          score: score.data,
          providers: { image: frame.provider, video: clip.provider, script: polished.provider },
        },
      })
      .eq("id", sceneRow.id);

    await supabase.from("story_states").update({ current_scene_id: sceneRow.id }).eq("story_id", storyId);
    stages = await setStage(supabase, jobId, stages, "FINAL CUT", "done");

    await supabase.from("generation_jobs")
      .update({ status: "succeeded", stage: "PLAY", stages, result: { scene_id: sceneRow.id }, error: null })
      .eq("id", jobId);

    await recordUsage(supabase, {
      storyId, provider: "facecard", model: "scene-pipeline",
      kind: "scene", costUsd: 0, durationMs: 0,
    });

    return { ok: true, sceneId: sceneRow.id };
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    const willRetry = attempts + 1 < Number(job.max_attempts ?? 3);
    await supabase
      .from("generation_jobs")
      .update({
        status: willRetry ? "queued" : "failed",
        error: message,
        stages: stages.map((s) => (s.status === "running" ? { ...s, status: "failed" } : s)),
        locked_at: null,
      })
      .eq("id", jobId);
    throw err;
  }
}

/**
 * Persistent asset storage (spec: "Do not depend on temporary browser URLs").
 * Objects are written under {userId}/... which is exactly what the storage RLS
 * policy permits, and served from a public CDN URL.
 */
export async function uploadAsset(
  supabase: SupabaseClient,
  args: { userId: string; storyId: string; path: string; body: string | Blob; contentType: string },
): Promise<string> {
  const objectPath = `${args.userId}/${args.storyId}/${args.path}`;
  const body = typeof args.body === "string" ? new Blob([args.body], { type: args.contentType }) : args.body;

  const { error } = await supabase.storage
    .from("media")
    .upload(objectPath, body, { contentType: args.contentType, upsert: true });
  if (error) throw new Error(`STORAGE_UPLOAD_FAILED: ${error.message}`);

  const { data } = supabase.storage.from("media").getPublicUrl(objectPath);
  return data.publicUrl;
}
