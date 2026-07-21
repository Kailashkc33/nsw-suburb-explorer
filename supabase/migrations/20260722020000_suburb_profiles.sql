-- ABS 2021 Census suburb profiles (SAL geography)
-- Review and apply manually. Do not run until match-quality totals are accepted.

create table if not exists public.suburb_profiles (
  id bigint generated always as identity primary key,
  sal_code text not null,
  census_year integer not null default 2021,
  suburb_name text not null,
  suburb_name_normalized text not null,
  population integer,
  median_age numeric(6,1),
  median_weekly_household_income numeric(12,2),
  average_household_size numeric(6,2),
  occupied_private_dwellings integer,
  owned_outright integer,
  owned_with_mortgage integer,
  rented_dwellings integer,
  median_weekly_rent numeric(12,2),
  median_monthly_mortgage numeric(12,2),
  source text not null default 'ABS 2021 Census GCP',
  updated_at timestamptz not null default now(),
  constraint suburb_profiles_sal_code_key unique (sal_code),
  constraint suburb_profiles_census_year_check check (census_year >= 2001)
);

create index if not exists suburb_profiles_name_normalized_idx
  on public.suburb_profiles (suburb_name_normalized);

create index if not exists suburb_profiles_census_year_idx
  on public.suburb_profiles (census_year);

create index if not exists suburb_profiles_suburb_name_idx
  on public.suburb_profiles (suburb_name);

alter table public.suburb_profiles enable row level security;

-- Public read access for the explorer API / anon key.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'suburb_profiles'
      and policyname = 'suburb_profiles_select_all'
  ) then
    create policy suburb_profiles_select_all
      on public.suburb_profiles
      for select
      to anon, authenticated
      using (true);
  end if;
end $$;

comment on table public.suburb_profiles is
  'ABS 2021 General Community Profile metrics for NSW Suburbs and Localities (SAL). Rent and mortgage figures are Census medians, not live market prices.';
