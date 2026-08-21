import { fail, ok, statusFor } from "@/lib/api";
import { runSceneJob } from "@/lib/jobs";
import { requireUser } from "@/lib/supabase/server";

/**
 * Progress poller. This endpoint is also the self-healing path: if the
 * background runner never started (cold start, dropped invocation) or the job
 * is retryable after a failure, polling picks it back up. A user's story can
 * therefore always be resumed rather than being stranded.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const { supabase } = await requireUser();

    const { data: job, error } = await supabase
      .from("generation_jobs").select("*").eq("id", id).single();
    if (error || !job) return fail("JOB_NOT_FOUND", 404);

    const stale = job.locked_at
      ? Date.now() - new Date(job.locked_at as string).getTime() > 60_000
      : true;

    const retryable =
      (job.status === "queued" || (job.status === "running" && stale)) &&
      Number(job.attempts ?? 0) < Number(job.max_attempts ?? 3);

    if (retryable) {
      try {
        await runSceneJob(supabase, id);
      } catch {
        // Surface the stored error state below instead of throwing at the client.
      }
      const { data: refreshed } = await supabase
        .from("generation_jobs").select("*").eq("id", id).single();
      return ok({ job: shape(refreshed ?? job) });
    }

    return ok({ job: shape(job) });
  } catch (err) {
    return fail(err instanceof Error ? err.message : "Unexpected error", statusFor(err));
  }
}

function shape(job: Record<string, unknown>) {
  return {
    id: job.id,
    status: job.status,
    stage: job.stage,
    stages: job.stages,
    error: job.error,
    sceneId: (job.result as { scene_id?: string } | null)?.scene_id ?? job.scene_id ?? null,
    attempts: job.attempts,
    maxAttempts: job.max_attempts,
  };
}
