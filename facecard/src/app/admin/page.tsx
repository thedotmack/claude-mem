import { redirect } from "next/navigation";
import { getServerSupabase } from "@/lib/supabase/server";
import { providerStatus } from "@/lib/ai/providers";
import AdminPanel from "@/components/AdminPanel";

export const metadata = { title: "Admin" };
export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const supabase = await getServerSupabase();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) redirect("/login?next=/admin");

  const { data: profile } = await supabase
    .from("profiles").select("is_admin").eq("id", auth.user.id).single();

  if (!profile?.is_admin) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-black px-6">
        <div className="glass px-7 py-8 text-center">
          <p className="kicker">Restricted</p>
          <p className="mt-3 text-[0.9rem] text-[color:var(--color-muted)]">
            This area is for operators only.
          </p>
          <a href="/feed" className="kicker mt-5 inline-block text-[color:var(--color-gold)]">Back to feed →</a>
        </div>
      </main>
    );
  }

  const [{ data: settings }, { data: usage }, { data: jobs }, { count: users }, { count: moviesCount }] = await Promise.all([
    supabase.from("app_settings").select("*"),
    supabase.from("usage_events").select("provider, kind, est_cost_usd, created_at").order("created_at", { ascending: false }).limit(200),
    supabase.from("generation_jobs").select("id, status, stage, error, created_at").order("created_at", { ascending: false }).limit(30),
    supabase.from("profiles").select("id", { count: "exact", head: true }),
    supabase.from("movies").select("id", { count: "exact", head: true }),
  ]);

  return (
    <AdminPanel
      settings={(settings ?? []) as never}
      usage={(usage ?? []) as never}
      jobs={(jobs ?? []) as never}
      providers={providerStatus()}
      totals={{ users: users ?? 0, movies: moviesCount ?? 0 }}
    />
  );
}
