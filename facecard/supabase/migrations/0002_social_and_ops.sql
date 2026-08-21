-- FACE CARD :: movies, social graph, rewards, jobs, cost control
create table if not exists public.movies (
  id uuid primary key default gen_random_uuid(),
  story_id uuid not null unique references public.stories(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  face_card_id uuid references public.face_cards(id) on delete set null,
  title text not null,
  genre text not null default '',
  logline text not null default '',
  ending_key text,
  ending_title text,
  ending_rarity text,
  decision_count integer not null default 0,
  scene_count integer not null default 0,
  duration_seconds integer not null default 0,
  poster_seed text not null default '',
  share_slug text not null unique,
  published boolean not null default true,
  views integer not null default 0,
  likes_count integer not null default 0,
  comments_count integer not null default 0,
  remix_count integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists movies_feed_idx on public.movies (published, created_at desc);
create index if not exists movies_user_idx on public.movies (user_id, created_at desc);

create table if not exists public.movie_assets (
  id uuid primary key default gen_random_uuid(),
  movie_id uuid references public.movies(id) on delete cascade,
  story_id uuid not null references public.stories(id) on delete cascade,
  scene_id uuid references public.scenes(id) on delete cascade,
  kind text not null check (kind in ('poster','teaser','trailer','still','voice','score','ending_card','face_card')),
  url text not null,
  storage_path text,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists movie_assets_story_idx on public.movie_assets (story_id, kind);
create index if not exists movie_assets_scene_idx on public.movie_assets (scene_id);

create table if not exists public.endings (
  id uuid primary key default gen_random_uuid(),
  story_id uuid not null unique references public.stories(id) on delete cascade,
  movie_id uuid references public.movies(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  ending_key text not null,
  title text not null,
  rarity text not null default 'common' check (rarity in ('common','uncommon','rare','secret')),
  summary text not null default '',
  final_line text not null default '',
  arc jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.likes (
  id uuid primary key default gen_random_uuid(),
  movie_id uuid not null references public.movies(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now()
);
create unique index if not exists likes_unique_idx on public.likes (movie_id, user_id);

create table if not exists public.comments (
  id uuid primary key default gen_random_uuid(),
  movie_id uuid not null references public.movies(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 500),
  created_at timestamptz not null default now()
);
create index if not exists comments_movie_idx on public.comments (movie_id, created_at desc);

create table if not exists public.followers (
  follower_id uuid not null references public.profiles(id) on delete cascade,
  following_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (follower_id, following_id),
  check (follower_id <> following_id)
);
create index if not exists followers_following_idx on public.followers (following_id);

create table if not exists public.challenges (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  source_movie_id uuid not null references public.movies(id) on delete cascade,
  source_story_id uuid not null references public.stories(id) on delete cascade,
  from_user uuid not null references public.profiles(id) on delete cascade,
  to_user uuid references public.profiles(id) on delete set null,
  challenger_story_id uuid references public.stories(id) on delete set null,
  status text not null default 'open' check (status in ('open','accepted','completed')),
  result jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists challenges_from_idx on public.challenges (from_user, created_at desc);

create table if not exists public.remixes (
  id uuid primary key default gen_random_uuid(),
  source_movie_id uuid not null references public.movies(id) on delete cascade,
  source_story_id uuid not null references public.stories(id) on delete cascade,
  new_story_id uuid not null references public.stories(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists remixes_source_idx on public.remixes (source_movie_id);

create table if not exists public.rewards (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  kind text not null,
  xp integer not null default 0,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists rewards_user_idx on public.rewards (user_id, created_at desc);

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  kind text not null,
  payload jsonb not null default '{}'::jsonb,
  read boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists notifications_user_idx on public.notifications (user_id, read, created_at desc);

create table if not exists public.generation_jobs (
  id uuid primary key default gen_random_uuid(),
  story_id uuid not null references public.stories(id) on delete cascade,
  scene_id uuid references public.scenes(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  kind text not null check (kind in ('scene','poster','teaser','trailer','ending','face_card')),
  status text not null default 'queued' check (status in ('queued','running','succeeded','failed','cancelled')),
  stage text not null default 'QUEUED',
  stages jsonb not null default '[]'::jsonb,
  attempts integer not null default 0,
  max_attempts integer not null default 3,
  error text,
  payload jsonb not null default '{}'::jsonb,
  result jsonb not null default '{}'::jsonb,
  locked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists generation_jobs_story_idx on public.generation_jobs (story_id, created_at desc);
create index if not exists generation_jobs_pending_idx on public.generation_jobs (status, created_at) where status in ('queued','running');
create trigger generation_jobs_touch before update on public.generation_jobs
  for each row execute function public.touch_updated_at();

create table if not exists public.usage_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  story_id uuid references public.stories(id) on delete set null,
  provider text not null,
  model text not null default '',
  kind text not null,
  est_cost_usd numeric(10,5) not null default 0,
  duration_ms integer not null default 0,
  status text not null default 'ok',
  created_at timestamptz not null default now()
);
create index if not exists usage_events_user_idx on public.usage_events (user_id, created_at desc);

create table if not exists public.app_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
create trigger app_settings_touch before update on public.app_settings
  for each row execute function public.touch_updated_at();

insert into public.app_settings (key, value) values
  ('limits', '{"scenes_per_day":180,"stories_per_day":25,"max_cost_usd_per_day":5,"max_scenes_per_story":14}'::jsonb),
  ('providers', '{"llm":"builtin","image":"builtin","video":"builtin","voice":"builtin","music":"builtin","moderation":"builtin"}'::jsonb),
  ('flags', '{"signups_enabled":true,"feed_enabled":true,"remix_enabled":true,"challenges_enabled":true}'::jsonb)
on conflict (key) do nothing;
