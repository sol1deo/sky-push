-- ============================================================================
-- SKY PUSH — accounts / profiles / friends schema (Supabase)
-- Paste this WHOLE file into: Supabase Dashboard → SQL Editor → New query → Run
--
-- Also do these two things in the dashboard:
--   1. Authentication → Sign In / Up → Email → turn OFF "Confirm email"
--      (players get in instantly; turn it back on later if you want)
--   2. Nothing else — Realtime presence and Storage policies are set up below.
-- ============================================================================

create extension if not exists citext;

-- ---------------------------------------------------------------------------
-- PROFILES — one row per account. Usernames are case-insensitively unique.
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  username   citext unique not null
             check (char_length(username) between 3 and 14
                    and username::text ~ '^[A-Za-z0-9_]+$'),
  avatar     text not null default 'e:🙂',   -- 'e:<emoji>' preset or storage URL
  banner     text not null default 'sky',    -- preset banner id (client-side list)
  bio        text not null default '' check (char_length(bio) <= 120),
  coins      int  not null default 300,
  cosmetics  jsonb not null default '{}'::jsonb,  -- owned/equipped (client shape)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists "profiles readable by everyone" on public.profiles;
create policy "profiles readable by everyone"
  on public.profiles for select using (true);

drop policy if exists "insert own profile" on public.profiles;
create policy "insert own profile"
  on public.profiles for insert with check (auth.uid() = id);

drop policy if exists "update own profile" on public.profiles;
create policy "update own profile"
  on public.profiles for update using (auth.uid() = id);

-- keep updated_at honest
create or replace function public.tg_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists profiles_touch on public.profiles;
create trigger profiles_touch before update on public.profiles
  for each row execute function public.tg_touch_updated_at();

-- ---------------------------------------------------------------------------
-- Auto-create the profile row on signup. The game passes the chosen username
-- in auth metadata; if it's somehow taken (race), fall back to a unique stub
-- so signup never breaks.
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, username)
  values (
    new.id,
    coalesce(nullif(new.raw_user_meta_data->>'username', ''),
             'player_' || substr(new.id::text, 1, 6))
  );
  return new;
exception when unique_violation or check_violation then
  insert into public.profiles (id, username)
  values (new.id, 'player_' || substr(new.id::text, 1, 6));
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- username availability check (used live during signup)
create or replace function public.username_available(name text)
returns boolean language sql stable as $$
  select not exists (select 1 from public.profiles where username = name::citext);
$$;

-- ---------------------------------------------------------------------------
-- FRIENDSHIPS — a request is a row; accepting flips status to 'accepted'.
-- The (least, greatest) unique index blocks duplicate reverse pairs.
-- ---------------------------------------------------------------------------
create table if not exists public.friendships (
  id         bigint generated always as identity primary key,
  requester  uuid not null references public.profiles(id) on delete cascade,
  addressee  uuid not null references public.profiles(id) on delete cascade,
  status     text not null default 'pending'
             check (status in ('pending', 'accepted')),
  created_at timestamptz not null default now(),
  check (requester <> addressee)
);

create unique index if not exists friendships_pair
  on public.friendships (least(requester, addressee), greatest(requester, addressee));

alter table public.friendships enable row level security;

drop policy if exists "see own friendships" on public.friendships;
create policy "see own friendships"
  on public.friendships for select
  using (auth.uid() = requester or auth.uid() = addressee);

drop policy if exists "send friend requests" on public.friendships;
create policy "send friend requests"
  on public.friendships for insert
  with check (auth.uid() = requester and status = 'pending');

drop policy if exists "addressee accepts" on public.friendships;
create policy "addressee accepts"
  on public.friendships for update
  using (auth.uid() = addressee)
  with check (status = 'accepted');

drop policy if exists "either side unfriends" on public.friendships;
create policy "either side unfriends"
  on public.friendships for delete
  using (auth.uid() = requester or auth.uid() = addressee);

-- realtime: the game listens for friendship changes to refresh the list live
do $$ begin
  alter publication supabase_realtime add table public.friendships;
exception when duplicate_object then null;
end $$;

-- ---------------------------------------------------------------------------
-- STORAGE — avatar images (players upload a square icon; public read)
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do nothing;

drop policy if exists "avatar images are public" on storage.objects;
create policy "avatar images are public"
  on storage.objects for select using (bucket_id = 'avatars');

drop policy if exists "upload own avatar" on storage.objects;
create policy "upload own avatar"
  on storage.objects for insert
  with check (bucket_id = 'avatars'
              and auth.uid()::text = (storage.foldername(name))[1]);

drop policy if exists "replace own avatar" on storage.objects;
create policy "replace own avatar"
  on storage.objects for update
  using (bucket_id = 'avatars'
         and auth.uid()::text = (storage.foldername(name))[1]);

drop policy if exists "delete own avatar" on storage.objects;
create policy "delete own avatar"
  on storage.objects for delete
  using (bucket_id = 'avatars'
         and auth.uid()::text = (storage.foldername(name))[1]);
