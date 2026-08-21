import { notFound, redirect } from "next/navigation";
import ScenePlayer from "@/components/ScenePlayer";
import { getServerSupabase } from "@/lib/supabase/server";

export const metadata = { title: "Your movie" };

export default async function PlayPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await getServerSupabase();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) redirect(`/login?next=/play/${id}`);

  const { data: story } = await supabase
    .from("stories").select("id, title, user_id").eq("id", id).maybeSingle();
  if (!story) notFound();
  if (story.user_id !== auth.user.id) redirect(`/m/${id}`);

  return <ScenePlayer storyId={story.id as string} title={story.title as string} />;
}
