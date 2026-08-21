import { NextResponse } from "next/server";
import { z } from "zod";

import { moderate } from "@/lib/ai/providers";
import { buildCharacterBible } from "@/lib/engine/bible";
import { buildFaceCard, computeStartingEmotions } from "@/lib/engine/facecard";
import { validateAnswers } from "@/lib/engine/questions";
import { rateLimit } from "@/lib/limits";
import { requireUser } from "@/lib/supabase/server";
import { fail, ok } from "@/lib/api";

const Body = z.object({
  answers: z.record(z.string(), z.string()),
  portraitUrl: z.string().url().nullable().optional(),
});

export async function POST(req: Request) {
  try {
    const { supabase, user } = await requireUser();

    if (!rateLimit(`facecard:${user.id}`, 10, 60_000)) {
      return fail("Slow down a second.", 429);
    }

    const parsed = Body.safeParse(await req.json());
    if (!parsed.success) return fail("Invalid request body.", 400);

    // Answers must come from our own question bank — never trust the client.
    const check = validateAnswers(parsed.data.answers);
    if (!check.ok) return fail(`Missing or invalid answers: ${check.missing.join(", ")}`, 400);

    const { data: profile } = await supabase
      .from("profiles").select("username, is_banned").eq("id", user.id).single();
    if (!profile) return fail("Profile not found.", 404);
    if (profile.is_banned) return fail("Account suspended.", 403);

    const username = profile.username as string;
    const gate = await moderate(username);
    if (!gate.data.allowed) return fail("That username can't be used on a Face Card.", 400);

    const card = buildFaceCard(username, parsed.data.answers, parsed.data.portraitUrl ?? null);
    const bible = buildCharacterBible(card);
    const startingEmotions = computeStartingEmotions(parsed.data.answers);

    // Only one active card at a time (enforced by a partial unique index).
    await supabase.from("face_cards").update({ is_active: false }).eq("user_id", user.id).eq("is_active", true);

    const { data: row, error } = await supabase
      .from("face_cards")
      .insert({
        user_id: user.id,
        username: card.username,
        portrait_url: card.portraitUrl,
        score: card.score,
        archetype: card.archetype,
        archetype_key: card.archetypeKey,
        era: card.era,
        era_key: card.eraKey,
        signature_line: card.signatureLine,
        stats: card.stats,
        answers: parsed.data.answers,
        traits: card.traits,
        is_active: true,
      })
      .select()
      .single();
    if (error || !row) return fail(error?.message ?? "Could not create Face Card.", 500);

    await supabase.from("character_profiles").upsert(
      { face_card_id: row.id, user_id: user.id, bible },
      { onConflict: "face_card_id" },
    );

    await supabase.rpc("award_xp", { p_kind: "face_card_created", p_xp: 50, p_meta: { face_card_id: row.id } });

    return ok({ faceCard: { ...card, id: row.id }, startingEmotions });
  } catch (err) {
    return fail(err instanceof Error ? err.message : "Unexpected error", 500);
  }
}
