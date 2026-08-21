import { z } from "zod";

import { fail, ok, statusFor } from "@/lib/api";
import { moderate } from "@/lib/ai/providers";
import { getFlags, rateLimit } from "@/lib/limits";
import { requireUser } from "@/lib/supabase/server";

const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("like"), movieId: z.string().uuid() }),
  z.object({ action: z.literal("comment"), movieId: z.string().uuid(), body: z.string().min(1).max(500) }),
  z.object({ action: z.literal("follow"), userId: z.string().uuid() }),
  z.object({ action: z.literal("view"), movieId: z.string().uuid() }),
  z.object({ action: z.literal("challenge"), movieId: z.string().uuid() }),
]);

export async function POST(req: Request) {
  try {
    const { supabase, user } = await requireUser();
    const parsed = Body.safeParse(await req.json());
    if (!parsed.success) return fail("Invalid request body.", 400);
    const input = parsed.data;

    if (!rateLimit(`social:${user.id}`, 60, 60_000)) return fail("Too many actions.", 429);

    const flags = await getFlags(supabase);

    switch (input.action) {
      case "like": {
        const { data: existing } = await supabase
          .from("likes").select("id").eq("movie_id", input.movieId).eq("user_id", user.id).maybeSingle();
        if (existing) {
          await supabase.from("likes").delete().eq("id", existing.id);
          return ok({ liked: false });
        }
        const { error } = await supabase.from("likes").insert({ movie_id: input.movieId, user_id: user.id });
        if (error) return fail(error.message, 400);
        return ok({ liked: true });
      }

      case "comment": {
        if (flags.feed_enabled === false) return fail("Comments are paused.", 503);
        const gate = await moderate(input.body);
        if (!gate.data.allowed) return fail("That comment can't be posted.", 400);

        const { data, error } = await supabase
          .from("comments").insert({ movie_id: input.movieId, user_id: user.id, body: input.body })
          .select("id, body, created_at").single();
        if (error) return fail(error.message, 400);
        return ok({ comment: data });
      }

      case "follow": {
        if (input.userId === user.id) return fail("You can't follow yourself.", 400);
        const { data: existing } = await supabase
          .from("followers").select("follower_id")
          .eq("follower_id", user.id).eq("following_id", input.userId).maybeSingle();
        if (existing) {
          await supabase.from("followers").delete()
            .eq("follower_id", user.id).eq("following_id", input.userId);
          return ok({ following: false });
        }
        const { error } = await supabase
          .from("followers").insert({ follower_id: user.id, following_id: input.userId });
        if (error) return fail(error.message, 400);
        await supabase.from("notifications").insert({
          user_id: input.userId, kind: "follow", payload: { by: user.id },
        });
        return ok({ following: true });
      }

      case "view": {
        await supabase.rpc("increment_movie_views", { p_movie: input.movieId });
        return ok({ counted: true });
      }

      case "challenge": {
        if (flags.challenges_enabled === false) return fail("Challenges are paused.", 503);
        const { data: movie } = await supabase
          .from("movies").select("id, story_id, user_id").eq("id", input.movieId).maybeSingle();
        if (!movie) return fail("Movie not found.", 404);

        const code = Math.random().toString(36).slice(2, 8).toUpperCase();
        const { data, error } = await supabase
          .from("challenges")
          .insert({
            code, source_movie_id: movie.id, source_story_id: movie.story_id, from_user: user.id,
          })
          .select("code").single();
        if (error) return fail(error.message, 400);
        return ok({ code: data.code });
      }
    }
  } catch (err) {
    return fail(err instanceof Error ? err.message : "Unexpected error", statusFor(err));
  }
}
