import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { requirePublicEnv } from "@/lib/env";

/**
 * Request-scoped Supabase client carrying the caller's session.
 * Every query made through it is subject to RLS — that is the security boundary.
 */
export async function getServerSupabase() {
  const cookieStore = await cookies();
  const { supabaseUrl, supabaseKey } = requirePublicEnv();

  return createServerClient(supabaseUrl, supabaseKey, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (list) => {
        try {
          list.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // Called from a Server Component — refresh is handled in middleware.
        }
      },
    },
  });
}

/** Returns the signed-in user's id, or null. */
export async function getCurrentUserId(): Promise<string | null> {
  const supabase = await getServerSupabase();
  const { data } = await supabase.auth.getUser();
  return data.user?.id ?? null;
}

/** Throws a 401-shaped error when there is no session. */
export async function requireUser() {
  const supabase = await getServerSupabase();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) {
    const e = new Error("UNAUTHENTICATED");
    (e as Error & { status?: number }).status = 401;
    throw e;
  }
  return { supabase, user: data.user };
}
