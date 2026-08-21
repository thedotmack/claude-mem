import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Cost control (spec: "AI video generation can become extremely expensive").
 * Limits live in app_settings so an admin can tune them without a redeploy.
 */

export interface Limits {
  scenes_per_day: number;
  stories_per_day: number;
  max_cost_usd_per_day: number;
  max_scenes_per_story: number;
}

const FALLBACK: Limits = {
  scenes_per_day: 180,
  stories_per_day: 25,
  max_cost_usd_per_day: 5,
  max_scenes_per_story: 14,
};

export async function getLimits(supabase: SupabaseClient): Promise<Limits> {
  const { data } = await supabase.from("app_settings").select("value").eq("key", "limits").maybeSingle();
  return { ...FALLBACK, ...((data?.value as Partial<Limits>) ?? {}) };
}

export async function getFlags(supabase: SupabaseClient): Promise<Record<string, boolean>> {
  const { data } = await supabase.from("app_settings").select("value").eq("key", "flags").maybeSingle();
  return (data?.value as Record<string, boolean>) ?? {};
}

export interface QuotaCheck { ok: boolean; reason?: string }

/** Called before any generation that could cost money or loop infinitely. */
export async function checkQuota(
  supabase: SupabaseClient,
  kind: "scene" | "story",
): Promise<QuotaCheck> {
  const limits = await getLimits(supabase);
  const { data, error } = await supabase.rpc("usage_today");
  if (error) return { ok: true }; // never hard-block on a metering failure

  const row = Array.isArray(data) ? data[0] : data;
  const scenes = Number(row?.scenes ?? 0);
  const stories = Number(row?.stories ?? 0);
  const cost = Number(row?.cost ?? 0);

  if (cost >= limits.max_cost_usd_per_day) {
    return { ok: false, reason: "Daily generation budget reached. Resets in 24 hours." };
  }
  if (kind === "scene" && scenes >= limits.scenes_per_day) {
    return { ok: false, reason: "You've hit today's scene limit. Come back tomorrow." };
  }
  if (kind === "story" && stories >= limits.stories_per_day) {
    return { ok: false, reason: "You've started a lot of movies today. Try again tomorrow." };
  }
  return { ok: true };
}

export async function recordUsage(
  supabase: SupabaseClient,
  args: { storyId: string | null; provider: string; model: string; kind: string; costUsd: number; durationMs: number; status?: string },
) {
  await supabase.rpc("record_usage", {
    p_story: args.storyId,
    p_provider: args.provider,
    p_model: args.model,
    p_kind: args.kind,
    p_cost: args.costUsd,
    p_duration: Math.round(args.durationMs),
    p_status: args.status ?? "ok",
  });
}

/** Simple per-user sliding window guard against duplicate/spam requests. */
const recent = new Map<string, number[]>();

export function rateLimit(key: string, max: number, windowMs: number): boolean {
  const t = Date.now();
  const hits = (recent.get(key) ?? []).filter((x) => t - x < windowMs);
  if (hits.length >= max) {
    recent.set(key, hits);
    return false;
  }
  hits.push(t);
  recent.set(key, hits);
  if (recent.size > 5000) recent.clear();
  return true;
}
