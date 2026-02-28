-- POKUPOKU minimal backend schema (Supabase/Postgres)

create extension if not exists pgcrypto;

create table if not exists public.couples (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  invite_code text not null unique,
  owner_nickname text,
  owner_pin text,
  created_at timestamptz not null default now()
);

alter table public.couples add column if not exists owner_nickname text;
alter table public.couples add column if not exists owner_pin text;

create table if not exists public.couple_members (
  couple_id uuid not null references public.couples(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner','member')),
  joined_at timestamptz not null default now(),
  primary key (couple_id, user_id)
);

create table if not exists public.cycle_data (
  couple_id uuid primary key references public.couples(id) on delete cascade,
  records jsonb not null default '[]'::jsonb,
  settings jsonb not null default '{}'::jsonb,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_cycle_data_touch on public.cycle_data;
create trigger trg_cycle_data_touch
before update on public.cycle_data
for each row execute procedure public.touch_updated_at();

alter table public.couples enable row level security;
alter table public.couple_members enable row level security;
alter table public.cycle_data enable row level security;

-- A user can view couples they belong to.
drop policy if exists "couples_select_member" on public.couples;
create policy "couples_select_member"
on public.couples
for select
to authenticated
using (
  exists (
    select 1
    from public.couple_members cm
    where cm.couple_id = couples.id
      and cm.user_id = auth.uid()
  )
);

-- A logged-in user can look up a couple by invite code for join flow.
drop policy if exists "couples_select_by_invite" on public.couples;
create policy "couples_select_by_invite"
on public.couples
for select
to authenticated
using (true);

-- A user can create a couple only as owner of that row.
drop policy if exists "couples_insert_owner" on public.couples;
create policy "couples_insert_owner"
on public.couples
for insert
to authenticated
with check (owner_user_id = auth.uid());

-- Only couple owner can update couple metadata.
drop policy if exists "couples_update_owner" on public.couples;
create policy "couples_update_owner"
on public.couples
for update
to authenticated
using (owner_user_id = auth.uid())
with check (owner_user_id = auth.uid());

-- Members can see membership rows inside their own couple.
drop policy if exists "members_select_same_couple" on public.couple_members;
drop policy if exists "members_select_self" on public.couple_members;
create policy "members_select_self"
on public.couple_members
for select
to authenticated
using (user_id = auth.uid());

-- A user can insert only themselves as a member.
drop policy if exists "members_insert_self" on public.couple_members;
create policy "members_insert_self"
on public.couple_members
for insert
to authenticated
with check (user_id = auth.uid());

-- Members can read/write shared cycle data for their couple.
drop policy if exists "cycle_data_select_member" on public.cycle_data;
create policy "cycle_data_select_member"
on public.cycle_data
for select
to authenticated
using (
  exists (
    select 1
    from public.couple_members cm
    where cm.couple_id = cycle_data.couple_id
      and cm.user_id = auth.uid()
  )
);

drop policy if exists "cycle_data_insert_member" on public.cycle_data;
create policy "cycle_data_insert_member"
on public.cycle_data
for insert
to authenticated
with check (
  exists (
    select 1
    from public.couple_members cm
    where cm.couple_id = cycle_data.couple_id
      and cm.user_id = auth.uid()
  )
);

drop policy if exists "cycle_data_update_member" on public.cycle_data;
create policy "cycle_data_update_member"
on public.cycle_data
for update
to authenticated
using (
  exists (
    select 1
    from public.couple_members cm
    where cm.couple_id = cycle_data.couple_id
      and cm.user_id = auth.uid()
  )
)
with check (
  exists (
    select 1
    from public.couple_members cm
    where cm.couple_id = cycle_data.couple_id
      and cm.user_id = auth.uid()
  )
);
