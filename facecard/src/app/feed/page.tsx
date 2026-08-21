import { getServerSupabase } from "@/lib/supabase/server";
import { TRENDING_PROMPTS } from "@/lib/engine/templates";
import FeedList from "@/components/FeedList";
import NewStoryButton from "@/components/NewStoryButton";
import NavBar from "@/components/NavBar";

export const metadata = { title: "Feed" };
export const dynamic = "force-dynamic";

export default async function FeedPage() {
  const supabase = await getServerSupabase();
  const { data: auth } = await supabase.auth.getUser();

  const { data: movies } = await supabase
    .from("movies")
    .select("id, story_id, title, genre, ending_title, ending_rarity, decision_count, views, likes_count, comments_count, remix_count, created_at, user_id")
    .eq("published", true)
    .order("created_at", { ascending: false })
    .limit(30);

  const userIds = Array.from(new Set((movies ?? []).map((m) => m.user_id as string)));
  const storyIds = (movies ?? []).map((m) => m.story_id as string);

  const [{ data: profiles }, { data: cards }, { data: posters }, { data: myLikes }] = await Promise.all([
    userIds.length
      ? supabase.from("profiles").select("id, username, avatar_url").in("id", userIds)
      : Promise.resolve({ data: [] as { id: string; username: string; avatar_url: string | null }[] }),
    userIds.length
      ? supabase.from("face_cards").select("user_id, score, archetype, era, portrait_url").in("user_id", userIds).eq("is_active", true)
      : Promise.resolve({ data: [] as Record<string, unknown>[] }),
    storyIds.length
      ? supabase.from("movie_assets").select("story_id, url").eq("kind", "poster").in("story_id", storyIds)
      : Promise.resolve({ data: [] as { story_id: string; url: string }[] }),
    auth.user
      ? supabase.from("likes").select("movie_id").eq("user_id", auth.user.id)
      : Promise.resolve({ data: [] as { movie_id: string }[] }),
  ]);

  const byUser = new Map((profiles ?? []).map((p) => [p.id, p]));
  const cardByUser = new Map((cards ?? []).map((c) => [c.user_id as string, c]));
  const posterByStory = new Map((posters ?? []).map((p) => [p.story_id, p.url]));
  const liked = new Set((myLikes ?? []).map((l) => l.movie_id as string));

  const items = (movies ?? []).map((m) => ({
    id: m.id as string,
    storyId: m.story_id as string,
    title: m.title as string,
    genre: m.genre as string,
    endingTitle: (m.ending_title as string) ?? "",
    rarity: (m.ending_rarity as string) ?? "common",
    decisions: (m.decision_count as number) ?? 0,
    views: (m.views as number) ?? 0,
    likes: (m.likes_count as number) ?? 0,
    comments: (m.comments_count as number) ?? 0,
    remixes: (m.remix_count as number) ?? 0,
    poster: posterByStory.get(m.story_id as string) ?? null,
    creator: byUser.get(m.user_id as string)?.username ?? "someone",
    creatorId: m.user_id as string,
    score: (cardByUser.get(m.user_id as string)?.score as number) ?? null,
    archetype: (cardByUser.get(m.user_id as string)?.archetype as string) ?? "",
    liked: liked.has(m.id as string),
  }));

  return (
    <main className="relative min-h-dvh bg-black pb-28">
      <div
        className="pointer-events-none fixed inset-0"
        style={{ background: "radial-gradient(100% 50% at 50% 0%, rgba(216,176,114,0.10), transparent 58%)" }}
      />

      <div className="relative z-10 mx-auto w-full max-w-2xl px-5 pt-[max(1.5rem,env(safe-area-inset-top))]">
        <header className="flex items-center justify-between">
          <h1 className="display text-[1.5rem]">FACE CARD</h1>
          <NewStoryButton label="New movie" />
        </header>

        {/* Trending premises (spec §20) */}
        <section className="mt-7">
          <p className="kicker">Trending right now</p>
          <div className="no-scrollbar -mx-5 mt-3 flex gap-3 overflow-x-auto px-5 pb-1">
            {TRENDING_PROMPTS.map((p) => (
              <NewStoryButton
                key={p.key}
                templateKey={p.key}
                className="min-w-[220px] shrink-0"
                variant="card"
                label={p.title}
                sub={p.logline}
              />
            ))}
          </div>
        </section>

        <section className="mt-9">
          <p className="kicker">Movies people made</p>
          {items.length === 0 ? (
            <div className="glass mt-4 px-6 py-9 text-center">
              <p className="text-[0.92rem] text-[color:var(--color-muted)]">
                Nobody&apos;s finished a movie yet. Be the first.
              </p>
              <div className="mt-5 flex justify-center">
                <NewStoryButton label="Make the first one" />
              </div>
            </div>
          ) : (
            <FeedList items={items} signedIn={Boolean(auth.user)} />
          )}
        </section>
      </div>

      <NavBar active="feed" signedIn={Boolean(auth.user)} />
    </main>
  );
}
