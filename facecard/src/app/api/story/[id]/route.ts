import { fail, ok, statusFor } from "@/lib/api";
import { requireUser } from "@/lib/supabase/server";

/** Current playable state of a story: latest ready scene + any in-flight job. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const { supabase } = await requireUser();

    const { data: story, error } = await supabase.from("stories").select("*").eq("id", id).single();
    if (error || !story) return fail("STORY_NOT_FOUND", 404);

    const { data: scenes } = await supabase
      .from("scenes")
      .select("id, seq, title, script, cinematography, available_choices, selected_choice, generated_assets, status, is_final")
      .eq("story_id", id)
      .order("seq", { ascending: true });

    const { data: job } = await supabase
      .from("generation_jobs")
      .select("id, status, stage, stages, error")
      .eq("story_id", id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const { data: ending } = await supabase
      .from("endings").select("*").eq("story_id", id).maybeSingle();

    return ok({
      story: {
        id: story.id, title: story.title, genre: story.genre,
        logline: story.logline, status: story.status,
      },
      scenes: scenes ?? [],
      job,
      ending,
    });
  } catch (err) {
    return fail(err instanceof Error ? err.message : "Unexpected error", statusFor(err));
  }
}
