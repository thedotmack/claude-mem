import { after } from "next/server";
import { z } from "zod";

import { fail, ok, statusFor } from "@/lib/api";
import { computeStartingEmotions } from "@/lib/engine/facecard";
import { enqueueSceneJob, runSceneJob } from "@/lib/jobs";
import { checkQuota, getFlags, rateLimit } from "@/lib/limits";
import { createStory } from "@/lib/story-service";
import { requireUser } from "@/lib/supabase/server";
import type { FaceCard } from "@/lib/engine/types";

const Body = z.object({
  templateKey: z.string().optional(),
  remixedFrom: z.string().uuid().optional(),
  challengeOf: z.string().uuid().optional(),
});

export async function POST(req: Request) {
  try {
    const { supabase, user } = await requireUser();

    if (!rateLimit(`story:${user.id}`, 6, 60_000)) return fail("Too many stories at once. Breathe.", 429);

    const flags = await getFlags(supabase);
    if (flags.signups_enabled === false) return fail("Story creation is paused.", 503);

    const quota = await checkQuota(supabase, "story");
    if (!quota.ok) return fail(quota.reason ?? "Daily limit reached.", 429);

    const parsed = Body.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return fail("Invalid request body.", 400);

    const { data: cardRow } = await supabase
      .from("face_cards").select("*").eq("user_id", user.id).eq("is_active", true).maybeSingle();
    if (!cardRow) return fail("Create your Face Card first.", 409);

    const card: FaceCard = {
      username: cardRow.username as string,
      score: cardRow.score as number,
      archetype: cardRow.archetype as string,
      archetypeKey: cardRow.archetype_key as string,
      era: cardRow.era as string,
      eraKey: cardRow.era_key as string,
      signatureLine: cardRow.signature_line as string,
      stats: cardRow.stats as FaceCard["stats"],
      traits: (cardRow.traits as string[]) ?? [],
      portraitUrl: cardRow.portrait_url as string | null,
    };

    const { story } = await createStory(
      supabase,
      user.id,
      { id: cardRow.id as string, card, startingEmotions: computeStartingEmotions(cardRow.answers as Record<string, string>) },
      parsed.data,
    );

    // Remix / challenge bookkeeping so the social graph stays truthful.
    if (parsed.data.remixedFrom) {
      const { data: src } = await supabase
        .from("movies").select("id, story_id").eq("story_id", parsed.data.remixedFrom).maybeSingle();
      if (src) {
        await supabase.from("remixes").insert({
          source_movie_id: src.id, source_story_id: src.story_id,
          new_story_id: story.id, user_id: user.id,
        });
      }
    }

    const job = await enqueueSceneJob(supabase, { storyId: story.id as string, userId: user.id });
    after(async () => {
      try { await runSceneJob(supabase, job.id as string); } catch { /* poller retries */ }
    });

    return ok({ storyId: story.id, jobId: job.id, title: story.title, genre: story.genre, logline: story.logline });
  } catch (err) {
    return fail(err instanceof Error ? err.message : "Unexpected error", statusFor(err));
  }
}
