-- FACE CARD :: core schema (identity, character, story, scenes, choices, emotion)
create extension if not exists pgcrypto;

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null,
  display_name text,
  avatar_url text,
  bio text,
  xp integer not null default 0,
  level integer not null default 1,
  is_admin boolean not null default false,
  is_banned boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists profiles_username_lower_idx on public.profiles (lower(username));
create trigger profiles_touch before update on public.profiles
  for each row execute function public.touch_updated_at();

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare base text; candidate text; n int := 0;
begin
  base := regexp_replace(lower(coalesce(nullif(new.raw_user_meta_data->>'username',''),
                                        split_part(coalesce(new.email,'player'),'@',1))),
                         '[^a-z0-9_]', '', 'g');
  if base is null or base = '' then base := 'player'; end if;
  base := left(base, 20);
  candidate := base;
  while exists (select 1 from public.profiles p where lower(p.username) = candidate) loop
    n := n + 1; candidate := left(base, 16) || n::text;
  end loop;
  insert into public.profiles (id, username, display_name, avatar_url)
  values (new.id, candidate,
          coalesce(nullif(new.raw_user_meta_data->>'display_name',''),
                   nullif(new.raw_user_meta_data->>'full_name',''), candidate),
          new.raw_user_meta_data->>'avatar_url')
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

create table if not exists public.face_cards (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  username text not null,
  portrait_url text,
  score integer not null default 50 check (score between 0 and 100),
  archetype text not null,
  archetype_key text not null,
  era text not null,
  era_key text not null,
  signature_line text not null,
  stats jsonb not null default '{}'::jsonb,
  answers jsonb not null default '{}'::jsonb,
  traits jsonb not null default '[]'::jsonb,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists face_cards_user_idx on public.face_cards (user_id, created_at desc);
create unique index if not exists face_cards_one_active_idx
  on public.face_cards (user_id) where is_active;

create table if not exists public.character_profiles (
  id uuid primary key default gen_random_uuid(),
  face_card_id uuid not null references public.face_cards(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  bible jsonb not null,
  created_at timestamptz not null default now()
);
create unique index if not exists character_profiles_face_card_idx
  on public.character_profiles (face_card_id);

create table if not exists public.stories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  face_card_id uuid not null references public.face_cards(id) on delete cascade,
  template_key text not null,
  title text not null,
  genre text not null,
  logline text not null,
  poster_seed text not null default '',
  status text not null default 'active' check (status in ('active','completed','abandoned')),
  visibility text not null default 'public' check (visibility in ('public','unlisted','private')),
  remixed_from uuid references public.stories(id) on delete set null,
  challenge_of uuid references public.stories(id) on delete set null,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create index if not exists stories_user_idx on public.stories (user_id, created_at desc);
create index if not exists stories_status_idx on public.stories (status);
create index if not exists stories_remix_idx on public.stories (remixed_from);

create table if not exists public.story_states (
  story_id uuid primary key references public.stories(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  current_scene_id uuid,
  beat_index integer not null default 0,
  choice_count integer not null default 0,
  emotions jsonb not null default '{}'::jsonb,
  relationships jsonb not null default '{}'::jsonb,
  flags jsonb not null default '{}'::jsonb,
  inventory jsonb not null default '[]'::jsonb,
  memory jsonb not null default '[]'::jsonb,
  previous_choices jsonb not null default '[]'::jsonb,
  character_traits jsonb not null default '{}'::jsonb,
  completed_branches jsonb not null default '[]'::jsonb,
  available_branches jsonb not null default '[]'::jsonb,
  ending_conditions jsonb not null default '{}'::jsonb,
  opening_emotions jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
create trigger story_states_touch before update on public.story_states
  for each row execute function public.touch_updated_at();

create table if not exists public.scenes (
  id uuid primary key default gen_random_uuid(),
  story_id uuid not null references public.stories(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  seq integer not null,
  previous_scene uuid references public.scenes(id) on delete set null,
  beat_key text not null,
  branch_key text not null default 'root',
  title text not null,
  script jsonb not null default '{}'::jsonb,
  cinematography jsonb not null default '{}'::jsonb,
  available_choices jsonb not null default '[]'::jsonb,
  selected_choice jsonb,
  emotional_state jsonb not null default '{}'::jsonb,
  character_state jsonb not null default '{}'::jsonb,
  generated_assets jsonb not null default '{}'::jsonb,
  status text not null default 'ready' check (status in ('pending','generating','ready','failed')),
  is_final boolean not null default false,
  created_at timestamptz not null default now()
);
create unique index if not exists scenes_story_seq_idx on public.scenes (story_id, seq);
create index if not exists scenes_story_idx on public.scenes (story_id, created_at);

alter table public.story_states drop constraint if exists story_states_current_scene_fk;
alter table public.story_states
  add constraint story_states_current_scene_fk
  foreign key (current_scene_id) references public.scenes(id) on delete set null;

create table if not exists public.choices (
  id uuid primary key default gen_random_uuid(),
  story_id uuid not null references public.stories(id) on delete cascade,
  scene_id uuid not null references public.scenes(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  choice_key text not null,
  label text not null,
  effects jsonb not null default '{}'::jsonb,
  seq integer not null,
  selected_at timestamptz not null default now()
);
create index if not exists choices_story_idx on public.choices (story_id, seq);

create table if not exists public.emotional_states (
  id uuid primary key default gen_random_uuid(),
  story_id uuid not null references public.stories(id) on delete cascade,
  scene_id uuid references public.scenes(id) on delete cascade,
  emotions jsonb not null,
  dominant text,
  created_at timestamptz not null default now()
);
create index if not exists emotional_states_story_idx on public.emotional_states (story_id, created_at);

create table if not exists public.relationships (
  id uuid primary key default gen_random_uuid(),
  story_id uuid not null references public.stories(id) on delete cascade,
  character_key text not null,
  name text not null,
  role text,
  affinity integer not null default 50,
  trust integer not null default 50,
  status text not null default 'neutral',
  notes jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);
create unique index if not exists relationships_story_char_idx
  on public.relationships (story_id, character_key);
create trigger relationships_touch before update on public.relationships
  for each row execute function public.touch_updated_at();
