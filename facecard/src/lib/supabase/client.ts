"use client";

import { createBrowserClient } from "@supabase/ssr";
import { publicEnv } from "@/lib/env";

let cached: ReturnType<typeof createBrowserClient> | null = null;

export function getBrowserSupabase() {
  if (!cached) {
    cached = createBrowserClient(publicEnv.supabaseUrl, publicEnv.supabaseKey);
  }
  return cached;
}
