import { NextResponse } from "next/server";
import { providerStatus } from "@/lib/ai/providers";
import { getServerSupabase } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/** Liveness + wiring check used after every deploy. */
export async function GET() {
  const checks: Record<string, unknown> = { app: "ok" };
  let healthy = true;

  try {
    const supabase = await getServerSupabase();
    const { error } = await supabase.from("app_settings").select("key").limit(1);
    checks.database = error ? `error: ${error.message}` : "ok";
    if (error) healthy = false;
  } catch (err) {
    checks.database = `error: ${err instanceof Error ? err.message : "unknown"}`;
    healthy = false;
  }

  checks.providers = providerStatus();

  return NextResponse.json({ ok: healthy, checks }, { status: healthy ? 200 : 503 });
}
