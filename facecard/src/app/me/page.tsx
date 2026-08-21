import { redirect } from "next/navigation";
import { getServerSupabase } from "@/lib/supabase/server";
import FaceCardVisual from "@/components/FaceCardVisual";
import NavBar from "@/components/NavBar";
import NewStoryButton from "@/components/NewStoryButton";
import SignOutButton from "@/components/SignOutButton";
import type { FaceCard } from "@/lib/engine/types";

export const metadata = { title: "My profile" };
export const dynamic = "force-dynamic";

export default async function MePage() {
  const supabase = await getServerSupabase();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) redirect("/login?next=/me");

  const [{ data: profile }, { data: cardRow }, { data: stories }, { data: rewards }] = await Promise.all([
    supabase.from("profiles").select("*").eq("id", auth.user.id).single(),
    supabase.from("face_cards").select("*").eq("user_id", auth.user.id).eq("is_active", true).maybeSingle(),
    supabase.from("stories").select("id, title, genre, status, created_at").eq("user_id", auth.user.id).order("created_at", { ascending: false }).limit(30),
    supabase.from("rewards").select("kind, xp, created_at").eq("user_id", auth.user.id).order("created_at", { ascending: false }).limit(8),
  ]);

  const storyIds = (stories ?? []).map((s) => s.id as string);
  const { data: movies } = storyIds.length
    ? await supabase.from("movies").select("story_id, ending_title, ending_rarity, decision_count, views, likes_count").in("story_id", storyIds)
    : { data: [] as Record<string, unknown>[] };
  const movieByStory = new Map((movies ?? []).map((m) => [m.story_id as string, m]));

  const card: FaceCard | null = cardRow
    ? {
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
      }
    : null;

  const unfinished = (stories ?? []).filter((s) => s.status === "active");
  const finished = (stories ?? []).filter((s) => s.status === "completed");

  return (
    <main className="relative min-h-dvh bg-black pb-28">
      <div className="pointer-events-none fixed inset-0" style={{ background: "radial-gradient(100% 50% at 50% 0%, rgba(216,176,114,0.10), transparent 58%)" }} />

      <div className="relative z-10 mx-auto w-full max-w-2xl px-5 pt-[max(1.5rem,env(safe-area-inset-top))]">
        <header className="flex items-start justify-between">
          <div>
            <h1 className="display text-[1.6rem]">@{profile?.username}</h1>
            <p className="kicker mt-1">
              Level {profile?.level ?? 1} · {profile?.xp ?? 0} XP
            </p>
          </div>
          <SignOutButton />
        </header>

        {card ? (
          <div className="mt-8 flex justify-center">
            <FaceCardVisual card={card} />
          </div>
        ) : (
          <div className="glass mt-8 px-6 py-8 text-center">
            <p className="text-[0.92rem] text-[color:var(--color-muted)]">You don&apos;t have a Face Card yet.</p>
            <a href="/create" className="kicker mt-4 inline-block text-[color:var(--color-gold)]">Create one →</a>
          </div>
        )}

        <div className="mt-8 flex justify-center">
          <NewStoryButton label="Start a new movie" />
        </div>

        {/* Unfinished movies are resumable — the core persistence promise. */}
        {unfinished.length > 0 && (
          <section className="mt-10">
            <p className="kicker">Continue watching</p>
            <div className="mt-3 flex flex-col gap-2.5">
              {unfinished.map((s) => (
                <a key={s.id as string} href={`/play/${s.id}`} className="choice-card glass flex items-center justify-between px-5 py-4">
                  <span>
                    <span className="block text-[0.92rem] font-semibold">{s.title as string}</span>
                    <span className="block text-[0.7rem] text-[color:var(--color-muted)]">{s.genre as string}</span>
                  </span>
                  <span className="kicker text-[color:var(--color-gold)]">Resume</span>
                </a>
              ))}
            </div>
          </section>
        )}

        <section className="mt-10">
          <p className="kicker">My movies</p>
          {finished.length === 0 ? (
            <p className="mt-3 text-[0.86rem] text-[color:var(--color-muted)]">No finished movies yet.</p>
          ) : (
            <div className="mt-3 flex flex-col gap-2.5">
              {finished.map((s) => {
                const m = movieByStory.get(s.id as string);
                return (
                  <a key={s.id as string} href={`/m/${s.id}`} className="choice-card glass flex items-center justify-between px-5 py-4">
                    <span className="min-w-0">
                      <span className="block truncate text-[0.92rem] font-semibold">{s.title as string}</span>
                      <span className="block text-[0.7rem] text-[color:var(--color-muted)]">
                        {(m?.ending_title as string) ?? "—"} · {(m?.decision_count as number) ?? 0} choices
                      </span>
                    </span>
                    <span className="kicker shrink-0">
                      {(m?.likes_count as number) ?? 0} ♥ · {(m?.views as number) ?? 0} views
                    </span>
                  </a>
                );
              })}
            </div>
          )}
        </section>

        {rewards && rewards.length > 0 && (
          <section className="mt-10">
            <p className="kicker">Recent rewards</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {rewards.map((r, i) => (
                <span key={i} className="glass-quiet px-3 py-2 text-[0.7rem]">
                  {(r.kind as string).replace(/[:_]/g, " ")} +{r.xp as number}
                </span>
              ))}
            </div>
          </section>
        )}
      </div>

      <NavBar active="me" signedIn />
    </main>
  );
}
