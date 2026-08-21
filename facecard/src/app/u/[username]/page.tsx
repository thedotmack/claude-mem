import { notFound } from "next/navigation";
import { getServerSupabase } from "@/lib/supabase/server";
import FaceCardVisual from "@/components/FaceCardVisual";
import FollowButton from "@/components/FollowButton";
import type { FaceCard } from "@/lib/engine/types";

export const dynamic = "force-dynamic";

export default async function PublicProfile({ params }: { params: Promise<{ username: string }> }) {
  const { username } = await params;
  const supabase = await getServerSupabase();
  const { data: auth } = await supabase.auth.getUser();

  const { data: profile } = await supabase
    .from("profiles").select("id, username, xp, level").ilike("username", username).maybeSingle();
  if (!profile) notFound();

  const [{ data: cardRow }, { data: movies }, { count: followers }] = await Promise.all([
    supabase.from("face_cards").select("*").eq("user_id", profile.id as string).eq("is_active", true).maybeSingle(),
    supabase.from("movies").select("story_id, title, ending_title, decision_count, likes_count").eq("user_id", profile.id as string).eq("published", true).order("created_at", { ascending: false }).limit(20),
    supabase.from("followers").select("follower_id", { count: "exact", head: true }).eq("following_id", profile.id as string),
  ]);

  const isFollowing = auth.user
    ? Boolean((await supabase.from("followers").select("follower_id").eq("follower_id", auth.user.id).eq("following_id", profile.id as string).maybeSingle()).data)
    : false;

  const card: FaceCard | null = cardRow
    ? {
        username: cardRow.username as string, score: cardRow.score as number,
        archetype: cardRow.archetype as string, archetypeKey: cardRow.archetype_key as string,
        era: cardRow.era as string, eraKey: cardRow.era_key as string,
        signatureLine: cardRow.signature_line as string, stats: cardRow.stats as FaceCard["stats"],
        traits: (cardRow.traits as string[]) ?? [], portraitUrl: cardRow.portrait_url as string | null,
      }
    : null;

  return (
    <main className="relative min-h-dvh bg-black pb-20">
      <div className="pointer-events-none fixed inset-0" style={{ background: "radial-gradient(100% 50% at 50% 0%, rgba(216,176,114,0.11), transparent 58%)" }} />

      <div className="relative z-10 mx-auto w-full max-w-2xl px-5 pt-[max(1.5rem,env(safe-area-inset-top))]">
        <a href="/feed" className="kicker">← Feed</a>

        <header className="mt-5 flex items-start justify-between">
          <div>
            <h1 className="display text-[1.7rem]">@{profile.username as string}</h1>
            <p className="kicker mt-1">
              Level {profile.level as number} · {followers ?? 0} followers
            </p>
          </div>
          {auth.user && auth.user.id !== profile.id && (
            <FollowButton userId={profile.id as string} initial={isFollowing} />
          )}
        </header>

        {card && (
          <div className="mt-8 flex justify-center">
            <FaceCardVisual card={card} />
          </div>
        )}

        <section className="mt-10">
          <p className="kicker">Movies</p>
          <div className="mt-3 flex flex-col gap-2.5">
            {(movies ?? []).map((m) => (
              <a key={m.story_id as string} href={`/m/${m.story_id}`} className="choice-card glass flex items-center justify-between px-5 py-4">
                <span className="min-w-0">
                  <span className="block truncate text-[0.92rem] font-semibold">{m.title as string}</span>
                  <span className="block text-[0.7rem] text-[color:var(--color-muted)]">
                    {(m.ending_title as string) ?? ""} · {(m.decision_count as number) ?? 0} choices
                  </span>
                </span>
                <span className="kicker shrink-0">{(m.likes_count as number) ?? 0} ♥</span>
              </a>
            ))}
            {(movies ?? []).length === 0 && (
              <p className="text-[0.86rem] text-[color:var(--color-muted)]">No public movies yet.</p>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
