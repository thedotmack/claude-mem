import { fail, ok, statusFor } from "@/lib/api";
import { generatePoster } from "@/lib/ai/providers";
import { cinematographyFor, normalize } from "@/lib/engine/emotions";
import { uploadAsset } from "@/lib/jobs";
import { completeStory } from "@/lib/story-service";
import { requireUser } from "@/lib/supabase/server";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const { supabase, user } = await requireUser();

    const { data: existing } = await supabase
      .from("movies").select("id, share_slug").eq("story_id", id).maybeSingle();

    const { ending, movie } = await completeStory(supabase, { storyId: id, userId: user.id });

    // Poster is generated once, then reused for the feed and share cards.
    if (!existing) {
      const { data: state } = await supabase
        .from("story_states").select("emotions").eq("story_id", id).single();
      const { data: story } = await supabase
        .from("stories").select("title, poster_seed").eq("id", id).single();

      const svg = generatePoster({
        seed: (story?.poster_seed as string) ?? id,
        cinematography: cinematographyFor(normalize(state?.emotions as never)),
        slug: "EXT. CITY — DAWN",
        progress: 1,
        title: (story?.title as string) ?? "YOUR MOVIE",
        tagline: ending.title,
      });

      try {
        const url = await uploadAsset(supabase, {
          userId: user.id, storyId: id, path: "poster.svg", body: svg, contentType: "image/svg+xml",
        });
        await supabase.from("movie_assets").insert({
          movie_id: movie.id, story_id: id, kind: "poster", url, meta: { ending: ending.key },
        });
      } catch {
        // A missing poster must never block the ending reveal.
      }
    }

    return ok({ ending, movie: { id: movie.id, shareSlug: movie.share_slug } });
  } catch (err) {
    return fail(err instanceof Error ? err.message : "Unexpected error", statusFor(err));
  }
}
