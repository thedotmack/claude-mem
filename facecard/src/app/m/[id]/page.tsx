import { notFound } from "next/navigation";
import type { Metadata } from "next";

import { getServerSupabase } from "@/lib/supabase/server";
import MovieView from "@/components/MovieView";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const supabase = await getServerSupabase();
  const { data } = await supabase
    .from("movies").select("title, ending_title, decision_count").eq("story_id", id).maybeSingle();

  if (!data) return { title: "Movie" };
  return {
    title: data.title as string,
    description: `Ending: ${data.ending_title} · ${data.decision_count} choices. What would you have done?`,
    openGraph: {
      title: `${data.title} — ${data.ending_title}`,
      description: `${data.decision_count} choices. What would you have done?`,
    },
  };
}

/** Public share + watch page (spec §18). Readable without an account. */
export default async function MoviePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await getServerSupabase();
  const { data: auth } = await supabase.auth.getUser();

  const { data: movie } = await supabase.from("movies").select("*").eq("story_id", id).maybeSingle();
  if (!movie) notFound();

  const [{ data: ending }, { data: scenes }, { data: profile }, { data: poster }, { data: comments }] = await Promise.all([
    supabase.from("endings").select("*").eq("story_id", id).maybeSingle(),
    supabase.from("scenes").select("id, seq, title, script, selected_choice, generated_assets").eq("story_id", id).order("seq"),
    supabase.from("profiles").select("id, username").eq("id", movie.user_id as string).maybeSingle(),
    supabase.from("movie_assets").select("url").eq("story_id", id).eq("kind", "poster").maybeSingle(),
    supabase.from("comments").select("id, body, created_at, user_id").eq("movie_id", movie.id as string).order("created_at", { ascending: false }).limit(20),
  ]);

  const commenterIds = Array.from(new Set((comments ?? []).map((c) => c.user_id as string)));
  const { data: commenters } = commenterIds.length
    ? await supabase.from("profiles").select("id, username").in("id", commenterIds)
    : { data: [] as { id: string; username: string }[] };
  const nameById = new Map((commenters ?? []).map((p) => [p.id, p.username]));

  const liked = auth.user
    ? Boolean((await supabase.from("likes").select("id").eq("movie_id", movie.id as string).eq("user_id", auth.user.id).maybeSingle()).data)
    : false;

  return (
    <MovieView
      signedIn={Boolean(auth.user)}
      isOwner={auth.user?.id === movie.user_id}
      movie={{
        id: movie.id as string,
        storyId: id,
        title: movie.title as string,
        genre: movie.genre as string,
        logline: movie.logline as string,
        endingTitle: (movie.ending_title as string) ?? "",
        rarity: (movie.ending_rarity as string) ?? "common",
        decisions: (movie.decision_count as number) ?? 0,
        views: (movie.views as number) ?? 0,
        likes: (movie.likes_count as number) ?? 0,
        remixes: (movie.remix_count as number) ?? 0,
        creator: profile?.username ?? "someone",
        poster: (poster?.url as string) ?? null,
      }}
      ending={ending as never}
      scenes={(scenes ?? []) as never}
      liked={liked}
      comments={(comments ?? []).map((c) => ({
        id: c.id as string,
        body: c.body as string,
        author: nameById.get(c.user_id as string) ?? "someone",
      }))}
    />
  );
}
