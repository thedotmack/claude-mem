import { redirect } from "next/navigation";
import CreateFlow from "@/components/CreateFlow";
import { getServerSupabase } from "@/lib/supabase/server";

export const metadata = { title: "Create your character" };

export default async function CreatePage() {
  const supabase = await getServerSupabase();
  const { data } = await supabase.auth.getUser();
  if (!data.user) redirect("/login?next=/create");

  const { data: profile } = await supabase
    .from("profiles").select("username").eq("id", data.user.id).single();

  return <CreateFlow userId={data.user.id} username={profile?.username ?? "player"} />;
}
