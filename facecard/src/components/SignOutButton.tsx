"use client";

import { useRouter } from "next/navigation";
import { getBrowserSupabase } from "@/lib/supabase/client";

export default function SignOutButton() {
  const router = useRouter();
  return (
    <button
      onClick={async () => {
        await getBrowserSupabase().auth.signOut();
        router.push("/");
        router.refresh();
      }}
      className="choice-card glass-quiet px-4 py-2 text-[0.66rem] uppercase tracking-[0.16em]"
    >
      Sign out
    </button>
  );
}
