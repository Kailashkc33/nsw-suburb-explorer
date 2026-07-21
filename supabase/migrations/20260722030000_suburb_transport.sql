-- TfNSW GTFS transport enrichment tables (additive)
-- Dry-run by default. Apply manually after reviewing match totals.
-- Do not modify public.suburbs or public.suburb_profiles.

create table if not exists public.transport_stops (
  stop_id text primary key,
  stop_name text not null,
  stop_lat double precision,
  stop_lon double precision,
  location_type text,
  is_major boolean not null default false,
  modes text[] not null default '{}',
  route_count integer not null default 0,
  wheelchair_boarding boolean not null default false,
  platform_count integer not null default 1,
  source text not null default 'TfNSW GTFS',
  updated_at timestamptz not null default now()
);

create table if not exists public.transport_routes (
  route_id text primary key,
  agency_id text,
  route_short_name text,
  route_long_name text,
  route_desc text,
  route_type integer,
  mode text not null,
  source text not null default 'TfNSW GTFS',
  updated_at timestamptz not null default now()
);

create table if not exists public.suburb_transport_stops (
  suburb_id bigint not null references public.suburbs(id) on delete cascade,
  stop_id text not null references public.transport_stops(stop_id) on delete cascade,
  distance_m integer,
  rank integer not null default 0,
  source text not null default 'TfNSW GTFS',
  updated_at timestamptz not null default now(),
  primary key (suburb_id, stop_id)
);

create table if not exists public.suburb_transport_summary (
  suburb_id bigint primary key references public.suburbs(id) on delete cascade,
  nearest_stop_name text,
  nearest_stop_distance_m integer,
  nearest_major_stop_name text,
  nearest_major_stop_modes text[] not null default '{}',
  nearest_major_stop_distance_m integer,
  stops_within_500m integer not null default 0,
  stops_within_1km integer not null default 0,
  stops_within_2km integer not null default 0,
  stops_in_suburb integer not null default 0,
  modes text[] not null default '{}',
  route_count integer not null default 0,
  accessible_stop_count integer not null default 0,
  match_quality text,
  attribution text not null default 'Transport for NSW',
  source text not null default 'TfNSW GTFS',
  updated_at timestamptz not null default now()
);

create index if not exists transport_stops_major_idx on public.transport_stops (is_major);
create index if not exists transport_stops_modes_idx on public.transport_stops using gin (modes);
create index if not exists transport_routes_mode_idx on public.transport_routes (mode);
create index if not exists suburb_transport_stops_suburb_rank_idx
  on public.suburb_transport_stops (suburb_id, rank);
create index if not exists suburb_transport_summary_modes_idx
  on public.suburb_transport_summary using gin (modes);

alter table public.transport_stops enable row level security;
alter table public.transport_routes enable row level security;
alter table public.suburb_transport_stops enable row level security;
alter table public.suburb_transport_summary enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='transport_stops' and policyname='transport_stops_select_all') then
    create policy transport_stops_select_all on public.transport_stops for select to anon, authenticated using (true);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='transport_routes' and policyname='transport_routes_select_all') then
    create policy transport_routes_select_all on public.transport_routes for select to anon, authenticated using (true);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='suburb_transport_stops' and policyname='suburb_transport_stops_select_all') then
    create policy suburb_transport_stops_select_all on public.suburb_transport_stops for select to anon, authenticated using (true);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='suburb_transport_summary' and policyname='suburb_transport_summary_select_all') then
    create policy suburb_transport_summary_select_all on public.suburb_transport_summary for select to anon, authenticated using (true);
  end if;
end $$;

comment on table public.suburb_transport_summary is
  'Compact TfNSW GTFS-derived transport summary per suburb. Not a live timetable.';
