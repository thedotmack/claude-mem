import { z } from "zod";

import { fail, ok, statusFor } from "@/lib/api";
import { providerStatus } from "@/lib/ai/providers";
import { requireUser } from "@/lib/supabase/server";

const Body = z.object({
  key: z.enum(["limits", "flags", "providers"]),
  value: z.record(z.string(), z.unknown()),
});

async function assertAdmin(supabase: Awaited<ReturnType<typeof requireUser>>["supabase"], userId: string) {
  const { data } = await supabase.from("profiles").select("is_admin").eq("id", userId).single();
  if (!data?.is_admin) throw new Error("FORBIDDEN");
}

export async function GET() {
  try {
    const { supabase, user } = await requireUser();
    await assertAdmin(supabase, user.id);

    const { data: settings } = await supabase.from("app_settings").select("*");
    const { data: usage } = await supabase
      .from("usage_events")
      .select("provider, kind, est_cost_usd, created_at")
      .order("created_at", { ascending: false })
      .limit(200);
    const { data: jobs } = await supabase
      .from("generation_jobs")
      .select("id, status, stage, error, created_at")
      .order("created_at", { ascending: false })
      .limit(50);

    return ok({ settings, usage, jobs, providers: providerStatus() });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unexpected error";
    return fail(message, message === "FORBIDDEN" ? 403 : statusFor(err));
  }
}

export async function POST(req: Request) {
  try {
    const { supabase, user } = await requireUser();
    await assertAdmin(supabase, user.id);

    const parsed = Body.safeParse(await req.json());
    if (!parsed.success) return fail("Invalid request body.", 400);

    const { error } = await supabase
      .from("app_settings")
      .upsert({ key: parsed.data.key, value: parsed.data.value }, { onConflict: "key" });
    if (error) return fail(error.message, 400);

    return ok({ updated: parsed.data.key });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unexpected error";
    return fail(message, message === "FORBIDDEN" ? 403 : statusFor(err));
  }
}
