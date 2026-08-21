-- FACE CARD :: tighten SECURITY DEFINER exposure (advisor 0011/0028/0029)

create or replace function public.touch_updated_at()
returns trigger language plpgsql security definer set search_path = public as $$
begin new.updated_at = now(); return new; end $$;

-- Trigger-only functions must never be reachable over the REST RPC surface.
-- Triggers fire through the executor and do not consult EXECUTE grants, so
-- revoking here removes the endpoint without breaking the triggers.
revoke all on function public.touch_updated_at() from public, anon, authenticated;
revoke all on function public.bump_counter() from public, anon, authenticated;
revoke all on function public.handle_new_user() from public, anon, authenticated;

revoke all on function public.award_xp(text, int, jsonb) from public, anon;
revoke all on function public.record_usage(uuid, text, text, text, numeric, int, text) from public, anon;
revoke all on function public.usage_today() from public, anon;
revoke all on function public.increment_movie_views(uuid) from public, anon;

grant execute on function public.award_xp(text, int, jsonb) to authenticated;
grant execute on function public.record_usage(uuid, text, text, text, numeric, int, text) to authenticated;
grant execute on function public.usage_today() to authenticated;
grant execute on function public.increment_movie_views(uuid) to authenticated;

-- story_is_public is deliberately left executable by anon: RLS policies for
-- logged-out visitors evaluate it, and it only reports whether a movie is
-- already published. Revoking it would break public movie pages.
grant execute on function public.story_is_public(uuid) to anon, authenticated;
