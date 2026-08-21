-- FACE CARD :: row level security, privileged RPCs, counters, storage
alter table public.profiles            enable row level security;
alter table public.face_cards          enable row level security;
alter table public.character_profiles  enable row level security;
alter table public.stories             enable row level security;
alter table public.story_states        enable row level security;
alter table public.scenes              enable row level security;
alter table public.choices             enable row level security;
alter table public.emotional_states    enable row level security;
alter table public.relationships       enable row level security;
alter table public.movies              enable row level security;
alter table public.movie_assets        enable row level security;
alter table public.endings             enable row level security;
alter table public.likes               enable row level security;
alter table public.comments            enable row level security;
alter table public.followers           enable row level security;
alter table public.challenges          enable row level security;
alter table public.remixes             enable row level security;
alter table public.rewards             enable row level security;
alter table public.notifications       enable row level security;
alter table public.generation_jobs     enable row level security;
alter table public.usage_events        enable row level security;
alter table public.app_settings        enable row level security;

create or replace function public.story_is_public(p_story uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.movies m where m.story_id = p_story and m.published);
$$;

drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles for select using (true);
drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles for update
  using ((select auth.uid()) = id) with check ((select auth.uid()) = id);

drop policy if exists face_cards_read on public.face_cards;
create policy face_cards_read on public.face_cards for select using (true);
drop policy if exists face_cards_write on public.face_cards;
create policy face_cards_write on public.face_cards for all
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

drop policy if exists character_profiles_own on public.character_profiles;
create policy character_profiles_own on public.character_profiles for all
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

drop policy if exists stories_own on public.stories;
create policy stories_own on public.stories for all
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists stories_public_read on public.stories;
create policy stories_public_read on public.stories for select
  using (visibility = 'public' and public.story_is_public(id));

-- STRICTLY private: hides the ending tree and hidden emotional variables.
drop policy if exists story_states_own on public.story_states;
create policy story_states_own on public.story_states for all
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

drop policy if exists scenes_own on public.scenes;
create policy scenes_own on public.scenes for all
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists scenes_public_read on public.scenes;
create policy scenes_public_read on public.scenes for select
  using (public.story_is_public(story_id));

drop policy if exists choices_own on public.choices;
create policy choices_own on public.choices for all
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists choices_public_read on public.choices;
create policy choices_public_read on public.choices for select
  using (public.story_is_public(story_id));

drop policy if exists emotional_states_own on public.emotional_states;
create policy emotional_states_own on public.emotional_states for all
  using (exists (select 1 from public.stories s where s.id = story_id and s.user_id = (select auth.uid())))
  with check (exists (select 1 from public.stories s where s.id = story_id and s.user_id = (select auth.uid())));
drop policy if exists relationships_own on public.relationships;
create policy relationships_own on public.relationships for all
  using (exists (select 1 from public.stories s where s.id = story_id and s.user_id = (select auth.uid())))
  with check (exists (select 1 from public.stories s where s.id = story_id and s.user_id = (select auth.uid())));

drop policy if exists movies_own on public.movies;
create policy movies_own on public.movies for all
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists movies_public_read on public.movies;
create policy movies_public_read on public.movies for select using (published);

drop policy if exists movie_assets_own on public.movie_assets;
create policy movie_assets_own on public.movie_assets for all
  using (exists (select 1 from public.stories s where s.id = story_id and s.user_id = (select auth.uid())))
  with check (exists (select 1 from public.stories s where s.id = story_id and s.user_id = (select auth.uid())));
drop policy if exists movie_assets_public_read on public.movie_assets;
create policy movie_assets_public_read on public.movie_assets for select
  using (public.story_is_public(story_id));

drop policy if exists endings_own on public.endings;
create policy endings_own on public.endings for all
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists endings_public_read on public.endings;
create policy endings_public_read on public.endings for select
  using (public.story_is_public(story_id));

drop policy if exists likes_read on public.likes;
create policy likes_read on public.likes for select using (true);
drop policy if exists likes_write on public.likes;
create policy likes_write on public.likes for all
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

drop policy if exists comments_read on public.comments;
create policy comments_read on public.comments for select using (true);
drop policy if exists comments_write on public.comments;
create policy comments_write on public.comments for all
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

drop policy if exists followers_read on public.followers;
create policy followers_read on public.followers for select using (true);
drop policy if exists followers_write on public.followers;
create policy followers_write on public.followers for all
  using ((select auth.uid()) = follower_id) with check ((select auth.uid()) = follower_id);

drop policy if exists challenges_read on public.challenges;
create policy challenges_read on public.challenges for select using (true);
drop policy if exists challenges_write on public.challenges;
create policy challenges_write on public.challenges for all
  using ((select auth.uid()) = from_user) with check ((select auth.uid()) = from_user);

drop policy if exists remixes_read on public.remixes;
create policy remixes_read on public.remixes for select using (true);
drop policy if exists remixes_write on public.remixes;
create policy remixes_write on public.remixes for all
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

