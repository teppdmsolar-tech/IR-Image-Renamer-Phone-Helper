-- Run this in your Supabase project's SQL editor (Database -> SQL Editor -> New query)
-- This creates the tables the app needs and opens them up for use with the anon key.
-- Since this is a personal/small-team tool with no login system yet, RLS policies
-- here allow full read/write with the anon key. Tighten these later if you add auth.

create table if not exists sites (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists routes (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references sites(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  unique (site_id, name)
);

create table if not exists assets (
  id uuid primary key default gen_random_uuid(),
  route_id uuid not null references routes(id) on delete cascade,
  name text not null,
  position integer not null
);

create table if not exists route_runs (
  id uuid primary key default gen_random_uuid(),
  route_id uuid references routes(id) on delete set null,
  site_name text not null,
  route_name text not null,
  run_date date not null,
  data jsonb not null,
  created_at timestamptz not null default now()
);

alter table sites enable row level security;
alter table routes enable row level security;
alter table assets enable row level security;
alter table route_runs enable row level security;

create policy "allow all on sites" on sites for all using (true) with check (true);
create policy "allow all on routes" on routes for all using (true) with check (true);
create policy "allow all on assets" on assets for all using (true) with check (true);
create policy "allow all on route_runs" on route_runs for all using (true) with check (true);
