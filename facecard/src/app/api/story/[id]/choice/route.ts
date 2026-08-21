import { after } from "next/server";
import { z } from "zod";

import { fail, ok, statusFor } from "@/lib/api";
import { enqueueSceneJob, runSceneJob } from "@/lib/jobs";
import { checkQuota, getLimits, rateLimit } from "@/lib/limits";
import { applyPlayerChoice } from "@/lib/story-service";
import { requireUser } from "@/lib/supabase/server";

const Body = z.object({ sceneId: z.string().uuid(), choiceKey: z.string().min(1).max(64) });

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const { supabase, user } = await requireUser();

    if (!rateLimit(`choice:${user.id}`, 40, 60_000)) return fail("Too fast.", 429);

    const parsed = Body.safeParse(await req.json());
    if (!parsed.success) return fail("Invalid request body.", 400);

    const quota = await checkQuota(supabase, "scene");
    if (!quota.ok) return fail(quota.reason ?? "Daily limit reached.", 429);

    // Applying the choice mutates story state; duplicate submissions are
    // rejected by CHOICE_ALREADY_MADE rather than double-advancing the plot.
    const { state } = await applyPlayerChoice(supabase, {
      storyId: id, userId: user.id, sceneId: parsed.data.sceneId, choiceKey: parsed.data.choiceKey,
    });

    const limits = await getLimits(supabase);
    if (state.beatIndex >= limits.max_scenes_per_story) {
      return ok({ done: true, reason: "max_scenes" });
    }

    const job = await enqueueSceneJob(supabase, { storyId: id, userId: user.id });
    after(async () => {
      try { await runSceneJob(supabase, job.id as string); } catch { /* poller retries */ }
    });

    return ok({ jobId: job.id, choiceCount: state.previousChoices.length });
  } catch (err) {
    return fail(err instanceof Error ? err.message : "Unexpected error", statusFor(err));
  }
}
