import { redirect } from "next/navigation";
import { getServerSupabase } from "@/lib/supabase/server";
import Opening from "@/components/Opening";

export default async function Home() {
  const supabase = await getServerSupabase();
  const { data } = await supabase.auth.getUser();

  // Returning players skip the cold open and land straight in the feed.
  if (data.user) {
    const { data: card } = await supabase
      .from("face_cards").select("id").eq("user_id", data.user.id).eq("is_active", true).maybeSingle();
    redirect(card ? "/feed" : "/create");
  }

  return <Opening />;
}
