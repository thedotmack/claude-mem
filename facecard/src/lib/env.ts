/**
 * Environment access. Anything secret is read lazily and ONLY on the server —
 * these values must never be imported into a client component.
 */

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}

/** Safe to expose: these are the public Supabase endpoint + publishable key. */
export const publicEnv = {
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
  supabaseKey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "",
  siteUrl:
    process.env.NEXT_PUBLIC_SITE_URL ??
    (process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : "http://localhost:3000"),
};

export function requirePublicEnv() {
  return { supabaseUrl: req("NEXT_PUBLIC_SUPABASE_URL"), supabaseKey: req("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY") };
}

/** Server-only provider credentials. Absent keys simply disable that provider. */
export const serverEnv = {
  get llm() {
    return {
      provider: process.env.LLM_PROVIDER ?? "builtin",
      anthropicKey: process.env.ANTHROPIC_API_KEY ?? "",
      anthropicModel: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5",
      openaiKey: process.env.OPENAI_API_KEY ?? "",
      openaiModel: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
    };
  },
  get image() {
    return {
      provider: process.env.IMAGE_PROVIDER ?? "builtin",
      falKey: process.env.FAL_API_KEY ?? "",
      falModel: process.env.FAL_IMAGE_MODEL ?? "fal-ai/flux/schnell",
      replicateKey: process.env.REPLICATE_API_TOKEN ?? "",
      replicateModel: process.env.REPLICATE_IMAGE_MODEL ?? "black-forest-labs/flux-schnell",
    };
  },
  get video() {
    return {
      provider: process.env.VIDEO_PROVIDER ?? "builtin",
      falKey: process.env.FAL_API_KEY ?? "",
      falModel: process.env.FAL_VIDEO_MODEL ?? "fal-ai/ltx-video",
      replicateKey: process.env.REPLICATE_API_TOKEN ?? "",
    };
  },
  get voice() {
    return {
      provider: process.env.VOICE_PROVIDER ?? "builtin",
      elevenKey: process.env.ELEVENLABS_API_KEY ?? "",
      elevenVoice: process.env.ELEVENLABS_VOICE_ID ?? "",
    };
  },
  get music() {
    return { provider: process.env.MUSIC_PROVIDER ?? "builtin", falKey: process.env.FAL_API_KEY ?? "" };
  },
  get moderation() {
    return { provider: process.env.MODERATION_PROVIDER ?? "builtin", openaiKey: process.env.OPENAI_API_KEY ?? "" };
  },
};

export const isServer = typeof window === "undefined";
