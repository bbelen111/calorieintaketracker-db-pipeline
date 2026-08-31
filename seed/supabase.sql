-- ═══════════════════════════════════════════════════════════════════════════
-- Energy Map — food catalog `foods` table (Supabase seed target)
-- ═══════════════════════════════════════════════════════════════════════════
-- Idempotent DDL mirroring the pipeline's SQLite `foods` schema 1:1 so
-- `node seed/supabase.js --db <catalog>` can upsert rows verbatim.
--
-- Column semantics inherited from the catalog (do not drift):
--   * sodium is in MILLIGRAMS.
--   * fiber / saturated_fats / sugars are in grams.
--   * micro fields are NULL-semantic: null = untracked, 0 = measured zero.
--   * `portions` is JSON text [{id,label,grams}], the "100g" entry always first.
--   * `id` prefix encodes provenance: usda_<fdcId> | curated_<key> | <regional>_<key>.
--
-- Apply via the Supabase dashboard SQL editor (or any role with ownership);
-- the script is safe to re-run. Writes are service-role only (RLS + grants),
-- reads are public.
--
-- Applied to the EnergyMap project (ajxgbbgawwqsvabbdapn) as migrations
-- `create_foods_table` + `foods_security_hygiene`.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.foods (
  id            text primary key,
  name          text not null,
  category      text,
  subcategory   text,
  calories      double precision,
  protein       double precision,
  carbs         double precision,
  fats          double precision,
  fiber         double precision,
  sodium        double precision,
  saturated_fats double precision,
  sugars        double precision,
  portions      text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table public.foods is
  'Curated USDA FDC food catalog, synced idempotently from calorieintaketracker-db-pipeline via seed/supabase.js (ON CONFLICT (id)).';

comment on column public.foods.sodium is 'Milligrams per 100g; null = untracked (never 0-for-missing).';
comment on column public.foods.fiber is 'Grams per 100g; null = untracked.';
comment on column public.foods.saturated_fats is 'Grams per 100g; null = untracked.';
comment on column public.foods.sugars is 'Grams per 100g; null = untracked.';
comment on column public.foods.portions is 'JSON text [{id,label,grams}]; the 100g entry is always first.';

create index if not exists foods_category_idx    on public.foods (category);
create index if not exists foods_subcategory_idx on public.foods (subcategory);
create index if not exists foods_name_lower_idx  on public.foods (lower(name));

-- Name-search index (trigram) for the future cloud query layer. Installed in
-- the `extensions` schema per Supabase hygiene (never public). Tolerant: if
-- pg_trgm cannot be created here, the migration still completes.
do $$
begin
  create extension if not exists pg_trgm with schema extensions;
  grant usage on schema extensions to anon, authenticated, service_role;
  create index if not exists foods_trgm_name_idx
    on public.foods using gin (name gin_trgm_ops);
exception when others then
  raise notice 'pg_trgm unavailable; skipping trigram name index: %', sqlerrm;
end $$;

-- updated_at maintenance (search_path pinned for hygiene).
create or replace function public.set_updated_at()
returns trigger language plpgsql set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists foods_set_updated_at on public.foods;
create trigger foods_set_updated_at
  before update on public.foods
  for each row execute function public.set_updated_at();

-- Security: public read catalog, service-role-only writes.
alter table public.foods enable row level security;

drop policy if exists "foods public read" on public.foods;
create policy "foods public read"
  on public.foods for select
  using (true);

revoke all on table public.foods from anon, authenticated;
grant select on table public.foods to anon, authenticated;
grant all on table public.foods to service_role;