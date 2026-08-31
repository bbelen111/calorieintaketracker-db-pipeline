# Cloud Read Path — Plan (Phase B)

**Status: PLAN ONLY.** Nothing in this document is implemented in the consumer
app (`calorieintaketracker`) yet. It is the agreed design for wiring the cloud
catalog into the app after the base is seeded. Keep this doc in sync with any
decisions that change these constraints.

## Context & goals

- Today the app is **local-first**: bundled `foodDatabase.sqlite` (SQLite /
  sql.js) powers offline food search; `cachedFoods` dedups online lookups.
- Phase A (done): pipeline repo owns the catalog; `public.foods` exists in the
  EnergyMap Supabase project with RLS (anon read, service-role write), 5
  indexes (incl. `foods_trgm_name_idx` for `ILIKE`), 0 rows awaiting seed.
- Phase B: a **read-only cloud query layer** the app can consult — same user
  experience and data contract as the local catalog, without bundling updates.

## Non-negotiable data contract (mirror exactly)

| Field | Semantics |
| --- | --- |
| `id` | `usda_<fdcId>` / `curated_<key>` / `<regional>_<key>` → provenance prefix |
| `sodium` | **mg** per 100g (PostgREST float8) |
| `fiber`/`saturated_fats`/`sugars` | grams per 100g |
| micros | NULL = untracked, 0 = measured zero — never 0-for-missing |
| `portions` | JSON text; `100g` entry always first |
| `name` | display strings already normalized (friendly-name pass) |

Proxy shorthand for originals: `fdcId` `curatedKey`; legacy existing sources
(`local`, `cached`, `off`/`usda` online, `ai`) live in the app's `foodTags`
logic and MUST keep resolving after the cloud path lands (cloud rows carry
`usda_`/`curated_` prefixes so they map to existing tag machinery).

## Query surface (cloud-only, GET semantics)

1. **Name search** — `ILIKE '%term%'` via `foods_trgm_name_idx`
   (`order by name` keeps relevance deterministic; prefix/exact still win with
   a `starts_with` case arm).
2. **Browse/filter** — `category` + optional `subcategory`, ordered by `name`.
3. **By id batch** — `in (id…)` for favourite/pinned hydration (mirrors
   `getFoodsByIds`).
4. Pagination: page size 50, `limit`/`offset` (matches local progressive
   batching idiom: 120 local / 80 online currently).
5. Response shape = the app's row shape (`id,name,category,subcategory,
   calories,protein,carbs,fats,fiber,sodium,saturated_fats,sugars,portions`),
   so `foodSearch.js` result builders and `resolveAiFoodEntry` accept cloud rows
   without new mapping code.

## Where it plugs in (design notes, not code)

- A `services/foodSearchCloud.js` client mirroring `services/usda.js`:
  timeout + abort, native base-URL env guard, fetch → rows.
- `services/foodSearch.js` gains a resolver order: **local sql.js first
  (offline), cloud as a richer/updated fallback**, keeping `cachedFoods`
  semantics intact (cloud rows are cacheable like USDA rows).
- `FoodSearchModal` stays the same surface — mode could add "cloud" only if the
  UX genuinely needs it; default is transparent merge (least-diff).
- `foodPresentation.js` + `foodTags.js` unchanged in shape; extend tag
  resolution for any future regional prefixes (`philfct_`, `asean_`,
  `offph_`) via the canonical registry — never per-modal ad-hoc tags.
- Telemetry/observability: reuse the RAG lookup-context reason-code style for
  cloud-unreachable/empty diagnostics (`foodLookupReasons` pattern), not new
  bespoke strings.

## Security & governance

- App talks to PostgREST with the **anon key** (read-only is granted; RLS
  guarantees SELECT-only). The service-role key never leaves the pipeline/CI.
- No writes from the app. Upserts/backfills only via `seed/supabase.js` /
  pipeline (idempotent `ON CONFLICT (id)`), preserving local-first truth.
- Offline behavior must not regress: bundled SQLite remains the fallback when
  the cloud is unreachable; the app's `useNetworkStatus` already signals this.

## Sync & freshness model

- Base seed = Phase A artifact (9,644 rows, id-identical to the shipped DB).
- Refresh cadence: re-run `seed/supabase.js` after each pipeline `--replace` +
  `taxo:check --db` green; diff by `updated_at` to detect drift.
- Regional datasets later (PhilFCT / ASEAN FCD / OFF PH) stream through the
  same schema, new `id` prefixes, and the same RLS/read grants — plan for it in
  tag + query-layer testing now (no implementation).

## Milestones

1. **M1 — Seed & smoke:** run `seed/supabase.js`, verify anon `count(*)` and a
   trigram search round-trip from the dashboard. (Ready; needs creds/env.)
2. **M2 — Read client:** `foodSearchCloud.js` + resolver-order merge in the app,
   feature-flagged.
3. **M3 — Regional sources** + source/provider tagging + search-ranking parity
   with local.
4. **M4 — Sync automation** (pipeline CI: rebuild → taxo-check → seed) once a
   CI pipeline exists.

Acceptance for M2: with cloud seeded + flagged on, a search for `"chicken
breast"` returns the same top rows as local sql.js, honors `pinnedFoods`, and
falls back flawlessly to the bundled DB when offline/server error.