drop policy if exists rewards_own on public.rewards;
create policy rewards_own on public.rewards for select using ((select auth.uid()) = user_id);
drop policy if exists notifications_own on public.notifications;
create policy notifications_own on public.notifications for all
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists generation_jobs_own on public.generation_jobs;
create policy generation_jobs_own on public.generation_jobs for all
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists usage_events_own on public.usage_events;
create policy usage_events_own on public.usage_events for select using ((select auth.uid()) = user_id);

drop policy if exists app_settings_read on public.app_settings;
create policy app_settings_read on public.app_settings for select using (true);
drop policy if exists app_settings_admin on public.app_settings;
create policy app_settings_admin on public.app_settings for all
  using (exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.is_admin))
  with check (exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.is_admin));

create or replace function public.bump_counter()
returns trigger language plpgsql security definer set search_path = public as $$
declare delta int; begin
  delta := case when TG_OP = 'INSERT' then 1 else -1 end;
  if TG_TABLE_NAME = 'likes' then
    update public.movies set likes_count = greatest(0, likes_count + delta)
      where id = coalesce(new.movie_id, old.movie_id);
  elsif TG_TABLE_NAME = 'comments' then
    update public.movies set comments_count = greatest(0, comments_count + delta)
      where id = coalesce(new.movie_id, old.movie_id);
  elsif TG_TABLE_NAME = 'remixes' then
    update public.movies set remix_count = greatest(0, remix_count + delta)
      where id = coalesce(new.source_movie_id, old.source_movie_id);
  end if;
  return coalesce(new, old);
end $$;

drop trigger if exists likes_counter on public.likes;
create trigger likes_counter after insert or delete on public.likes
  for each row execute function public.bump_counter();
drop trigger if exists comments_counter on public.comments;
create trigger comments_counter after insert or delete on public.comments
  for each row execute function public.bump_counter();
drop trigger if exists remixes_counter on public.remixes;
create trigger remixes_counter after insert or delete on public.remixes
  for each row execute function public.bump_counter();

-- Privileged operations. The app uses NO service-role key; elevation happens
-- only through these audited SECURITY DEFINER functions.
create or replace function public.increment_movie_views(p_movie uuid)
returns void language sql security definer set search_path = public as $$
  update public.movies set views = views + 1 where id = p_movie and published;
$$;

create or replace function public.award_xp(p_kind text, p_xp int, p_meta jsonb default '{}'::jsonb)
returns table(total_xp int, level int)
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); new_xp int;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  if p_xp < 0 or p_xp > 500 then raise exception 'invalid xp'; end if;
  insert into public.rewards (user_id, kind, xp, meta) values (uid, p_kind, p_xp, p_meta);
  update public.profiles p set xp = p.xp + p_xp,
         level = greatest(1, floor(sqrt((p.xp + p_xp)::numeric / 100))::int + 1)
   where p.id = uid
   returning p.xp, p.level into new_xp, level;
  total_xp := new_xp; return next;
end $$;

create or replace function public.record_usage(
  p_story uuid, p_provider text, p_model text, p_kind text,
  p_cost numeric, p_duration int, p_status text)
returns void language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid();
begin
  if uid is null then return; end if;
  insert into public.usage_events (user_id, story_id, provider, model, kind, est_cost_usd, duration_ms, status)
  values (uid, p_story, p_provider, coalesce(p_model,''), p_kind, coalesce(p_cost,0), coalesce(p_duration,0), coalesce(p_status,'ok'));
end $$;

create or replace function public.usage_today()
returns table(scenes int, stories int, cost numeric)
language sql security definer set search_path = public as $$
  select
    (select count(*)::int from public.usage_events u
      where u.user_id = auth.uid() and u.kind = 'scene' and u.created_at > now() - interval '1 day'),
    (select count(*)::int from public.stories s
      where s.user_id = auth.uid() and s.created_at > now() - interval '1 day'),
    (select coalesce(sum(u.est_cost_usd),0) from public.usage_events u
      where u.user_id = auth.uid() and u.created_at > now() - interval '1 day');
$$;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('portraits','portraits', true, 5242880, array['image/jpeg','image/png','image/webp']),
       ('media','media', true, 26214400, null)
on conflict (id) do update set public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists facecard_media_read on storage.objects;
create policy facecard_media_read on storage.objects for select
  using (bucket_id in ('portraits','media'));
drop policy if exists facecard_media_insert on storage.objects;
create policy facecard_media_insert on storage.objects for insert to authenticated
  with check (bucket_id in ('portraits','media')
              and (storage.foldername(name))[1] = (select auth.uid())::text);
drop policy if exists facecard_media_update on storage.objects;
create policy facecard_media_update on storage.objects for update to authenticated
  using (bucket_id in ('portraits','media')
         and (storage.foldername(name))[1] = (select auth.uid())::text);
drop policy if exists facecard_media_delete on storage.objects;
create policy facecard_media_delete on storage.objects for delete to authenticated
  using (bucket_id in ('portraits','media')
         and (storage.foldername(name))[1] = (select auth.uid())::text);
